# 003 — `src/**` 업스트림 델타 인벤토리

측정: 2026-07-28. 방법: 독립 read-only 탐색 에이전트 1대 + 주 에이전트 기준선 재확인.

## 기준선 선택

- R8은 `b4485706`에서 측정(`260726_260726-go-port-r8/095_reachability_dashboard.md:3`).
- R10은 `5078ffc3` → `9d1bb146` → `2d5d4916`로 세 번 재베이스.
- **최종 정본 검증은 `origin/dev@1eb7269f`를 명시**하고 그것이 검증된 Go head의 조상임을
  확인했다(`260726_260726-go-port-r10/009_4_post_audit_canonical_validation.md:4`).

따라서 기준선은 `1eb7269f447c913c31e5609dda503da8b623d7ac`. 현재 `origin/dev`는 `7710185c0`.

- `git log --oneline 1eb7269f..origin/dev -- src/` → 113 커밋(비머지 101)
- `git diff --stat 1eb7269f..origin/dev -- src/` → 129 파일 `+18,687 / -991`

## 미반영 항목 (P0/P1 중심)

| 영역 | 업스트림 커밋 | TS 변경 | Go 상태 |
| --- | --- | --- | --- |
| 스토리지 안전성 | `e2a0eda4`, `40fdc3de`, `c573bd9d`, `6ae3bd52`, `1f634e7a`, `8ec1ca1c`, `888e434f` | 격리 정리, 원자적 위성 백업, 복원, 다이제스트 바인딩, 경쟁 안전 뮤테이션 조정 (`src/storage/cleanup.ts`) | **없음.** Go는 스캔 전용 `/api/storage`만 (`logs.go:298`) |
| 스토리지 정책 | `55e780a4`, `ee957406`, `521232df`, `eeeabc5c`, `5b3e5975` | 옵트인 예약 정리 정책, 워커 응답성, single-flight | **없음.** `storageCleanupPolicy` 및 `/api/storage/cleanup-policy*` 부재 |
| Codex 계정 풀 | `c380ef72`, `903b62c7` | `quota`/`round-robin`/`fill-first` 전략 + 동일 요청 내 429 페일오버 (`src/codex/pool-rotation.ts:17`) | 부분. Go는 고정 순차 선택(`oauth/accountpool.go:46`), 전략·sticky·동일요청 재시도 없음 |
| Anthropic 계정 풀 | `da212d3a`, `458c363a` | 옵트인 풀, 계정별 5시간 쿼터, 풀 API | **없음.** `/api/oauth/accounts/pool` 미등록 (`management/api.go:150`) |
| 루프백 신뢰 | `e2da6f6d` | 호스트명 기반 신뢰 — SSH 포워딩된 `localhost:20100` 허용 (`src/server/auth-cors.ts:37`) | **없음.** Go는 여전히 Host 포트 == 설정 포트 요구 (`server/auth_cors.go:36`) |
| Anthropic 키 전송 | `2a404c78` | `apiKeyTransport`로 `Authorization: Bearer` 허용 (`src/types.ts:887`) | **없음.** 스키마 매니페스트에 부재 |
| Windows ACL/UAC | `59bc0b7b`..`b711ddf4`, `d482086b` | UAC 승격 프로토콜 강화, 소유자 ACE 선부여 후 상속 제거 (`src/lib/windows-secret-acl.ts:147`) | **없음.** `platform/winacl.go`는 빌드 선언만 |
| SSE 페이로드 재작성 | `406a522f` | 단일 패스·프레이밍 보존 재작성 (`src/server/sse-payload-rewrite.ts`) | **없음.** Go는 디코딩만 (`protocol/sse.go:22`) |
| 이미지 브리지 | `285e2bf6`, `de35caa4`, `65e3fee1`, `14ae6fe9` | `image_generation` 네임스페이스 복원, Grok 이미지 에이전트 루프, 아티팩트/SSRF 통제, Gemini 인라인 출력 | 부분. Go는 기본 `/v1/images/*` 사이드카만 (`server.go:390`) |
| 시스템 재시작 | `94a83bc0`, `e5455123` | `POST /api/system/restart` — 드레인 후 안전 재기동, 스폰 실패 시 fail-closed | **없음.** Go `handleSystem`은 GET 전용 (`management/system.go:12`) |
| 프로바이더 레지스트리 | `cf0a3230` | `zhipu-bigmodel` + GLM 메타데이터 + thinking 토글 | **없음.** Go 레지스트리에 항목 없음 |
| 네이티브 서브에이전트 | `053ad660` | `syncCodexSubagentDefaults` 동기화·검증 (`src/types.ts:528`) | **없음.** Go config 필드·매니페스트 부재 |
| Kiro | `f92e1073` 외 6건 | 브라우저 다계정 로그인 + 재시도/완료/스로틀 회복 | 부분. SQLite 자격증명 임포트는 있으나 다계정 계약 없음 |
| Claude Desktop | `48b985d0`, `7c74e0a2`, `e7d144fc` | 타깃 플랫폼 3P 경로, 설정 복원, reasoning 요약 보존 | 부분. 타깃 플랫폼 경로 해석 미발견 |
| 로그/사용량 | `e7b103d1`, `a2394609`, `85aa0751`, `7fcaa911` | 대화 상관관계, 실효 reasoning effort, 요청 출력 한도 분류 | 부분. `conversationId`·실효 effort 필드 없음 |
| 업데이트 | `0be28c4b`, `5dbeef5b`, `7fb8e2f1`, `7710185c` | 중복 GUI 재시작 회피, 상관된 신원 요구, 낡은 잡 정리, 콤보 쿼터 폴백 | 부분. 정확한 낡은 잡/폴백 대응 미발견 |

