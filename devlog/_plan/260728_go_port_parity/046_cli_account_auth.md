# 046 — wp4c: `account` 인증 서브명령

work-phase: `wp4c` · 선행: `010` · 감사 블로커 B2에서 생성 · 순서 정본: `006`

**보안 경계.** 인가 코드와 OAuth 흐름을 다룬다. 파싱 오류 경로에서 자격증명이 새면 안 된다.

## 왜 이 문서가 뒤늦게 생겼나

`002`는 `account`를 "Go에 있음"으로 표시했다. 명령 자체는 있지만 **인증 표면 전체**
(`login`/`reauth`, `code`, `cancel`, `reset-credits`)가 Go에 없다. 이 감사 발견이 가장
위험했다 — 자격증명 경로가 어느 work-phase에도 속하지 않은 채 완료될 뻔했다.

Go 현재 사용법(`go/internal/cli/account.go:18`)에는
`list|current|use|refresh|auto-switch|alias|add-key|add|remove`만 있다.

## 오라클 (`src/cli/account-auth.ts`)

### `login` / `reauth`

플래그: `--json --no-wait --reauth --id <id> --code <code>`.

Codex 계열 프로바이더(`CODEX_NAMES`)와 그 외의 경로가 다르다:

| 단계 | Codex | 그 외 |
| --- | --- | --- |
| 시작 | `POST /api/codex-auth/login` `{id?, reauth?}` | `POST /api/oauth/login` `{provider, addAccount: !reauth, accountId?, reauth?}` |
| 코드 제출 | `POST /api/codex-auth/login/code` `{flowId, input}` | `POST /api/oauth/login/code` `{provider, input}` |
| 폴링 | `GET /api/codex-auth/login-status?flowId=..` **최대 150회** | `GET /api/oauth/status?provider=..` **최대 100회** |

폴링 간격은 둘 다 2초. Codex는 `status === "done"`에서 성공, `error`/`expired`에서 실패.
그 외는 `loggedIn === true`에서 성공. 소진 시 `login timed out`.

`--no-wait`는 폴링을 건너뛴다. `--id`는 **`--reauth`와 함께일 때만** 프로바이더 OAuth에서
유효하다(그 외에는 사용법 오류).

**중요:** `--code`가 실제로 주어졌을 때만 코드를 해석한다. 평범한 `ocx account login`은
브라우저 흐름을 열고 폴링하므로 **stdin에서 블록하면 안 된다**.

### `code`

오라클 주석이 두 개의 실제 버그 수정을 기록하고 있다. 그대로 이식한다:

1. **플래그를 위치 인자보다 먼저 파싱한다.** 그러지 않으면
   `ocx account code openai --flow f1`이 `--flow`를 코드로 읽고 `f1`을 예상치 못한 인자로
   거부한다.
2. **알 수 없는 플래그는 자격증명이 아니다.** `--`로 시작하는 토큰은 위치 인자로 삼지
   않는다. 그러지 않으면 `--nope`가 코드가 되고 진짜 오류 메시지가 가려진다.

`--code`와 위치 인자를 **동시에** 주면 거부한다.
남은 인자 거부는 `redactValues: true`로 한다 — 두 번째 위치 인자는 따옴표 없는 공백이나
셸 확장으로 쪼개진 코드일 가능성이 높으므로 stderr에 되뿌리면 안 된다.

Codex 프로바이더는 `--flow <flow-id>`가 **필수**다.

### `cancel`

`POST /api/codex-auth/login/cancel` `{flowId}` 또는 `POST /api/oauth/login/cancel` `{provider}`.

### `reset-credits`

- `main` → `__main__`으로 사상
- 조회: `GET /api/codex-auth/reset-credits?accountId=..`
- 소비: `POST /api/codex-auth/reset-credits/consume` `{accountId}`
- **`--consume`은 `--yes` 없이는 거부**한다 (`consuming a reset credit requires --yes`)

## 변경 지도

| 파일 | 동작 |
| --- | --- |
| `go/internal/cli/account_auth.go` (신규) | `login`/`reauth`, `code`, `cancel`, `reset-credits` |
| `go/internal/cli/secret_input.go` (신규) | TTY 안내 + stdin 비밀 줄 읽기 |
| `go/internal/cli/account.go` | 4개 서브명령 디스패치 추가, 사용법 갱신 |

`010`의 `--code` 마스킹 원시요소가 여기서 실제로 쓰인다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `account code openai --flow f1` | `--flow`가 코드로 해석되지 않고 정상 처리 |
| 2 | `account code openai --nope` | "예상치 못한 인자" 오류, 코드 관련 오류 아님 |
| 3 | `--code X`와 위치 인자 동시 | 거부, 요청 미전송 |
| 4 | 두 번째 위치 인자에 비밀값 | stderr에 `<redacted>`, 원문 부재 |
| 5 | Codex 프로바이더 + `--flow` 없음 | `Codex login code requires --flow <flow-id>` |
| 6 | `account login` (코드 없이) | **stdin 블록 없음**, 폴링 시작 |
| 7 | 폴링 상태 `error`/`expired` | 즉시 실패, 계속 폴링하지 않음 |
| 8 | 폴링 소진 | `login timed out` |

**감사 2라운드 정정 — 폴링 계약은 문서화만으로 부족하다.** 초안은 150회 vs 100회를 적어놓고
수용 기준은 "소진 시 실패"만 요구했다. 그러면 두 프로바이더 모두 100회로 구현해도 통과한다.
아래를 추가한다.

| # | 활성화 | 관측 가능한 증거 |
| --- | --- | --- |
| 8a | 완료되지 않는 Codex 로그인, 슬립 함수 주입 | 상태 조회가 **정확히 150회** 후 `login timed out` |
| 8b | 완료되지 않는 비-Codex 로그인 | **정확히 100회** 후 `login timed out` |
| 8c | 주입된 슬립 호출 인자 | 매회 **2초** |
| 8d | `--no-wait` | 상태 조회 **0회**, 즉시 반환 |
| 8e | `--code -` (stdin) + Codex | 코드가 `/api/codex-auth/login/code`로 전송 |
| 8f | `--code -` (stdin) + 비-Codex | 코드가 `/api/oauth/login/code`로 전송 |
| 9 | `--id` + `--reauth` 없음 (비Codex) | 사용법 오류 |
| 10 | `reset-credits main` | `__main__`으로 조회 |
| 11 | `reset-credits x --consume` (`--yes` 없이) | 거부, POST 미전송 |
| 12 | 모든 실패 경로 | 인가 코드가 stdout·stderr·로그 어디에도 없음 |

6번은 회귀하기 쉬운 항목이다: stdin 읽기를 조건부로 만들지 않으면 브라우저 로그인이 멈춘다.
12번은 privacy 게이트와 직결된다.

## 테스트

`go/internal/cli/account_auth_test.go` — `httptest` 서버로 두 프로바이더 계열의 경로·본문을
단언하고, 폴링은 슬립 함수를 주입해 즉시 반복시킨다. stdin은 주입 가능한 리더로 대체한다.

## 스코프 경계

IN: 위 파일. OUT: 관리 서버 OAuth 라우트(이미 존재), `src/**`.
