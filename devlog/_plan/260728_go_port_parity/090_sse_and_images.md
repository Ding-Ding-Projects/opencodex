# 090 — wp9: SSE 재작성 + 이미지 브리지

work-phase: `wp9a`~`wp9b` (2개 하위 슬라이스, 090.1 → 090.2) · 선행: 없음 · 순서 정본: `006`

## 090.1 SSE 페이로드 재작성 (기반)

### 왜 이것이 먼저인가

이미지 네임스페이스 복원과 item-ID 수리가 **같은 프레이밍 소유자 안에서 한 번에** 일어나야
한다. 래퍼를 두 개 쓰면 각각 같은 이벤트를 파싱·직렬화·재프레이밍하므로 이중 프레이밍이
생긴다(`src/server/responses/core.ts:1700`). 따라서 재작성 기반이 이미지보다 먼저다.

### 오라클 계약

`relaySseWithPayloadRewrite(body, rewrite)`(`src/server/sse-payload-rewrite.ts:8`):

- 완전한 SSE 블록까지만 버퍼링한다
- 이어붙인 `data:` 줄을 추출해 **합성된 재작성 함수 하나**를 호출한다
- 바뀐 경우에만 첫 data 줄을 교체한다
- 비-data 필드(`id`, `event`, 주석), 원래 이벤트 구분자, CRLF/LF 스타일을 보존한다
- 종료되지 않은 마지막 블록을 flush한다
- 취소를 상류로 전파한다

공개 표면: `SsePayloadRewrite`, `nextSseBlock`, `sseDataPayload`, `replaceSseDataPayload`,
`composeSsePayloadRewrites`, `relaySseWithPayloadRewrite`. 합성은 좌→우이며 변환이 0개면
항등이다.

### Go 변경

- `go/internal/protocol/sse.go`에 원시·프레이밍 보존 릴레이 추가:
  `type SsePayloadRewrite func(string) string`, `ComposeSSEPayloadRewrites(...)`,
  `RelaySSEWithPayloadRewrite(io.Reader, SsePayloadRewrite) io.ReadCloser`.
- `go/internal/server/repair.go:51`의 item-ID 전용 스캐너 래퍼를 **두 번째 스트림 래퍼가
  아니라 페이로드 재작성 함수**로 리팩터링.
- 릴레이를 `ResponsesCore.stream`의 `body := io.Reader(response.Body)` 직후,
  `RelaySSE` 직전 eager/native 분기에 **한 번만** 삽입(`responses_core_port.go:603`).

**중요한 함정:** 복원된 클라이언트 별칭을 `eventsForResponse`에 적용하면 안 된다. 그 분기는
파싱·검사·재생을 먹이므로 상류 안전 이름을 유지해야 한다(`src/server/responses-image-gen-repair.ts:108`).

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 청크 분할 | 이벤트 경계가 보존됨 |
| 2 | 다중 줄 data | 첫 줄만 교체 |
| 3 | `id`/`event`/주석 포함 | 비-data 필드 보존 |
| 4 | CRLF 입력 | CRLF 유지 |
| 5 | 종료되지 않은 마지막 이벤트 | flush됨 |
| 6 | 잘못된 JSON | 변경 없이 통과 |
| 7 | 재작성 2개 합성, 업스트림 3이벤트 | 각 재작성이 정확히 3회 호출, 구분자 **정확히 1개** |
| 8 | 재작성 0개 | 바이트 동일 통과 |

7번이 이중 프레이밍 회귀를 잡는 핵심 단언이다.

**감사 B6 정정:** 처음에는 "스트리밍 응답에서 이미지 복원 + ID 수리" 기준을 여기 두었으나,
이미지 복원은 `090.2`에 와야 존재한다. 그 통합 단언은 `090.2`로 옮겼다. 이 슬라이스는
**릴레이 원시요소와 기존 item-ID 재작성**만으로 검증 가능한 범위에 머문다.

## 090.2 이미지 브리지

**보안 경계.** 아티팩트 저장과 URL 가져오기는 SSRF 표면이다.

### 네임스페이스 계약

API 키 Responses에서 유효한 `image_gen` 네임스페이스나 점 표기 별칭을 평면
`image_gen__<name>` 함수로 낮춘다. 재생된 호출과 tool-choice 선택자도 같은 와이어 별칭을
쓴다. 사용 가능한 별칭이 생기면 충돌하는 호스티드 `image_generation` 선언을 제거한다.
클라이언트 응답 분기에서는 함수 호출을 재귀적으로 `{namespace:"image_gen", name:<local>}`로
복원한다(JSON·SSE 양쪽). forward-auth OpenAI는 비공개 네임스페이스를 그대로 둔다.