### 감사 1라운드에서 추가된 누락 항목

아래 두 줄은 초기 인벤토리에서 빠져 있었다. `002`가 `account`와 `config`를 "Go에 있음"으로
표시한 탓에 이 표에서도 검토되지 않았다. 감사 블로커 B1·B2로 발견되어 추가한다.

| 영역 | TS 변경 | Go 상태 |
| --- | --- | --- |
| CLI 인증 표면 | `src/cli/account-auth.ts` — `login`/`reauth`, `code`, `cancel`, `reset-credits`, stdin 안전 코드 입력, 2초 간격 폴링, `--yes` 보호 | **없음.** Go `account` 사용법에 인증 서브명령 전무 (`go/internal/cli/account.go:18`) → `046` |
| CLI 설정 표면 | `src/cli/config-command.ts` — 임의 점 경로, `--source`, 파일/stdin 검증, `export`, `import --yes`, 비밀 마스킹, 프로토타입 오염 차단 | 부분. Go는 고정 키 몇 개만, `export`/`import` 없음 (`go/internal/cli/config_command.go:13`) → `045` |

**교훈:** "Go 레지스트리에 명령 이름이 있다"를 파리티 증거로 쓰면 안 된다. 서브명령·플래그
수준까지 대조해야 한다.

### 이미 반영된 것 (재작업 금지)

- Kimi `prompt_cache_key` 전달 (`0338b788`) — Go `config.go:199`, `adapter/openai/chat.go:200`
- 브리지 하트비트·incomplete 변환 (`800ebc93` 외) — `bridge/bridge.go:330`
- retry-after 살균 (`6b772cac` 외) — `server/responses_core_port.go:1020`

## Go 대응이 없는 신규 TS 회귀 테스트

기능과 함께 이식해야 하며 선택 사항이 아니다.

- `tests/account-pool-management-api.test.ts`, `tests/anthropic-account-pool.test.ts`
- `tests/images/**` (특히 `loop.test.ts`의 경계 있는 에이전트 루프)
- 스토리지 정리/정책/복원/뮤테이션 경쟁 테스트군
- `tests/sse-payload-rewrite.test.ts`
- `tests/system-restart.test.ts`
- `tests/zhipu-bigmodel-provider.test.ts`, Windows 승격/ACL 테스트, 네이티브 서브에이전트 기본값 테스트

## 슬라이스 내부 순서

**감사 2라운드 정정:** 아래 목록은 처음에 전역 실행 순서처럼 읽혔으나, 이들 런타임 계열
슬라이스는 **서로 독립**이다. 전역 순서 정본은 `006_dependency_dag.md`다.
아래는 각 슬라이스 **내부**의 실제 구축 순서다.

| 슬라이스 | 내부 순서 |
| --- | --- |
| 보안/플랫폼 (`060`) | 세 항목 독립, 다만 UAC(`130`)는 ACL 정리 이후 |
| 계정 풀 (`070`) | 스키마 → 전략 엔진 → 쿼터 캐시 → 관리 라우트 → 요청 내 재시도 |
| 스토리지 (`080`) | 프리뷰 → 정리 트랜잭션 → 복원 → 정책 워커 |
| SSE/이미지 (`090`) | 재작성 릴레이 → 네임스페이스/루프/아티팩트 |
| 관리·레지스트리 (`100`) | 세 항목 독립 |
| 관측성 (`110.A`) | 로그 필드 → 기록 배선 → DTO → 필터 |
