# 070 — wp7: OAuth 계정 풀 계약

work-phase: `wp7` · 선행: `060` · 후속: 080

**보안 리뷰 경계.** 자격증명을 선택·갱신·저장·전송한다. 계정 프로브 엔드포인트 고정,
토큰 취급, 관리 응답의 자격증명 비노출, 로그의 계정 ID 마스킹이 리뷰 대상이다.

## 오라클 계약

전략 값은 정확히 `quota | round-robin | fill-first`이고 정규화 기본값은 `quota` / sticky `1`
(`src/codex/pool-rotation.ts:14`). 관리 API 입력은 엄격하다: 세 리터럴만, sticky는 정수
`1..100`.

**중요한 이중성:** 원본 config를 손으로 잘못 편집한 경우는 **정규화**(폴백)로 처리하고,
관리 API 쓰기는 **거부**한다. Go의 일반 `Config.Validate`를 오라클보다 엄격하게 만들면 안
된다 — 엄격 검증은 관리 쓰기 경로에만 둔다.

### 자격 판정

재인증 대기, 쿨다운, 사용 불가 계정을 제외한다. Codex는 추가로 soft-avoid 계정을 제외하고
라이브 메인 계정을 먼저 넣는다(`src/codex/routing.ts:475`). 따라서 quota 동점과 초기 RR
동점은 이 입력 순서를 따른다 — 정렬이 아니라 입력 순서다.

### 전략별 알고리즘

**quota** (`routing.ts:629`): 활성 계정이 사용 가능하고 `autoSwitchThreshold`(기본 80) 미만이면
유지. 아니면 알려진 사용률이 **엄격히 최소**인 계정 선택. 사용률 동률이면 첫 자격 계정 유지.
사용률 미상은 `100`으로 채점되며 그것만으로 전환을 강제하지 않는다. Codex는 `go`/`free`
플랜에서 월간 퍼센트, 그 외에는 `max(주간, 월간)`을 쓴다(`routing.ts:711`).

**round-robin** (`pool-rotation.ts:61`): 단위 가중치 smooth weighted RR. 각 자격 ID의 러닝
가중치를 1씩 올리고 첫 최대값을 선택한 뒤 그 가중치에서 자격 계정 수를 뺀다. 가중치가
같으면 안정적 순환 순서가 된다.

**RR sticky** (`pool-rotation.ts:87`): 풀 전역 `activeKey`가 아직 자격이 있으면 링을 진행하기
전에 그것을 반환한다. 선택된 계정은 정확히 `stickyLimit`회의 **성공한 새 세션 선택** 동안
유지되고 N번째 성공에서 해제된다. 실패는 sticky 키와 카운터를 즉시 지운다. 세션/스레드
어피니티는 RR sticky보다 강하며 별개 개념이다.

**fill-first** (`routing.ts:504`): 활성 계정의 알려진 사용률이 임계 미만이면 유지하고, 사용률
미상도 유지한다. 유지할 수 없으면 이전 계정 다음부터 **안정적 사전순 계정 ID**를 순회하며
감싼다. 임계 미만 후속자가 있으면 고갈된 후속자를 건너뛰고, 없으면 첫 자격 후속자를 쓴다.
이것은 최소 사용률 페일오버가 **아니다**.

### 어피니티

Codex 스레드 어피니티는 프로세스 로컬, LRU 2048, 24시간 유휴 만료(`routing.ts:104`).
RR/fill-first에서는 진행 중 스레드가 계속 붙어 있고, quota 전략만 기존 어피니티를 임계
전환 대상으로 재평가한다.

Anthropic은 **옵트인 전용**이며 캐시된 계정별 `fiveHourPercent`를 쓴다. 세션 어피니티는
24시간 유휴 / 최대 2,000개(`src/oauth/anthropic-routing.ts:123`).

## 설정 스키마

| TS 필드 | Go 표현 | 기본 / 관리 API 검증 |
| --- | --- | --- |
| `accountPoolStrategy` | `string` | 정규화 `quota`; API는 3리터럴만 |
| `accountPoolStickyLimit` | `*int` | 정규화 `1`; API는 정수 `1..100` |
| `anthropicAccountPool.enabled` | `*bool` | 기본 off |
| `anthropicAccountPool.autoSwitchThreshold` | `*int` | 기본 `80`; API `0..100`; `0`은 quota 전환 비활성화 |
| `anthropicAccountPool.strategy` | `string` | 정규화 `quota` |
| `anthropicAccountPool.stickyLimit` | `*int` | 정규화 `1`; API `1..100` |

포인터 타입인 이유: **부재와 명시적 0을 구분**해야 한다. 임계 `0`은 유효한 값(전환 끄기)이며
미설정과 다르다.

## 구현 순서 (의존성)

### 1. 설정 스키마·정규화

`config.go`에 필드 + `AnthropicAccountPoolConfig` + 순수 헬퍼
(`NormalizedAccountPoolStrategy`, `NormalizedAccountPoolStickyLimit`, `NormalizedAnthropicPool`).
`schema_manifest_test.go:9` 최상위 매니페스트에 세 키 추가.

