# 060 — wp6: 보안·플랫폼 파리티

work-phase: `wp6` · 선행: 없음(런타임 계열의 첫 단계) · 후속: 070

**보안 리뷰 경계 (MAINTAINERS.md).** 이 문서의 세 항목 모두 인증·자격증명·권한 상승에
닿는다. 구현 후 명시적 보안 리뷰가 필요하며, 이 유닛 혼자 "안전함"을 선언하지 않는다.

## 060.1 SSH 포워딩 루프백 신뢰

### 오라클

`isLoopbackRequestHost()`(`src/server/auth-cors.ts:37`)는 **호스트명만** 본다. 포트는 보지
않는다. Host가 없거나 파싱 불가면 `true`(fail-open). 허용 호스트명은 빈 값, `localhost`,
`127.0.0.1`, `::1`, `[::1]`이며 트림·소문자화·후행 점 1개 제거 후 비교한다
(`auth-cors.ts:129`).

결정적으로, 루프백 바인드에서 **Host 검사가 no-Origin 허용보다 먼저** 실행된다
(`auth-cors.ts:72`). 즉 Origin이 없어도 Host가 루프백이 아니면 거부된다.

### Go 현재

`IsLoopbackRequestHost(value, configuredPort)`(`go/internal/server/auth_cors.go:36`)가
호스트명 확인 후 **포트 일치까지 요구**한다. 따라서 설정 포트 10100에서 `localhost:20100`은
거부된다 — SSH 포워딩이 깨지는 지점이다.

더 심각한 두 번째 차이: `IsAllowedRequestOrigin()`(`auth_cors.go:189`)이 Origin이 비면
**Host를 검사하기 전에** `true`를 반환한다. 오라클은 그러지 않는다.

### 변경

1. `IsLoopbackRequestHost`에서 `configuredPort` 인자 제거, 파싱 성공 후
   `isLoopbackHostname(parsed.Hostname)`만 반환.
2. `IsAllowedRequestOrigin`에서 루프백 바인드 Host 게이트를 `origin == ""` 분기보다 **앞으로**
   이동.
3. 호출부 갱신: 프로덕션 `auth_cors.go:194`, 테스트 `auth_cors_test.go:19`. 이것이 전부다.

**의도적으로 유지하는 차이:** Go는 비어 있지 않은 잘못된 형식의 Host를 거부한다(오라클은
fail-open). Go HTTP 서버가 핸들러 이전에 잘못된 Host를 이미 거부하므로 이 엄격함은 안전
방향이며 유지한다. 이 결정은 문서에 남긴다.

### 수용 기준

| # | 시나리오 | 기대 |
| --- | --- | --- |
| 1 | 리스너 10100, Host `localhost:20100` | 허용 |
| 2 | 리스너 10100, Host `127.0.0.1:20100` | 허용 |
| 3 | 리스너 10100, Host `[::1]:20100` | 허용 |
| 4 | Host `attacker.test:10100` | 거부 |
| 5 | Origin 없음 + Host `attacker.test:20100` | **거부** (게이트 우회 없음 증명) |
| 6 | Hostname `127.0.0.1`, Host·Origin 모두 `localhost:20100` | 허용 |

활성화 시나리오: `ssh -L 20100:localhost:10100` 뒤 브라우저가 `localhost:20100`으로 접속.
현재 Go는 거부, 목표는 허용. 5번이 "느슨해진 것이 아니라 정확해진 것"을 증명한다.

## 060.2 `apiKeyTransport`

### 오라클

`apiKeyTransport?: "x-api-key" | "bearer"`(`src/types.ts:885`). 생략 시 Anthropic 기본값
`x-api-key`. 교차 검증(`src/config.ts:415`): `adapter === "anthropic"`에서만 허용하고
`authMode`가 `oauth`/`forward`/`local`이면 거부한다. 요청 구성(`src/adapters/anthropic.ts:686`):
`bearer`일 때만 `Authorization: Bearer <key>`, 그 외에는 `x-api-key`. OAuth 흐름은 별개로 유지.

### 변경

1. `go/internal/config/config.go:154` 부근 `ProviderConfig`에
   `APIKeyTransport string \`json:"apiKeyTransport,omitempty"\`` 추가.