### 경계 있는 에이전트 루프

진입 조건 전부 충족 시에만: 옵트인(`images.bridgeEnabled=true`), 비-OpenAI 라우팅,
**스트리밍**, 호스티드 이미지 도구 선언, API 키 가능한 xAI 프로바이더. 비스트리밍은 거부.

각 반복: 합성 `image_gen` 치환 → 모델 반복 버퍼링 → 이미지 전용 호출 가로채기 → 충족 →
어시스턴트/도구 결과 연속 1개 추가 → 반복.

종료 조건: 이미지 호출 없음, 실제 도구 호출, 강제 최종 라운드, 스트림/프로토콜 실패, 취소,
예산 소진.

**상한: 기본 3라운드, 최대 10.** 따라서 상류 턴은 최대 `maxRounds + 1`, 유료 이미지 호출은
최대 10회.

### SSRF 통제 (보안)

- 아티팩트는 설정 `artifacts/` 아래, **배타 생성 `0600`**, 불투명 파일명.
  노출은 `/v1/opencodex/artifacts/<opaque-id>`로만. 경로 순회·비파일 거부.
- 반환 이미지 URL은 `data:` base64 또는 **HTTPS만** 허용.
- 차단 대상: 비공개 목적지, private/loopback/link-local/메타데이터 주소, 안전하지 않은 DNS
  응답, 리다이렉트, 비-2xx, 빈/비이미지 본문, 초과 크기, **DNS 리바인딩**.
- 연결은 검증된 **고정 주소**로 하되 TLS/SNI용 호스트명은 유지한다. 이 분리가 리바인딩
  방어의 핵심이다.

### Gemini 인라인 경로

사용 가능한 OpenAI 이미지 사이드카가 없을 때 `POST /v1/images/generations`가 로그인된 Google
Antigravity를 쓸 수 있다. OAuth 인증을 보내기 **전에** 레지스트리 CCA 엔드포인트를 고정하고,
`["TEXT","IMAGE"]`를 요청하며, 인라인 base64 + 이미지 매직바이트를 검증하고, OpenAI 형태
`{created, data:[{b64_json}]}`만 반환한다. 안전 차단은 재시도 불가 400으로 사상한다.

**설정 가능한 가변 base URL을 OAuth 자격증명 전송에 재사용하지 말 것** — 고정 엔드포인트를 쓴다.

### Go 변경

`go/internal/images/{plan,loop,fulfill,artifacts,xai_client}.go` 신규,
`go/internal/server/images.go` 신규, `server.go:392`의 이미지 `handleSidecar`를 전체
선택/릴레이/폴백 핸들러로 교체, Responses 살균기에 네임스페이스 낮춤/복원 추가
(090.1의 릴레이 사용).

### 수용 기준 (발췌)

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 옵트인 off | 브리지 미진입, 기존 동작 |
| 2 | 비스트리밍 요청 | 거부 |
| 3 | 라운드 상한 도달 | 상류 턴 ≤ `maxRounds+1` |
| 4 | 실제 도구 호출 등장 | 즉시 종료 |
| 5 | 취소 | 진행 중 작업 중단, 유료 호출 추가 없음 |
| 6 | `http://` URL | 거부 |
| 7 | 사설/루프백/메타데이터 IP로 해석되는 호스트 | 거부 |
| 8 | DNS 리바인딩(검증 후 IP 변경) | 고정 주소 사용으로 차단 |
| 9 | 리다이렉트 응답 | 거부 |
| 10 | 비이미지 본문 | 거부 |
| 11 | 아티팩트 경로 순회 시도 | 거부 |
| 12 | Gemini 안전 차단 | 재시도 불가 400 |
| 13 | 합성 호출 | 클라이언트에 노출되지 않음 |
| 14 | 스트리밍 응답에서 이미지 복원 + ID 수리 | 같은 클라이언트 이벤트에 둘 다 적용, 어댑터 분기는 원시 별칭 수신 (090.1에서 이동) |

## 스코프 경계

IN: `go/internal/protocol/sse.go`, `go/internal/server/repair.go`,
`responses_core_port.go` 삽입점, `go/internal/images/**`, `go/internal/server/images.go`.
OUT: `src/**`, 실제 유료 이미지 호출(테스트는 스텁 사용).

