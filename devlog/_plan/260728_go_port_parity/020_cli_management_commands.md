# 020 — wp2: 관리 리소스 CLI 명령 (combo/route, agent, grok/integration)

work-phase: `wp2` · 선행: `010` (전송·파싱·출력 원시요소) · 순서 정본: `006`

## 왜 여기인가

세 명령 모두 **이미 존재하는 Go 관리 라우트 위의 순수 래퍼**다. 서버 변경이 필요 없으므로
`010`의 원시요소가 실제로 충분한지 가장 먼저 증명하는 슬라이스이기도 하다.

## combo (+ route)

오라클: `src/cli/combo.ts`. 라우트: `GET/PUT/DELETE /api/combos`
(Go: `go/internal/management/combos.go:28`).

서브명령과 별칭:

| 입력 | 동작 |
| --- | --- |
| `list`(기본), `--json` | `GET /api/combos` → `id  model` 줄 목록, 비면 `No combos configured.` |
| `show <id>` | 목록에서 id 검색, 없으면 `unknown combo <id>` |
| `set`/`create`/`update <id>` | `PUT /api/combos` |
| `remove`/`delete <id> --yes` | `DELETE /api/combos?id=<urlencoded>` |

`set` 플래그 계약(오라클 `combo.ts:67`부터):

- `--targets` **필수**. 형식 `provider/model[:weight],...`
  - 가중치는 `provider/model` 안의 첫 `/` 뒤에 오는 마지막 `:`만 가중치로 해석한다.
    (`part.lastIndexOf(":") > part.indexOf("/")` 조건 — 모델 이름에 콜론이 있어도 안전)
  - 가중치는 정수이며 `1..10000` 범위 밖이면 오류
  - 빈 목록이면 `--targets requires at least one provider/model`
- `--strategy` 기본 `failover`, 허용 `failover|round-robin`
- `--sticky` 기본 `1`, 정수 `>= 1`이며 `<= 100`
- `--effort`: `-`이면 `defaultEffort: null`, 아니면 문자열
- `--alias`: `-`이면 `""`, 아니면 문자열
- `--rename-from`: 있으면 본문에 포함

`route`는 `route combo ...`만 받는 래퍼다(`src/cli/index.ts:980`). 그 외 서브명령은 오류.

## agent

오라클: `src/cli/agent.ts`. 서브명령 → 라우트:

| 서브명령(별칭) | GET | PUT |
| --- | --- | --- |
| `status`(기본) | `/api/v2` | — |
| `injection`(`guidance`) | `/api/injection-model` | 동일 |
| `effort` | `/api/effort-caps` | 동일 |
| `subagents`(`roster`) | `/api/subagent-models` | 동일 |
| `fallback` | `/api/subagent-model-fallback` | 동일 |
| `sidecar` | `/api/sidecar-settings` | 동일 |

`sidecar` 본문 구성 규칙(`agent.ts:160` 부근): `--model`/`--backend`/`--reasoning`/
`--max-descriptions-per-turn` 중 최소 하나 필요하며, `-`는 각각 `""`와 `null`로 사상된다.
`web`/`vision` 섹션에 따라 본문 키가 `webSearch` 또는 `vision`이 된다.

`clear` 계열은 해당 리소스에 빈 값을 PUT한다 — 오라클의 정확한 본문을 그대로 따를 것.

## grok / integration

오라클: `src/cli/integrations.ts`. 라우트: `GET /api/grok`, `PUT /api/grok/selection`,
`POST /api/grok/apply` (Go: `management/grok.go:38`), 그리고 `GET/PUT /api/claude-code`
(Go: `management/runtime_settings.go:29`).

- `ocx grok <sub>` == `ocx integration grok <sub>`
- `ocx integration claude <sub>`는 Claude Code 설정 표면이며 플래그가 많다
  (`--enabled --auth-mode --system-env --fast-mode --auto-context --compact-window
  --inject-agents --small-fast-model --model-map --blocked-skills --web-model
  --web-backend --vision-model --vision-backend`)

## 변경 지도

| 파일 | 동작 |
| --- | --- |
| `go/internal/cli/combo.go` (신규) | `runCombo`, `runRoute`, 타깃 파서 |
| `go/internal/cli/agent.go` (신규) | `runAgent` + 6개 섹션 |
| `go/internal/cli/integrations.go` (신규) | `runGrok`, `runIntegration` |
| `go/internal/cli/cli.go` | 세 명령 등록 (+`route`, `integration`) |
| `go/internal/cli/help.go` | `combo`/`agent`/`grok` 루트 도움말 줄 + 서브토픽 도움말 |

## 수용 기준

| # | 기준 | 활성화 시나리오 | 증거 |
| --- | --- | --- | --- |
| 1 | 타깃 파서가 모델명 콜론과 가중치 콜론을 구분 | `--targets a/b:c:3` | 파싱 결과 provider=a model=b:c weight=3 |
| 2 | 가중치 범위 위반 거부 | `--targets a/b:0` / `:10001` | 사용법 오류, 요청 미전송 |
| 3 | `--sticky 101` 거부 | 동일 | 사용법 오류 |
| 4 | `--effort -`가 null로 직렬화 | `set x --targets a/b --effort -` | PUT 본문에 `"defaultEffort":null` |
| 5 | `remove`가 `--yes` 없이는 거부 | `remove x` | `remove requires --yes`, DELETE 미전송 |
| 6 | `route`가 `combo` 외 서브명령 거부 | `route bogus` | 사용법 오류 |
| 7 | `agent sidecar`가 옵션 0개면 거부 | `agent sidecar web` | `at least one sidecar option is required` |
| 8 | 각 서브명령이 정확한 경로·메서드 사용 | `httptest` 서버가 경로 기록 | 기록된 (메서드, 경로) 집합이 표와 일치 |

## 테스트

`go/internal/cli/combo_test.go`, `agent_test.go`, `integrations_test.go` — 모두
`httptest` 서버를 주입해 요청 본문·경로·메서드를 단언한다. 라이브 프록시 불필요.

## 스코프 경계

IN: 위 CLI 파일. OUT: 관리 서버 라우트 수정(030이 `/api/logs` 쿼리를 다룬다), `src/**`.
