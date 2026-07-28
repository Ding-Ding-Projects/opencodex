# 030 — wp3: system + observe CLI 명령

work-phase: `wp3` · 선행: `010` · 순서 정본: `006`

## system

오라클: `src/cli/system-command.ts`. 서브명령(기본 `status`):

| 서브명령 | 요청 |
| --- | --- |
| `status` | `GET /api/settings` + `GET /api/startup-health` + `GET /api/system/memory` 조합 |
| `settings` | `GET /api/settings` |
| `startup health\|status` | `GET /api/startup-health` |
| `startup install-service\|install-shim` | `POST /api/startup-action` |
| `diagnostics` | `GET /api/diagnostics/project-config` |
| `sync` | `POST /api/sync` |
| `update check` | `GET /api/update/check` |
| `update status` | `GET /api/update/status` |
| `update run --yes` | `POST /api/update/run`, 본문 `{tag: <channel>, restart: <bool>}` |

`update run`은 `--yes` 없이는 `update run requires --yes`로 거부한다
(`system-command.ts:88`). `--channel`이 본문의 `tag`로 이름이 바뀌는 점에 주의.

모든 라우트는 Go에 이미 존재한다(`management/config.go:20`, `system.go:17`,
`runtime_control.go:76`). 서버 변경 없음.

## observe (+ logs/usage/storage/memory 별칭)

오라클: `src/cli/observe.ts`. 기본 서브명령은 `logs`.

| 서브명령 | 경로 | 플래그 |
| --- | --- | --- |
| `logs` | `/api/logs` | `--provider --model --status --limit --follow/-f --json --jsonl` |
| `usage` | `/api/usage` | `--range(7d\|30d\|all, 기본 30d) --surface(all\|codex\|claude\|grok, 기본 all) --json` |
| `storage` | `/api/storage` | `--limit --json` |
| `memory` | `/api/system/memory` | `--limit --json` |
| `debug` | `/api/debug` | `--limit --json` |
| `claude-inbound` | `/api/claude/inbound-debug` | `--limit --json` |
| `injection` | `/api/debug/injection-logs` | `--limit --json` |

`logs` 상호 배타 규칙(`observe.ts:60`):

- `--json`과 `--jsonl` 동시 사용 → `--json and --jsonl cannot be combined`
- `--follow`와 `--json` 동시 사용 → `--follow uses --jsonl, not --json`
- `--follow`는 1초 간격 폴링, 본 행은 키(`id` 또는 `timestamp:provider:model:status`)로
  중복 제거하고, 본 키가 5,000개를 넘으면 최근 2,500개만 유지

### 서버 쿼리 파라미터 — 실측 정정

초기 탐색은 "Go `/api/logs`가 TS와 달리 `limit`/`model`을 무시한다"고 보고했으나,
오라클을 직접 읽어 확인한 결과 **TS 서버도 그 둘을 읽지 않는다**:

- TS `filterRequestLogs`(`src/server/request-log.ts:741`)가 읽는 키: `provider`,
  `conversationId`(별칭 `conversation`), `status`, `tail`
- Go `FilterRequestLogs`(`go/internal/server/request_log_port.go:721`)가 읽는 키:
  `provider`, `status`, `tail`

즉 CLI가 보내는 `limit`/`model`은 **양쪽 서버 모두에서 조용히 무시**되며 클라이언트 측
표시 필터도 아니다. 이것은 오라클의 기존 동작이므로 Go에서 "고치면" 오히려 파리티가
깨진다. 따라서:

- **하지 않을 것**: Go 서버에 `limit`/`model` 필터 추가
- **할 것**: Go `FilterRequestLogs`에 `conversationId`/`conversation` 필터 추가 — 이것이
  실제 누락분이며 `003`의 로그 상관관계 항목과 같은 뿌리다. 단, `conversationId` 필드
  자체가 Go 로그 엔트리에 없으므로 이 필터는 **wp11(관측성)**에서 필드와 함께 구현한다.
  wp3에서는 CLI만 오라클과 동일하게 파라미터를 보낸다.

이 정정은 LOOP-CONTINUITY-01에 따라 다음 사이클로 전달된다.

## 변경 지도

| 파일 | 동작 |
| --- | --- |
| `go/internal/cli/system_command.go` (신규) | `runSystem` + 서브명령 |
| `go/internal/cli/observe.go` (신규) | `runObserve` + 7개 서브명령 + 별칭 4종 |
| `go/internal/cli/cli.go` | `system`, `observe`, `logs`, `usage`, `storage`, `memory` 등록 |
| `go/internal/cli/help.go` | 해당 루트 도움말 줄 |

## 수용 기준

| # | 기준 | 활성화 시나리오 | 증거 |
| --- | --- | --- | --- |
| 1 | `update run`이 `--yes` 없이 거부 | `system update run` | 오류 메시지 일치, POST 미전송 |
| 2 | `--channel`이 본문 `tag`로 전송 | `system update run --channel preview --yes` | 기록된 본문 `{"tag":"preview",...}` |
| 3 | `--json`+`--jsonl` 거부 | `observe logs --json --jsonl` | 정확한 오류 문자열 |
| 4 | `--follow`+`--json` 거부 | `observe logs -f --json` | 정확한 오류 문자열 |
| 5 | `--range` 값 검증 | `observe usage --range 90d` | `--range must be 7d, 30d, or all` |
| 6 | `--surface` 값 검증 | `observe usage --surface bogus` | 정확한 오류 문자열 |
| 7 | follow 중복 제거 | 같은 행을 두 번 반환하는 스텁 서버, 2회 폴링 | 출력에 행이 1회만 등장 |
| 8 | 별칭이 서브명령으로 사상 | `ocx logs` == `ocx observe logs` | 동일 요청 경로 |

## 테스트

`go/internal/cli/system_command_test.go`, `observe_test.go`. follow 루프는 슬립 함수를
주입 가능하게 만들어 테스트가 즉시 2회 반복 후 종료하도록 한다.

## 스코프 경계

IN: 위 CLI 파일. OUT: `conversationId` 서버 필터(wp11), `src/**`.
