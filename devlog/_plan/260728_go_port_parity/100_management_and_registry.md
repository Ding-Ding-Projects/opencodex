# 100 — wp10: 관리 제어 + 프로바이더 레지스트리

work-phase: `wp10` · 선행: 없음 (런타임 계열, 독립) · 순서 정본: `006`

## 100.1 `POST /api/system/restart`

**보안 경계.** 프로세스 재기동 제어다.

### 오라클 드레인 프로토콜

활성 턴은 abort 컨트롤러로 추적된다. 드레인 시작은 **즉시** 새 데이터 평면 트래픽을
`503` + `Retry-After: 5`로 거부한다. 응답 flush를 위해 200ms 대기 후 최대 **60초** 기다리고,
남은 턴을 중단하고, 응답 상태를 flush한 다음 리스닝을 멈춘다
(`src/server/lifecycle.ts:70`, `src/server/management/system-restart.ts:123`).

### 재기동 계약

| 상황 | 동작 |
| --- | --- |
| 실제 설치된 감독 자식 프로세스 | exit `1` — 실패 전용 감독자가 재시작하도록 |
| 그 외 | `ocx start --port <live-port>`를 detached 스폰, 프로세스 `spawn` 이벤트 대기, recycling 표시, exit `0` |
| 스폰 실패 | 안정적 errno 코드만 로깅, 상속된 서비스 상태 정리, **recycling 표시하지 않음**, exit `1` |

마지막 줄이 fail-closed의 핵심이다: 죽은 포트를 가리키는 Codex/Grok 주입을 남기지 않는다.

### Go 현재

수명주기는 이미 활성 턴 회계, 어드미션 503/Retry-After, 데드라인 중단, 우아한 HTTP 종료를
갖고 있다(`go/internal/server/lifecycle.go:14`). 관리 쪽에 `POST /api/system/restart`만 없다
(`management/system.go:12`는 GET 전용).

### 변경

- `management/api.go`에 라우트 등록, `management/system.go`에 수락/멱등 처리 구현.
- 수명주기·라이브 포트·재기동 백엔드를 `management.Options`로 `server.go`에서 주입.
  **관리 계층이 직접 셸을 실행하게 하지 말 것.**
- `go/internal/cli/serve.go`에서 백엔드 제공: 60초 타임아웃 드레인 후 감독자 재시작 요청
  또는 현재 실행 파일을 `start --port <selectedPort>`로 실행. 현재 `serveListener`는 8초
  정지 드레인만 한다(`serve.go:158`).
- **일반 정지 정리와 재활용 정리를 분리**한다. 현재 `apiStop`은 Grok 펜스를 해체하고 일반
  serve defer는 시스템 환경을 제거한다 — 성공적 재활용은 Codex 주입·시스템 환경·Grok 펜스를
  **보존해야** 한다(`serve.go:164`).

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 인증된 POST | 202 응답 형태 |
| 2 | 반복 호출 | 이미 드레인 중 보고, 추가 스케줄 없음 |
| 3 | 드레인 시작 직후 데이터 평면 요청 | 503 + `Retry-After: 5` |
| 4 | 활성 스트리밍 턴 보유 | 60초 인자 전달, 이후 중단 |
| 5 | 감독 환경 | exit 1 |
| 6 | 비감독 환경 | 같은 포트 스폰 → recycling → exit 0 |
| 7 | 동기/비동기 스폰 실패 | recycling 표시 없음, exit 1, 살균된 오류만 |
| 8 | 미인증 데이터 평면 경로 | 접근 불가 |

## 100.2 `zhipu-bigmodel` 프로바이더

### 오라클 엔트리

ID `zhipu-bigmodel`, OpenAI-chat 어댑터, API 키 인증, BigModel base URL, 대시보드 URL,
기본 모델 `glm-4.6`, `zai` 메타데이터 번들. 정적 모델: `glm-4.6`, `glm-4.7`, `glm-4.7-flash`,
`glm-5`, `glm-5.1`, `glm-4.6v`. 기본 컨텍스트 204,800. `glm-4.6v`만 text+image, 나머지는
텍스트 전용. 라이브 모델 조회는 주장하지 않는다(`src/providers/registry.ts:817`).

