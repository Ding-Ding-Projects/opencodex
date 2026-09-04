# 010 — wp1: CLI 전송 기반 + 루트 도움말 파리티 + 별칭

work-phase: `wp1` · 선행: 없음 · 후속: 020, 030, 040, 045, 046, 050이 이 문서의 산출물에 의존 · 순서 정본: `006`

## 왜 이것이 첫 구현 단계인가

누락된 명령 8종 중 7종이 관리 API를 호출하는 얇은 래퍼다. 각 명령이 자기만의 HTTP 호출·
플래그 파싱·JSON 출력을 재구현하면 뒤따르는 모든 슬라이스가 같은 실수를 반복한다.
따라서 전송·파싱·출력 원시요소를 먼저 세운다. 이것은 난이도가 아니라 의존성 순서다.

## 오라클

`src/cli/runtime-api.ts`가 공용 클라이언트다. 핵심 표면:

| 심볼 | 계약 |
| --- | --- |
| `runtimeBaseUrl` | `deps.baseUrl` 우선, 없으면 `findLiveProxy()`; 미실행 시 503 `"Proxy is not running. Start it with: ocx start"` |
| `runtimeRequest<T>` | 헤더 병합 → fetch → 텍스트 읽기 → JSON 파싱 시도(실패 시 원문 유지) → `!ok`면 `RuntimeApiError` |
| `responseMessage` | 본문에서 `error`/`message`/`detail` 순으로 문자열 추출, 없으면 원문 400자, 최종 폴백 `Management request failed (<status>)` |
| `CliUsageError` | 사용법 텍스트를 동반하는 오류 |
| `takeFlag`/`takeOption`/`takeBooleanOption`/`takeIntegerOption`/`csv` | 인자 목록에서 제거하며 읽는 파서 |
| `rejectArgs` | 남은 인자가 있으면 사용법 오류 |
| `redactSecretArgs` | `--code` 계열 값 마스킹 |
| `printData` | `--json`이면 원본 JSON, 아니면 사람용 줄 목록 |

### 자격증명 마스킹은 선택이 아니다

`SECRET_OPTIONS = ["--code"]`. `--code=<url with code>`, `--code <secret>`,
`--code -- <secret>`, `--code --SECRET` 네 형태 모두 마스킹된다. Go 포트가 이 규칙을
빠뜨리면 파싱 오류 경로에서 인가 코드가 stderr로 새어 나간다. 이는 privacy 게이트
위반이며 회귀 테스트로 고정해야 한다.

## Go 현재 상태

- 레지스트리: `go/internal/cli/cli.go:47` `commandSpecs []commandSpec`,
  `Run()`이 `commandIndex` 조회 후 미등록이면 `Unknown command: <name>` + `PrintHelp`.
- 관리 API 호출: 현재 CLI는 인프로세스 백엔드(`codex_auth_management.go`)를 쓰고,
  TS처럼 살아있는 프록시의 HTTP 관리 평면을 부르는 **공용 클라이언트가 없다**.
- 프록시 탐색: `go/internal/cli/runtime_liveness.go:33` `findLiveProxy`가 이미 있다.

## 변경 지도

| 파일 | 동작 |
| --- | --- |
| `go/internal/cli/runtime_api.go` (신규) | `runtimeBaseURL`, `runtimeRequest`, `RuntimeAPIError`, `CLIUsageError`, `responseMessage` |
| `go/internal/cli/argparse.go` (신규) | `takeFlag`, `takeOption`, `takeBooleanOption`, `takeIntegerOption`, `csvValues`, `rejectArgs`, `redactSecretArgs` |
| `go/internal/cli/output.go` (신규) | `printData(streams, payload any, wantsJSON bool, lines []string)` |
| `go/internal/cli/cli.go` | `init`에 `setup` 별칭, `models`에 `model` 별칭 추가 |
| `go/internal/cli/help.go` | `rootHelp`를 TS `printUsage()` 바이트와 일치시킴 |
| `go/internal/cli/help_test.go` | 낡은 TS 공개 명령 매니페스트 교체 |
| `go/internal/cli/command_registry_test.go` | 별칭 포함 레지스트리 대조 갱신 |

## 도움말 바이트 파리티

`TestTypeScriptAndGoUnknownCommandContract`는 stdout **바이트**를 비교한다. 즉 도움말은
의미가 아니라 문자열이 같아야 한다. 020~050이 명령을 추가할 때마다 해당 줄을 함께
추가하므로, 이 단계에서는 **구현이 존재하는 명령의 줄만** 정확히 맞추고, 아직 없는
명령 줄은 그 명령을 구현하는 work-phase에서 추가한다.

예외: `config`는 이미 구현되어 있으므로(`cli.go:74`) 이 단계에서 루트 도움말 줄을 넣는다.

## 수용 기준

| # | 기준 | 활성화 시나리오 | 관측 가능한 증거 |
| --- | --- | --- | --- |
| 1 | `ocx setup`이 `ocx init`과 동일 핸들러 | `Run(ctx, []string{"setup"})` | `commandIndex["setup"] == commandIndex["init"]` |
| 2 | `ocx model`이 `ocx models`와 동일 핸들러 | 동일 | 동일 |
| 3 | 관리 요청 실패 시 TS와 같은 메시지 | 테스트 서버가 `{"error":"boom"}` + 400 반환 | 오류 문자열이 `boom` |
| 4 | 프록시 미실행 시 정확한 안내 | `findLiveProxy`가 nil 반환하도록 주입 | `Proxy is not running. Start it with: ocx start`, status 503 |
| 5 | `--code` 값이 오류 메시지에 노출되지 않음 | `--code SECRET`을 파싱하지 않는 명령에 전달 | stderr에 `SECRET` 부재, `<redacted>` 존재 |
| 6 | `--code=<url>` 인라인 형태도 마스킹 | `--code=https://x?code=SECRET` | 동일 |
| 7 | 루트 도움말이 `config` 줄을 포함 | `ocx --help` | 해당 줄 존재 |

## 테스트

`go/internal/cli/runtime_api_test.go` (신규): `httptest` 서버로 4·3번 활성화,
`argparse_test.go` (신규): 5·6번 마스킹 표 기반 테스트 + 각 `take*` 파서의 오류 경로.

## 스코프 경계

IN: 위 파일들. OUT: 실제 명령 구현(020 이후), `src/**`.

## 완료 조건

`cd go && go build ./... && go vet ./...` exit 0, 신규 테스트 PASS,
`(umask 022; go test ./internal/cli/ -count=1)` PASS.

### 파리티 차분은 이 단계에서 닫히지 않는다

`TestTypeScriptAndGoUnknownCommandContract`는 루트 도움말 **바이트 전체**를 비교하므로
`combo`/`agent`/`observe`/`access`/`grok`/`system`/`opencode` 줄이 모두 생긴 뒤에야 통과한다.
즉 이 기준은 wp1의 것이 아니라 **wp5(마지막 CLI 슬라이스)에서 닫히는 집계 기준**이다.

goalplan도 그에 맞게 정정했다: wp1~wp4c는 `c-cli-slice`(슬라이스 자체 테스트가 단독으로
통과)를 지고, `c-parity-cli`(차분 통과)는 wp5가 진다. 이는 감사 1라운드 B6이 080.1/090.1에서
지적한 것과 **같은 결함**이며, 같은 방식으로 고쳤다 — 자기 페이즈에서 도달할 수 없는 기준은
증거를 미루거나 지어내게 만든다.
