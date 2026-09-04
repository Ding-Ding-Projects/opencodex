# 030 — WP3: 완료 이벤트의 빈 `response.output` 재조립

선행: WP1, WP2 (관리·CLI 층이 정리된 뒤 전송 층으로 내려간다).
상태: 계획.

## 계획 중 정정한 것

처음에는 이 phase를 "미완결 스트림 종결 분류 이식"으로 잡았다. cli-proxy-api가
`codexIncompleteStreamError`(`codex_executor_terminal.go:15`)로 `response.completed` 없이
끊긴 스트림을 오류로 승격시키는 것을 보고, 우리에게 없다고 가정했다.

틀렸다. opencodex는 이미 갖고 있다 — `go/internal/bridge/bridge.go:151`과 `:203`이
`finishIncomplete("adapter_eof", "adapter stream ended without terminal event")`를 부르고,
`request_log_port.go:651`이 그것을 사용자 문구로 표면화한다. Claude 경로 테스트
(`chat/outbound_test.go:416`)가 `upstream response was incomplete (adapter_eof)`를 실제로
단언한다. 이 축은 우리가 뒤처진 게 아니다.

진짜 gap은 그 옆에 있었다.

## 무엇이 깨져 있나

업스트림이 `response.output_item.done`으로 항목을 다 보내놓고 `response.completed`의
`response.output`을 빈 배열로 주는 경우가 있다. 이때 클라이언트는 완료 신호를 받지만
**턴 결과가 비어 있다**. 오류가 아니므로 재시도도 걸리지 않는다.

오라클은 패스스루 릴레이에서 이걸 막는다 — `src/server/relay.ts:476-497`:

1. `response.output_item.done` 이벤트마다 `output_index → item`을 맵에 모은다.
   (`:476-486`, 유효성: `output_index`가 0 이상 정수, `item`이 `type` 문자열을 가진 객체)
2. 완료 이벤트의 `response.output`이 배열이 아니거나 비었고 모은 항목이 있으면
   (`:489-491`), `output_index` 오름차순으로 정렬해 `output`을 채운다 (`:492-497`).

cli-proxy-api도 독립적으로 같은 방어를 한다
(`collectCodexOutputItemDone` / `patchCodexCompletedOutput`). 두 구현이 수렴한다는 건
이 실패가 현장에서 실제로 관측된다는 뜻이다.

go의 `SSEInspector`에는 대응물이 없다. `relay_inspector.go:139-142`는 완료 이벤트의
`response`를 **그대로** 복제해 넘긴다 — 비어 있으면 비어 있는 채로.

## 변경 지도

### MODIFY `go/internal/server/relay_inspector.go`

구조체에 수집 맵을 추가한다 (기존 필드 옆):

```go
+	// response.completed sometimes arrives with an empty output while every item
+	// already shipped as response.output_item.done. Keep them so the completed
+	// response can be rebuilt rather than handed over empty (oracle:
+	// src/server/relay.ts:476).
+	completedItemsByIndex map[int]map[string]any
```

`inspectPayload`에서 `eventType` 판정 뒤, 종결 처리 **앞**에 수집을 넣는다:

```go
+	if eventType == "response.output_item.done" {
+		inspector.collectCompletedItem(event)
+	}
```

수집 헬퍼는 오라클의 유효성 검사를 그대로 옮긴다:

```go
+func (inspector *SSEInspector) collectCompletedItem(event map[string]any) {
+	item, ok := event["item"].(map[string]any)
+	if !ok {
+		return
+	}
+	if _, ok := item["type"].(string); !ok {
+		return
+	}
+	raw, ok := event["output_index"].(float64)
+	if !ok || raw < 0 || raw != math.Trunc(raw) {
+		return
+	}
+	if inspector.completedItemsByIndex == nil {
+		inspector.completedItemsByIndex = map[int]map[string]any{}
+	}
+	inspector.completedItemsByIndex[int(raw)] = cloneAnyMap(item)
+}
```

`float64` 경유는 `encoding/json`이 숫자를 그렇게 언마샬하기 때문이고, `math.Trunc`
비교는 오라클의 `Number.isInteger`에 대응한다.

완료 처리 지점(:139-142)에서 재조립한다:

```go
 	if status == ResponsesCompleted && response != nil {
+		response = inspector.rebuildEmptyOutput(response)
 		inspector.completed = cloneAnyMap(response)
```

```go
+func (inspector *SSEInspector) rebuildEmptyOutput(response map[string]any) map[string]any {
+	if len(inspector.completedItemsByIndex) == 0 {
+		return response
+	}
+	if existing, ok := response["output"].([]any); ok && len(existing) > 0 {
+		return response
+	}
+	indexes := make([]int, 0, len(inspector.completedItemsByIndex))
+	for index := range inspector.completedItemsByIndex {
+		indexes = append(indexes, index)
+	}
+	sort.Ints(indexes)
+	output := make([]any, 0, len(indexes))
+	for _, index := range indexes {
+		output = append(output, inspector.completedItemsByIndex[index])
+	}
+	rebuilt := cloneAnyMap(response)
+	rebuilt["output"] = output
+	return rebuilt
+}
```

비어있지 않은 `output`은 건드리지 않는다 — 정상 경로에서 바이트가 변하면 안 된다.

### NEW 테스트 `go/internal/server/relay_inspector_reassembly_test.go`

세 경우를 나눈다:

1. `output`이 채워져 온 정상 완료 — 응답이 **변경되지 않음** (대조군).
2. `output`이 빈 배열 + `output_item.done` 2개 — `output_index` 순서로 재조립.
3. `output_item.done`이 하나도 없이 빈 완료 — 빈 채로 통과 (지어내지 않음).

순서 검증에는 인덱스를 역순(1 먼저, 0 나중)으로 보내 정렬이 실제로 동작하는지 본다.

## 수용 기준

1. 빈 `output` + 수집된 항목 → `output_index` 오름차순으로 채워진다.
2. 비어있지 않은 `output` → 바이트 동일하게 통과한다.
3. 수집 항목이 없으면 재조립하지 않는다.
4. 잘못된 형태(`item`이 객체가 아님, `output_index`가 음수/비정수)는 수집되지 않는다.

### 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

이 분기는 기본 경로에서 절대 발화하지 않으므로 "테스트 전부 통과"로는 증명되지 않는다.
빈 `output`을 가진 완료 이벤트 픽스처를 실제로 인스펙터에 먹여 재조립된 배열을
**읽어서** 확인한다. 정상 픽스처(대조군)에서는 같은 코드가 응답을 바꾸지 않는 것도 같이
관측한다. 두 관측이 모두 있어야 이 유닛이 살아 있다고 말할 수 있다.

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/server/ -count=1
```

## 출처

동작 대조 대상: cli-proxy-api `internal/runtime/executor/codex_executor_terminal.go`
(HEAD `c9417c8`). 코드는 복사하지 않았다 — 우리 구현은 오라클 `relay.ts:476`의 계약을
따르며, cca는 "이 실패가 실재한다"는 두 번째 증인으로만 쓴다.