## 090.3 브리지 루프 드라이버 (wp9b-driver)

090.2에서 활성화·충족·SSRF·아티팩트는 모두 포팅됐지만 **그것들을 순서대로 돌리는 주체가
없다.** `FulfillImageCall`은 호출 한 건만 처리하고, 어댑터 이벤트를 훑어 이미지 호출을
골라내는 스캐너와 라운드를 도는 드라이버가 Go 쪽에 통째로 빠져 있다. 이 슬라이스가 그
구멍을 메운다.

### 오라클을 읽지 않고 실행해서 측정한 사실

`tests/`에 임시 프로브를 넣어 `runWithImageBridge`를 실제로 돌린 결과다. 읽기만 해서는
틀리기 쉬운 것들이 섞여 있다.

| 입력 | 실측 결과 |
| --- | --- |
| `tool_call_end` 없이 두 번째 `tool_call_start`가 옴 | 앞의 호출이 flush돼 **둘 다** 충족된다 |
| 같은 턴에 이미지 호출 + 실제 도구 호출 | 이미지 호출은 **충족되지 않고 버려지며**, 실제 호출만 클라이언트로 간다 |
| `tool_call_start` 없는 고아 `tool_call_delta` | 버려지고 나머지는 통과한다 |
| 끝나지 않은 이미지 호출이 스트림 끝에 남음 | 버퍼된 인자로 그대로 충족된다 |
| `maxRounds: 0` | 유료 호출 0건, 첫 턴이 곧 최종 턴 |

두 번째 줄이 이 슬라이스의 핵심 계약이다. 실제 도구 호출이 섞이면 그 턴은 Codex 기준으로
종결이므로, 이미지 호출을 충족하면 클라이언트가 볼 수 없는 유료 호출이 된다.

### Go 변경

`go/internal/images/bridge.go` 신규:

- `ScanImageCalls(events, toolNames) (calls, passthrough, hasRealToolCall)` — 위 표의 다섯
  가지를 그대로 재현한다. 이미지 호출의 start/delta/end는 passthrough에서 제거되고, 그
  외 이벤트는 순서를 유지한다.
- `ExtractIterationThinking(events)` — thinking/서명/redacted 블록을 순서와 블록별 서명을
  유지한 채 모은다. 여러 블록을 하나로 합치면 Anthropic 확장 사고 재생이 400난다.
- `Bridge.Run(ctx, request, adapter)` — `maxRounds+1` 하드캡, `i >= maxRounds`이면
  forced-final(플랜이 아는 모든 별칭을 도구 목록에서 제거), 턴당 유료 호출 10건 상한,
  충족 후 어시스턴트 1개 + toolResult n개를 `search.appendSearchExchange`와 같은 모양으로
  주입한다.

`internal/search/loop.go`의 `Loop`와 같은 형태(주입된 `Runner`, 이벤트 반환)로 맞춘다.
뒤이을 chat 핸들러 배선이 `runSearch` 옆에 그대로 들어가게 하기 위해서다.

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 이미지 호출만 있는 턴 | 충족 후 다음 라운드로, 합성 호출은 passthrough에 없음 |
| 2 | 실제 도구 호출 동반 | 유료 호출 0건, 실제 호출은 통과, 루프 종료 |
| 3 | 미종결 호출 | 버퍼된 인자로 충족 |
| 4 | 고아 delta | 무시, 나머지 통과 |
| 5 | `maxRounds` 소진 | 상류 턴 ≤ `maxRounds+1`, 마지막 턴은 별칭 제거된 도구 목록 |
| 6 | 턴당 10건 초과 | 초과분은 예산 소진 오류 결과, 유료 호출 없음 |
| 7 | 취소 | 진행 중 중단, 추가 유료 호출 없음 |

## 090.4 프로덕션 배선 (wp9b-wire)

> **정정 (측정 후).** 이 절은 처음에 배선 지점을 `internal/chat/`으로 잡았다. 틀렸다.
> `internal/chat/inbound.go`의 `parseChatTools`는 `ImageGeneration`을 **아예 채우지
> 않는다.** 오라클도 마찬가지라서 `_imageGeneration`은 `src/responses/parser.ts:638`
> 한 곳에서만 설정된다. Go에서 그 자리는 이름과 달리 Responses 파서인
> `internal/claude/parser.go:334`이고, 그 파서를 부르는 것은
> `internal/server/responses_core_port.go`다. chat 표면에 건 배선은 손으로 만든 테스트
> 요청에서만 동작하는 죽은 코드였다. 아래는 실제 위치로 다시 쓴 계획이다.

