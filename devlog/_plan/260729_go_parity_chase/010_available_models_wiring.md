# 010 — WP1: `available` 복원 (subagent-models / injection-model)

선행: 없음. 이 유닛에서 가장 얕은 층이다.
상태: 계획.

## 무엇이 깨져 있나

GUI의 서브에이전트 모델 선택기와 주입 모델 드롭다운이 go 런타임에서 영구히 비어 있다.
에러가 아니라 빈 목록이라 아무도 버그로 신고하지 않는다. 라우트는 200을 반환한다.

오라클은 두 응답 모두에 `available`을 담는다:

- `src/server/management/agent-settings-routes.ts:331-335` — 네이티브 슬러그 + 비활성
  제외 라우팅 모델의 합집합을 만들어 `jsonResponse({ chosen, available })`.
- 같은 파일 `:360-367` — 같은 `available`을 injection 응답에 포함.

go는 둘 다 그 키를 뺀다.

## 이미 있는 것 (감사 중 정정)

`go/internal/management/runtime_settings.go:56`에 `(*API).availableModels()`가 있다.
처음에는 "형제 라우트 두 곳(`:85`, `:203`)이 이미 쓰므로 그대로 따라 쓰면 된다"고 적었다.
감사에서 **반만 맞았다**는 것이 드러났다.

실제로는 두 라우트가 서로 다른 것을 쓴다:

| 라우트 | available 출처 | `disabledModels` 제외 |
| --- | --- | --- |
| `/api/subagent-model-fallback` (`:85`) | `a.availableModels()` 원본 | **안 함** |
| `/api/claude-code` (`:163` → `:203`) | `a.availableModels()` 원본 | **안 함** |
| `/api/claude-desktop` (`claude_desktop.go:230`) | `codex.FilterVisibleRuntimeModels(...)` | 함 |

즉 `availableModels()`는 레지스트리 전체를 돌고 비활성 모델을 거르지 않는다. 오라클은
세 곳 모두에서 거른다(`agent-settings-routes.ts:331`의 `disabled` 필터).

그리고 go에는 이미 올바른 헬퍼가 있다 — `codex.FilterVisibleRuntimeModels`
(`go/internal/codex/catalog_visibility.go:14`)가 `cfg.DisabledModels`를 제외하고
네이티브/라우팅 모델을 합친다. `claude_desktop.go`가 이미 그걸 쓴다.

### 결정

새 라우트 두 개에는 **`availableModels()`가 아니라 비활성 제외 경로를 쓴다.** 이유는
사용자가 바로 겪는 차이다: 모델을 비활성화해둔 사용자에게 서브에이전트 선택기가 그
모델을 계속 제안하면, 골라도 라우팅되지 않는다. 빈 목록을 고치면서 틀린 목록을 새로
만드는 셈이다.

구현은 `availableModels()`에 비활성 필터를 넣는 대신 **새 헬퍼**를 추가한다 —
기존 두 형제 라우트의 바이트 출력을 바꾸지 않기 위해서다. 그 둘의 필터 누락은 별개
결함이며, 아래 "남기는 것"에 남긴다.

## 변경 지도

### NEW 헬퍼 `go/internal/management/runtime_settings.go`

```go
+// availableModelsExcludingDisabled mirrors the oracle's `available` union
+// (agent-settings-routes.ts:331): native slugs plus routed models, minus the
+// user's disabled set. availableModels() deliberately stays unfiltered so the
+// two existing sibling routes keep their current bytes.
+func (a *API) availableModelsExcludingDisabled() []string
```

`codex.FilterVisibleRuntimeModels(a.registry.ListModels(), a.config)`로 가시 모델을 얻고
`provider/id` 슬러그로 접는다. 잠금은 `a.config` 읽기 구간에만 건다.

### MODIFY `go/internal/management/agents.go`

`/api/subagent-models` GET (현재 :14-20):

```go
 		if r.Method == http.MethodGet {
 			a.mu.RLock()
 			models := append([]string(nil), a.agents.Models...)
 			a.mu.RUnlock()
-			writeJSON(w, http.StatusOK, map[string]any{"chosen": models})
+			if models == nil {
+				models = []string{}
+			}
+			writeJSON(w, http.StatusOK, orderedJSONObject{
+				{name: "chosen", value: models},
+				{name: "available", value: a.availableModelsExcludingDisabled()},
+			})
 			return true
 		}
```

`orderedJSONObject`를 쓰는 이유는 형제 라우트(`runtime_settings.go:85`)가 이미 그 형태로
키 순서를 고정하고 있어서다. 파리티 테스트가 바이트 대조를 하는 경우 순서가 의미를 갖는다.

`/api/injection-model` GET (현재 :55-60): 응답 맵 끝에 `available`을 추가한다. 현재
`map[string]any` 리터럴 한 줄이므로 같은 형태를 유지하되 키를 하나 넣는다:

```go
-			writeJSON(w, http.StatusOK, map[string]any{"multiAgentGuidanceEnabled": ..., "efforts": effortList})
+			writeJSON(w, http.StatusOK, map[string]any{"multiAgentGuidanceEnabled": ..., "efforts": effortList, "available": a.availableModelsExcludingDisabled()})
```

`a.mu.RLock()` 안에서 부르지 않는다 — 새 헬퍼는 `a.config`를 읽으므로 잠금을 자체적으로
잡는다. 호출자가 이미 잡은 채로 부르면 재진입 교착이 된다. 반드시 RUnlock 뒤에 부른다.

### NEW `go/internal/management/agents_available_test.go`

기존 `storage_routes_test.go`의 `serveManagement(api, method, path, body)` 헬퍼를
재사용한다. 레지스트리에 모델 2개를 심고 그중 **하나를 `DisabledModels`에 넣는다**.
두 응답 모두에서 살아 있는 슬러그는 나오고 비활성 슬러그는 **나오지 않는** 것을 본다.
비활성 케이스가 없으면 이 유닛의 핵심 결정이 검증되지 않는다.

## 수용 기준

1. `GET /api/subagent-models` 응답에 `available` 키가 있고 배열이다.
2. `GET /api/injection-model` 응답에 `available` 키가 있고 배열이다.
3. 비활성 처리된 모델이 두 배열 어디에도 없다.
4. `chosen`/기존 키의 값과 타입이 변하지 않는다.
5. `/api/subagent-model-fallback`과 `/api/claude-code`의 응답 바이트가 변하지 않는다
   (회귀 방지 — 이 유닛은 그 둘을 건드리지 않는다).

### 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

비활성 필터가 **실제로 무언가를 걸러내는 것**이 이 유닛의 조건 분기다. 라이브 go 프록시를
띄우고: (1) 두 경로를 curl해 `available`이 실제 슬러그로 채워지는 것을 읽고,
(2) 모델 하나를 비활성화한 뒤 다시 curl해 그 슬러그가 **사라지는** 것을 읽는다.
(2)가 없으면 필터가 죽어 있어도 통과한다. 빈 배열은 어느 쪽도 통과가 아니다.

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/management/ -count=1
curl -s http://127.0.0.1:<port>/api/subagent-models
curl -s http://127.0.0.1:<port>/api/injection-model
```

## 남기는 것

`/api/subagent-model-fallback`(`:85`)과 `/api/claude-code`(`:203`)는 여전히 비활성
모델을 `available`에 담는다. 오라클은 둘 다 거른다. 이건 이번 유닛과 **같은 계열의 별개
결함**이며, 두 라우트의 응답 바이트를 바꾸므로 파리티 테스트 갱신을 동반해야 한다.
D에서 후속 work-phase 후보로 기록한다.