2. `config.go:703` 프로바이더 검증 루프에 규칙 추가: 빈 값 허용, 비면 두 리터럴만 허용,
   어댑터는 `anthropic`, `authMode` `oauth`/`forward`/`local` 거부,
   `ConfigError{Field: "providers."+name+".apiKeyTransport"}`.
3. `go/internal/adapter/anthropic/anthropic.go:105` 비-OAuth 분기에서 전송 방식 분기.
   OAuth 경로는 그대로.
4. `go/internal/config/schema_manifest_test.go:9` provider 매니페스트에 `apiKeyTransport` 추가.

매니페스트 주의: 이 테스트는 TS에서 목록을 유도하지 않고 수기 목록을 검사한다. 구조체
필드만 추가하면 테스트는 통과하지만 매니페스트는 낡은 채 남는다 — 반드시 함께 갱신한다.

### 수용 기준

| # | 설정 | 기대 헤더 |
| --- | --- | --- |
| 1 | 생략 | `x-api-key`만 |
| 2 | `x-api-key` 명시 | `x-api-key`만 |
| 3 | `bearer` | `Authorization: Bearer`만, `x-api-key` **부재** |
| 4 | OAuth | 기존 bearer + `anthropic-beta` 유지 |
| 5 | `adapter: openai` + `bearer` | 설정 검증 실패 |
| 6 | `authMode: oauth` + `bearer` | 설정 검증 실패 |

3번은 **두 자격증명 헤더가 동시에 나가지 않음**을 반드시 단언한다.

## 060.3 Windows ACL 순서

### 오라클

순서는 `/grant:r owner:(F)` → `/inheritance:r` → `/remove:g` 광역 SID
(`src/lib/windows-secret-acl.ts:178`). 이유: `/inheritance:r`는 상속 ACE를 즉시 제거한다.
그것이 먼저 실행되고 이후 단계가 타임아웃하면, 사용자가 **소유는 하지만 읽지도 삭제하지도
못하는** 0-ACE DACL이 남는다. 파일은 `user:(F)`, 디렉터리는 `user:(OI)(CI)(F)`.

### Go 현재

`go/internal/platform/winacl_common.go:140`의 순서가 상속 제거 → 광역 SID 제거 → 소유자
부여로 **뒤집혀 있다.** 기존 테스트(`winacl_common_test.go:13`)가 그 잘못된 순서를 고정하고
있으므로 테스트도 함께 바로잡는다.

`winacl.go`는 빌드 태그 선언일 뿐이고 실제 동작은 common 파일에 있다. 따라서 macOS에서도
`Platform:"windows"` + 주입 러너로 검증 가능하다.

### 변경 및 수용 기준

1. 소유자 부여를 파괴적 명령보다 먼저 실행.
2. 테스트가 정확한 순서를 단언:
   `/grant:r <user>:(F)` → `/inheritance:r` → `/remove:g *S-1-1-0 *S-1-5-11 *S-1-5-32-545`
3. 신규 테스트: 소유자 부여 성공 → 상속 제거 성공 → `/remove:g` 타임아웃.
   기대: `OK == false`, ETIMEDOUT 진단, **소유자 부여는 기록되어 있음**.
   이것이 "부분 실패해도 잠기지 않는다"는 활성화 증거다.

## UAC 승격은 이 단계에서 제외

오라클의 UAC 승격 프로토콜(단일 트랜잭션, 예약 코드 `0/10/11/12/13`, 취소 코드 `1223` 분리,
승격 프로세스 내 롤백, TEMP 파일 IPC 금지)은 Go에 **전혀 없다**. 이는 ACL 순서 수정보다
훨씬 큰 독립 유닛이며 `go/internal/service/install.go:98`의 설치 트랜잭션까지 바꾼다.

따라서 별도 work-phase로 분리해 `130`에서 다룬다(LOOP-UNIT-CHAIN-01에 따라 goalplan에
추가). 이 단계에서 절반만 손대면 승격 실패 시 상태가 더 나빠진다.

## 스코프 경계

IN: `auth_cors.go`, `config.go`, `adapter/anthropic/anthropic.go`, `winacl_common.go` 및 각
테스트. OUT: UAC 승격(`130`), `src/**`.