수용: 생략값이 `quota`/`1`/비활성/`80`으로 정규화; 명시적 임계 `0`이 왕복 후에도 살아남고
전환을 끔; 잘못된 원시값은 읽기 시점에 정규화(거부 아님).

### 2. 전략 엔진

`accountpool.go:68`의 `next int` 순차 선택을 교체: 풀별 `activeKey`, 성공 sticky 카운트,
ID별 smooth-RR 가중치, 명시적 전략 입력, 매 선택 전 자격 필터링, 어피니티 우선 + 24시간
만료 + LRU, `RecordOutcome(429)`가 어피니티·sticky 해제, 수동 선택이 RR 활성 키를 시드.

**필수 스코프 확장:** `authcontext.go:17`의 리졸버가 단일 풀만 소유하고 프로바이더 불일치를
거부하므로, 프로바이더→풀 레지스트리가 필요하다. `serve.go:309`도 현재 `openai` 풀만
만든다. 이 두 파일 없이는 실행 가능한 구현이 불가능하다.

### 3. Anthropic 5시간 쿼터

`go/internal/oauth/anthropic_quota.go` 신규: 계정 ID 키 캐시, 10분 TTL, 계정별 in-flight
중복 제거, `{fiveHourPercent, fiveHourResetAt, updatedAt, unavailable}`.
`https://api.anthropic.com/api/oauth/usage`에 계정 자신의 bearer로 프로브하고
`five_hour.utilization`·`five_hour.resets_at`를 `0..100`으로 정규화. 실패 시 마지막 정상값
유지 + unavailable 표시.

**선택 경로는 절대 HTTP를 호출하지 않는다** — 캐시를 동기적으로 읽기만 한다.

`registry.QuotaFetcher`를 재사용하지 말 것: 프로바이더 단위 키라서 계정 하나만 대표할 수 있다
(`go/internal/registry/quota.go:48`).

### 4. 관리 라우트

`management/api.go:150`에 `GET/PUT/PATCH /api/oauth/accounts/pool` 등록.
`provider=anthropic`만 허용. GET은 `provider/enabled/autoSwitchThreshold/strategy/stickyLimit/
experimental:true`. PUT/PATCH는 객체 필수이며 **모든 필드를 검증한 뒤에야** 상태를 변경한다
(부분 변경 금지). 생략 필드는 저장값 보존.

### 5. 동일 요청 내 429 페일오버

`responses_core_port.go:435` `forward` 안, 비-2xx 응답 수신 직후·스트리밍 이전에 삽입.
현재 루프는 API 키만 회전하고 OAuth 429는 기록만 한 뒤 반환한다.

절차: 옵트인 + Anthropic일 때만 → 실패 계정을 `Retry-After`(숫자/날짜, 최대 15분, 없으면
60초)로 쿨다운 → 어피니티·sticky 해제 → 전략 기반 대체 선택 → 대체 자격증명 검증/갱신 후
승격 → 같은 세션 키를 재바인딩.

**상한: 원 요청당 계정 페일오버 3회**(`ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST`).

**이미 클라이언트로 보낸 바이트는 절대 재생하지 않는다.** 이 재시도는
`FetchWithHeaderTimeout`이 비-2xx를 반환한 뒤, `stream()`/`buffered()`가 소비하기 전에만
일어난다. 매 재시도는 동일 정규화 요청과 원본 전달 헤더로 어댑터 요청을 재구성하되,
OAuth 인증·프로바이더 인증 헤더·어댑터/전송·시도 메타데이터만 교체한다.

## 수용 기준 (활성화 시나리오 포함)

| # | 시나리오 | 증거 |
| --- | --- | --- |
| 1 | quota: 활성 임계 미만 | 유지, 전환 없음 |
| 2 | quota: 활성 임계 초과 | 최소 사용률 계정 선택 |
| 3 | quota: 사용률 미상 활성 | 유지 (미상만으로 전환 안 함) |
| 4 | RR: 서로 다른 3세션 | 세 계정이 각각 선택됨 |
| 5 | RR sticky 3 | 동일 계정 3회 후 이동 |
| 6 | RR 실패 | sticky 즉시 해제 |
| 7 | fill-first: 고갈된 후속자 | 건너뛰고 임계 미만 후속자 선택 |
| 8 | 어피니티 vs 전략 | 24시간 내 어피니티 우선 |
| 9 | 429 → 대체 성공 | 업스트림 2회 호출, 서로 다른 계정, 클라이언트 응답 1회, 실패 계정 쿨다운 |
| 10 | 모든 계정 쿨다운 | 클라이언트 429 1회 + 가장 이른 Retry-After |
| 11 | 스트리밍 대체 | A의 바이트가 전혀 나타나지 않고 B 스트림만 도달 |
| 12 | 관리 API 혼합 유효/무효 본문 | 이전 값 전부 불변 (원자성) |

11번은 기록형 writer로 모든 바이트를 남겨 재생 여부를 검출한다.

## 스코프 경계

IN: `config.go`, `accountpool.go`, `authcontext.go`, `anthropic_quota.go`, `serve.go`,
`management/api.go`, `management/oauth.go`, `oauth_management.go` 및 테스트.
OUT: Codex 풀의 기존 동작 변경(오라클과 이미 일치하는 부분), `src/**`.
