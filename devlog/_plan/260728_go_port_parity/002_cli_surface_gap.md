# 002 — CLI 표면 격차 인벤토리

측정: 2026-07-28. 방법: 독립 read-only 탐색 에이전트 1대 + 주 에이전트 직접 재확인.
오라클 디스패치는 `src/cli/index.ts:710` 이하 `switch`, Go 레지스트리는
`go/internal/cli/cli.go:47` `commandSpecs`.

## A. 최상위 명령 대조

Go에 **없는** TS 최상위 명령. 아래는 **구현 그룹 10개 / 정규 명령 토큰 11개**다
(`grok`과 `integration`은 TS에서 별도 디스패치된다, `src/cli/index.ts:1018`).
별칭은 표 안에 괄호로 적었고 토큰 수에는 포함하지 않는다.

| 명령 | 성격 | TS 구현 | 규모 |
| --- | --- | --- | --- |
| `setup` | `init` 별칭 | `src/cli/index.ts:711` | 별칭만 |
| `model` | `models` 별칭 | `src/cli/index.ts:969` | 별칭만 |
| `combo` | 관리 리소스 | `src/cli/combo.ts` | 119줄 |
| `route` | `route combo` 래퍼 | `src/cli/index.ts:980` | 래퍼 |
| `agent` | 관리 리소스 | `src/cli/agent.ts` | 184줄 |
| `observe` (+`logs`/`usage`/`storage`/`memory`) | 관측 | `src/cli/observe.ts` | 117줄 |
| `access` (+`api-key`) | 어드미션 | `src/cli/access.ts` | 108줄 |
| `grok` | 통합 | `src/cli/integrations.ts` | 142줄 (공유) |
| `integration` | 통합 | 같은 모듈, 별도 디스패치 | 공유 |
| `system` | 런타임 제어 | `src/cli/system-command.ts` | 112줄 |
| `opencode` | 외부 런처 | `src/cli/opencode.ts` | 701줄 |

TS의 숨은 워커 동사 6종(`__refresh-version`, `__tray-start`, `__tray-restart`,
`__startup-health`, `__tray-host`, `__gui-update-worker`, `src/cli/index.ts:909`)은 공개
표면이 아니다. Go는 이를 자체 런처 경로로 처리하므로 파리티 대상에서 제외한다.

## B. 백엔드 준비 상태

대부분의 누락 명령은 **얇은 래퍼**다. 필요한 관리 라우트가 Go에 이미 있다.

| 명령 | 호출 엔드포인트 | Go 관리 서버 상태 |
| --- | --- | --- |
| `combo` | `GET/PUT/DELETE /api/combos` | 존재 (`go/internal/management/combos.go:28`) |
| `agent` | `/api/v2`, `/api/injection-model`, `/api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`, `/api/sidecar-settings` | 전부 존재 (`agents.go:11`, `runtime_settings.go:18`, `config.go:66`) |
| `grok` / `integration claude` | `/api/grok*`, `/api/claude-code` | 존재 (`grok.go:38`, `runtime_settings.go:29`) |
| `system` | `/api/settings`, `/api/startup-health`, `/api/startup-action`, `/api/diagnostics/project-config`, `/api/sync`, `/api/update/*`, `/api/system/memory` | 전부 존재 |
| `access` | `/api/keys` + 데이터플레인 `/v1/*` | 전부 존재 (`api_keys.go:15`, `server.go:376`) |
| `observe` | `/api/logs`, `/api/usage`, `/api/storage`, `/api/system/memory`, `/api/debug`, `/api/claude/inbound-debug`, `/api/debug/injection-logs` | 라우트는 존재하나 **쿼리 파라미터 불일치** |
| `opencode` | `GET /api/models` | 라우트는 존재하나 **응답 형태 불일치** |

### 얇지 않은 두 지점

1. **`/api/logs` 쿼리 파라미터**: Go는 `tail`/`provider`/`status`만 읽는다
   (`go/internal/management/logs.go:183`). TS CLI는 `limit`과 `model`을 보낸다
   (`src/cli/observe.ts`). Claude inbound 라우트도 `limit`을 무시한다(`logs.go:266`).
   → `observe` 슬라이스가 CLI와 서버 양쪽을 함께 고쳐야 한다.
2. **`/api/models` 응답 계약**: TS `opencode` 런처는 응답 본문 자체가 배열이라고 가정한다
   (`src/cli/opencode.ts:401`). Go는 `{models, customModels}` 객체를 반환한다
   (`go/internal/management/models.go:15`). → 런처 이식 전에 이 계약을 먼저 결정해야 한다.

## C. 루트 도움말 차분

`src/cli/help.ts:233` `printUsage()` vs `go/internal/cli/help.go:67` `rootHelp`.

| 항목 | TS | Go |
| --- | --- | --- |
| 셋업 줄 | `ocx setup` (별칭: init) | `ocx init` |
| debug 줄 | `ocx debug <scope>` 한 줄 | 두 줄 + `logs [-f]` 언급 |
| login 줄 | `OAuth or API-key provider login` | `OAuth login (xai) …` |
| provider/account/models 줄 | 능력 중심 서술 | 서브명령 나열식 |
| 누락 줄 | — | `combo`,`agent`,`observe`,`access`,`grok`,`system`,`config`,`opencode` 전부 없음 |

`config`는 Go에 등록되어 있고 루트 도움말에서 빠져 있다(`cli.go:74` vs `help.go`).

**정정(감사 B1):** 처음에는 이것을 "도움말 누락일 뿐"으로 적었으나 **틀렸다**. Go의
`config`는 고정 키 몇 개만 다루고 `export`/`import`/임의 점 경로/`--source`가 없다
(`go/internal/cli/config_command.go:13` vs `src/cli/config-command.ts`). 등록되어 있다는
사실은 파리티를 뜻하지 않는다. 전용 슬라이스는 `045`.

**정정(감사 B2):** `account`도 "Go에 있음"으로 표시했으나, 명령은 있고 **인증 서브명령
전체**(`login`/`reauth`, `code`, `cancel`, `reset-credits`)가 없다
(`go/internal/cli/account.go:18` vs `src/cli/account-auth.ts:215`). 전용 슬라이스는 `046`.

## 이 인벤토리가 만드는 work-phase

**정정(감사 B5):** 처음에는 `wp1 → wp2 → wp3 → wp4 → wp5`로 적었으나 그것은 DAG가 아니라
순번이었다. 실제 코드 의존성은 다음과 같다.

```
010 (전송·파싱·출력 원시요소)
 ├─> 020  combo/route, agent, grok/integration
 ├─> 030  system, observe
 ├─> 040  access/api-key
 ├─> 045  config 파리티
 ├─> 046  account 인증
 └─> 050  opencode 런처
```

`010` 이후 여섯 슬라이스는 **서로 독립**이며 임의 순서·병렬로 진행할 수 있다. 간선은
"앞 단계가 만든 구체적 심볼/API를 뒤 단계가 소비할 때"만 긋는다.
