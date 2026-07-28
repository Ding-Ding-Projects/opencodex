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