090.2와 090.3이 끝나도 **아무도 브리지를 부르지 않는다.** 이 포팅에서 "구현은 끝났는데
호출자가 없는" 패턴이 나온 것은 이번이 여섯 번째다. 그래서 이 슬라이스의 수용 기준에는
동작뿐 아니라 **호출 지점이 사라지면 시끄럽게 깨지는 테스트**가 포함된다.

### 오라클의 디스패치 규칙

`src/server/responses/core.ts:1758` 부근:

- 라우팅된 compaction 턴은 브리지에 **들어가지 않는다**. compaction이 tools/_webSearch는
  비우지만 `_imageGeneration`은 남기므로, 그대로 두면 Codex가 기대하는 합성 compaction
  아이템 대신 평범한 완료가 돌아간다(#424).
- 웹서치와 이미지가 둘 다 자격을 갖추면 **웹서치가 이긴다**. 단 `adapter.runTurn`이 있는
  어댑터(Cursor)에서는 웹서치 루프가 buildRequest/fetch/parseStream만 지원하므로 건너뛰고
  이미지 브리지가 돌 수 있다.
- 비스트리밍 요청은 400으로 거부한다. 브리지는 내부적으로 stream을 강제하고 SSE를
  반환하므로, JSON을 기대하는 클라이언트에 SSE를 줄 수는 없다.
- 기존 `image_gen` 별칭 도구는 **교체**하지 중복 추가하지 않는다.
- 호스티드 `image_generation`을 겨냥한 tool_choice/allowed_tools는 합성 함수 이름으로
  다시 매핑한다.

### Go 변경 (정정본)

- 배선 지점은 `internal/server/responses_core_port.go`, `core.forward` **직전**이다.
  forward 뒤에 두면 이미 원치 않는 유료 상류 요청이 나간 뒤가 된다.
- 구조 분리가 선행되어야 한다. 지금 `forward`는 auth/transport/adapter 준비와 전송을
  한 함수에서 한다. 브리지는 **준비된 어댑터를 전송 전에** 받아야 하므로 그 둘을 분리해야
  한다.
- compaction 제외는 `CompactionBoundary`가 아니라 `CompactionRequest`
  **및** `providers.IsCanonicalOpenAiForwardProvider`로 판정한다. 오라클 조건은
  `_compactionRequest && !isCanonicalOpenAiForwardProvider(route.provider)`이고,
  `CompactionBoundary`는 Cursor 컨텍스트 리셋 신호로 성격이 다르다.
- 턴 러너는 chat의 `routedTurnRunner`를 가져오지 않는다. Responses 코어가 이미 자기
  복구 경로를 갖고 있다(combo 실패조치는 `forward`, Cursor continuity 재시도는 `buffered`와
  `stream`). chat 추상화를 끌어오면 `chat.preparedRequest`까지 따라와야 한다.
- 비스트리밍 요청은 브리지 실행 **전에** `400 image bridge requires stream=true`로 거부한다.
  chat 경로처럼 내부적으로 stream을 켜는 것은 관측 가능한 계약이 다르다.
- `internal/cli/serve.go`에서 의존성을 조립하고,
  `config.ImagesConfig.MaxRounds`(*int)와 `images.ClampImageMaxRounds`(*float64)의 타입
  불일치를 `images.ResolveMaxRounds`로 해소한다.

**선행 갭:** Go의 `types.Adapter`에는 `runTurn`이 없다. 오라클의
`imgPlan && (!wsPlan || adapter.runTurn)` 우선순위는 그대로 옮길 수 없으므로, 등가 조건을
먼저 정의해야 웹서치/이미지 우선순위 패리티를 주장할 수 있다.

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 옵트인 off | 브리지 미진입, 기존 경로 그대로 |
| 2 | 호스티드 이미지 도구 선언 + 옵트인 on + xAI 키 | 브리지가 실제로 돈다 |
| 3 | 웹서치와 동시 자격 | 웹서치 우선 |
| 4 | 호출 지점 삭제 | 테스트가 깨진다(소스 수준 단언) |
| 5 | 설정 maxRounds | 루프에 실제로 전달됨(타입 불일치 해소 증명) |
| 6 | 비스트리밍 요청 | 브리지 실행 전 400 |
| 7 | 라우팅된 compaction 턴 | 브리지 미진입 |
| 8 | OpenAI 네이티브 라우팅 | 브리지 미진입 |