### thinking 토글 사상

`none|minimal|low → disabled`, `medium|high|xhigh|max → enabled`. 목록에 있는 thinking 토글
모델은 `reasoning_effort` 대신 `thinking:{type:...}`을 보낸다(`src/adapters/openai-chat.ts:550`).

### 엔드포인트 안전성 (중요)

`glm` 또는 `glm-cn`을 **재사용하면 안 된다**. 그 둘은 이미 다른 Z.AI 제품으로 라우팅된다.
레지스트리 정규화가 저장된 설정을 다른 호스트로 재조준해 **키를 잘못된 곳으로 보낼 수 있다**
(`src/providers/registry.ts:808`, `tests/zhipu-bigmodel-provider.test.ts:67`).

### 변경

Go에는 레지스트리 계층이 둘 있다(`go/internal/registry/registry.go`,
`go/internal/providers/registry.go`). 양쪽에 엔트리를 추가하거나 먼저 통합한다.
공용 메타데이터/파생 경로와 OpenAI-chat 요청 구성이 **모델별 thinking 토글 맵**을 인식하도록
확장한다 — 레지스트리만 추가하면 여전히 지원되지 않는 `reasoning_effort`를 보낸다.

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 레지스트리 조회 | 엔트리·모델 목록·컨텍스트가 오라클과 일치 |
| 2 | 저장된 `glm` 설정 존재 | 정규화가 `zhipu-bigmodel`로 재조준하지 않음 |
| 3 | effort `low` | 본문에 `thinking:{type:"disabled"}`, `reasoning_effort` 부재 |
| 4 | effort `high` | `thinking:{type:"enabled"}` |
| 5 | `glm-4.6v` | text+image 메타데이터 |

## 100.3 `syncCodexSubagentDefaults`

### 오라클

선택적 boolean, 기본 부재/false. `true`이고 `injectionModel`이 비어 있지 않을 때만 유효하다.
선택적 `injectionEffort`는 지원되는 Codex effort여야 한다. **잘못된 영속값은 전체 설정을
무효화하지 않고 이 옵트인만 비활성화하며 경고를 만든다**(`src/config.ts:817`).

Codex 주입/동기화 중 실행되며 `config.toml`의 표시된(marked) `[agents]` 키
`default_subagent_model`과 선택적 `default_subagent_reasoning_effort`만 관리한다.
사용자 소유 값은 보존하고, 모호한 마커 배치에서는 **쓰기 없이 거부**하며, 비활성화/복원 시
소유 잔여물을 제거하고, 외부 프로바이더나 사용자 소유 `openai_base_url` 설정은 건드리지 않는다
(`src/codex/inject.ts:506`).

### 변경

`config.go`에 `SyncCodexSubagentDefaults bool` + `schema_manifest_test.go` 갱신,
`management/agents.go`에 GET/PUT 페이로드·유효 상태 검증·모델 클리어 동작·저장 롤백,
`go/internal/codex/subagent_defaults.go` 신규(마커 인식 TOML 변환)와 주입/동기화/복원 경로 호출.

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 잘못된 옵트인 영속값 | 이 기능만 비활성화, 설정 전체는 유효, 경고 생성 |
| 2 | true + 빈 모델 | 비활성 |
| 3 | 모호한 마커 배치 | 쓰기 거부, 파일 불변 |
| 4 | 사용자 소유 값 존재 | 보존 |
| 5 | 활성화 → 비활성화 → 복원 | 소유 잔여물 제거, 사용자 바이트 보존 |
| 6 | CRLF 파일 | 줄 끝 보존, 멱등 |
| 7 | 외부 프로바이더 설정 | 불변 |

## 스코프 경계

IN: `management/api.go`, `management/system.go`, `management/agents.go`, `cli/serve.go`,
양 레지스트리, `adapter/openai/chat.go`, `codex/subagent_defaults.go`, `config.go`.
OUT: `src/**`, GUI.
