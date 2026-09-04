# 088 — 롤아웃에서 스레드 필드 읽기 (wp8c2b3b2b1)

부모 유닛: `080_storage_safety.md` §080.3. 087(위성 커밋) 다음.

## 절단면을 뒤집은 이유 (리뷰 라운드 1 BLOCKER)

초안은 스레드 조정의 **스냅샷 경로만** 가져가고, 롤아웃 재구성이 필요한 엔트리는
"미포팅 오류"로 실패시키려 했다. 리뷰어가 그것을 divergence로 기각했고 맞다:
오라클은 그런 입력에서 **성공**하며, 더 나쁘게는 같은 트랜잭션 안의 정상 스냅샷까지
함께 무효화된다. "조용한 손실보다 시끄러운 실패가 낫다"는 옳지만, 그건 파리티가
아니다.

리뷰어가 준 선택지는 둘이었다: 재구성을 이 슬라이스에 포함하거나, 스레드 조정
전체를 재구성이 가능해질 때까지 미루거나. **후자를 택하되 순서를 뒤집는다** —
재구성이 의존하는 파서를 **먼저** 포팅하면, 다음 슬라이스가 스레드 조정 전체를
한 번에 닫을 수 있다.

## 이 슬라이스: `readThreadFieldsFromRollout`의 텍스트 파서

오라클은 `src/codex/history-provider.ts:348`에 있고 두 부분이다:

```
파일 읽기 + .zst 압축 해제   <- 아래 "미루는 것" 참조
parseThreadFieldsFromRolloutText  <- 이 슬라이스
```

### 왜 압축 해제를 미루는가

`rg -rn "zstd" go/`는 0건이고 `go.sum`에도 zstd 라이브러리가 없다. 압축 해제는 **새
외부 의존성**을 추가하는 결정이고, 그건 파서 포팅과 별개 사안이다. 순수 파서는
텍스트를 받으므로 그 결정 없이 완결된다.

평문 `.jsonl` 경로는 이 슬라이스로 완전히 동작하고, `.zst`만 남은 레거시 격리는
다음 슬라이스가 채운다.

## 오라클 (읽기 전용)

- `src/codex/history-provider.ts:375-410` — `parseThreadFieldsFromRolloutText`
- `src/codex/history-provider.ts:~336` — `parseSessionMetaLine`
- `src/codex/history-provider.ts:~300` — `extractUserMessagePreview`
- `src/codex/history-provider.ts:~280` — `textFromContentParts`
- `src/codex/history-provider.ts:14` — `MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES`

## 계약

### 1. 라인 스캔은 한 번에 두 가지를 찾는다

```
for (const line of raw.split("\n")) {
  if (!line) continue;
  if (line.includes("\"session_meta\"")) { ... latest = meta ... }
  if (!firstUserMessage) { ... preview ... }
}
```

- `session_meta`는 **마지막 것이 이긴다** (`latest`를 덮어쓴다). 오라클이 프로바이더
  변경을 새 `session_meta` 줄 **추가**로 기록하기 때문이다.
- 첫 사용자 메시지는 **처음 것이 이긴다** (`if (!firstUserMessage)`).
- `line.includes("\"session_meta\"")`는 **의미론의 일부이지 최적화가 아니다**
  (리뷰 라운드 2 MAJOR, 재현함). JSON은 타입 이름을 이스케이프로 쓸 수 있는데,
  그러면 원시 줄에는 그 문자열이 없다:

  ```
  {"type":"\u0073ession_meta","payload":{"id":"t1"}}
    원시 줄에 "session_meta" 포함 -> false
    JSON.parse(...).type          -> "session_meta"
    => 오라클은 이 줄을 무시한다
  ```

  따라서 Go도 `strings.Contains(line, "\"session_meta\"")`를 **어휘 검사로** 먼저
  하고, 통과한 줄만 파싱한다. 파싱 후 `type` 검사는 그 위에 추가로 있다.

### 2. `session_meta`가 하나도 없으면 nil

`latest`가 없으면 전체가 nil이다. 첫 사용자 메시지를 찾았어도 마찬가지다.

### 3. `payload.id`가 비면 nil

문자열이어야 하고 빈 문자열이면 안 된다.

### 4. 기본값이 있는 필드와 없는 필드

| 필드 | 규칙 |
| --- | --- |
| `modelProvider` | 문자열이고 비어있지 않으면 그 값, 아니면 `"openai"` |
| `source` | 같은 규칙, 기본값 `"cli"` |
| `firstUserMessage` | 스캔 결과. 없으면 `""` |
| `hasUserEvent` | `firstUserMessage.trim()`이 truthy면 1, 아니면 0 |
| `cwd` | 문자열일 때만 **존재**. 아니면 키 자체가 없다 |
| `historyMode` | 동일 |
| `cliVersion` | 동일 |

뒤 세 개는 조건부 스프레드라 **부재와 빈 문자열이 다르다.** Go에서는 `*string`으로
구분한다. 빈 문자열도 문자열이므로 **존재**한다 — `modelProvider`의 "비어있지 않아야
한다"와 규칙이 다르다.

### 5. 사용자 메시지 추출은 두 레코드 타입

`event_msg`:
- `payload.type === "user_message"` **또는** `payload.message`가 문자열일 때만 진입
- `payload.message`가 문자열이고 trim이 비어있지 않으면 그것
- 아니면 `payload.content`에서 텍스트
- 진입했지만 못 찾으면 **null을 반환하고 끝난다** (아래 `response_item`으로 안 감)

`response_item`:
- `payload.type === "message"` && `payload.role === "user"`일 때만
- `payload.content`에서 텍스트

그 외 타입은 null.

### 6. `textFromContentParts`

- 문자열이고 trim이 비어있지 않으면 그 trim된 값
- 배열이 아니면 null
- 배열이면 각 원소에서 `text` 우선, 없으면 `input_text`. **둘 다 trim 후 비어있지
  않아야** 채택
- `"\n"`으로 join한 뒤 trim. 비어있으면 null

**`text`가 있지만 공백뿐이면 `input_text`로 넘어간다** — `else if`가 아니라 조건이
trim 검사를 포함하기 때문이다.

## 구현 (diff 수준)

### 새 파일 `go/internal/codex/rollout_fields.go`

```
type RolloutThreadFields struct {
    ID               string
    ModelProvider    string
    Source           string
    FirstUserMessage string
    HasUserEvent     int
    CWD              *string   // nil은 "키 없음"
    HistoryMode      *string
    CLIVersion       *string
}

func ParseThreadFieldsFromRolloutText(raw string) *RolloutThreadFields
func parseSessionMetaPayload(line string) map[string]any
func extractUserMessagePreview(line string) string
func textFromContentParts(raw any) string
```

**JSON 디코딩에 `UseNumber`가 필요하다** (리뷰 라운드 2 MAJOR). 나는 "여기서는 숫자
의미론이 필요 없다"고 썼는데 틀렸다. 이 파서는 숫자 필드를 **해석하지 않지만**,
표준 디코드는 무관한 필드의 오버플로 숫자에서 **문서 전체를 거부**한다:

```
{"type":"session_meta","payload":{"id":"t1"},"junk":1e400}
  JSON.parse -> 정상, junk = Infinity, 파서는 무시
  json.Unmarshal -> UnmarshalTypeError => 유효한 메타 줄을 통째로 건너뛴다
```

086에서 `restore_pending.go`에 있던 것과 같은 결함이다. 지역 `json.Decoder` +
`UseNumber`를 쓰고 두 번째 디코드가 `io.EOF`인지 확인한다. 숫자를 해석할 필요는
없고 **어휘적으로 받아들이기만** 하면 된다.

**trim은 전용 헬퍼가 필요하다** (리뷰 라운드 2 MAJOR). `strings.TrimSpace`와 JS
`trim`은 **양방향으로** 다르다. 실측:

| 문자 | JS trim | Go TrimSpace |
| --- | --- | --- |
| `\uFEFF` | 자름 | **안 자름** |
| `\u0085` (NEL) | **안 자름** | 자름 |
| `\u00A0`, `\u2028` | 자름 | 자름 |
| `\u180E` | 안 자름 | 안 자름 |

결과: `\uFEFF`만 있는 메시지는 오라클에서 **없는 것**이지만 `TrimSpace` 포팅에서는
**있는 것**이 되고, NEL만 있는 메시지는 그 반대다. `hasUserEvent`가 뒤집힌다.

`jsTrim(s string) string`을 만든다: ECMAScript WhiteSpace + LineTerminator 집합
(`\t\n\v\f\r`, space, `\u00A0`, `\u1680`, `\u2000`-`\u200A`, `\u2028`, `\u2029`,
`\u202F`, `\u205F`, `\u3000`, `\uFEFF`)을 자르고 **NEL은 자르지 않는다**.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `session_meta` 한 줄 + 사용자 메시지 | 모든 필드 채워짐 |
| 2 | `session_meta` 두 줄 | **마지막** 것의 payload가 이김 |
| 3 | 사용자 메시지 두 줄 | **처음** 것이 이김 |
| 4 | `session_meta` 없음 | nil |
| 5 | `payload.id`가 빈 문자열 / 숫자 / 부재 | nil |
| 6 | `model_provider` 부재 / 빈 문자열 / 숫자 | `"openai"` |
| 7 | `source` 동일 | `"cli"` |
| 8 | `cwd`가 빈 문자열 | **존재**하고 값은 `""` |
| 9 | `cwd`가 숫자 / 부재 | nil (키 없음) |
| 10 | 사용자 메시지 없음 | `firstUserMessage=""`, `hasUserEvent=0` |
| 11 | 사용자 메시지가 공백뿐 | 스캔에서 채택되지 않아 `hasUserEvent=0` |
| 12 | `event_msg` + `message` 문자열 | 그 값 |
| 13 | `event_msg` + `type:"user_message"` + content 배열 | content에서 추출 |
| 14 | `event_msg`인데 진입 조건 불충족 | null, `response_item` 분기로 안 감 |
| 15 | `response_item` + `type:"message"` + `role:"user"` | content에서 추출 |
| 16 | `response_item`인데 role이 assistant | null |
| 17 | content 원소의 `text`가 공백뿐이고 `input_text`가 있음 | `input_text` 채택 |
| 18 | content 원소 여럿 | `\n`으로 join |
| 19 | 잘린 JSON 줄 | 그 줄만 건너뜀, 스캔 계속 |
| 20 | 빈 줄 | 건너뜀 |
| 21 | `{"type":"\u0073ession_meta",...}` (이스케이프된 타입) | **무시됨** — 어휘 prefilter가 의미론이다 |
| 22 | 무관한 필드에 `1e400`이 있는 유효한 메타 줄 | 정상 파싱 |
| 23 | 메시지가 `\uFEFF`만 | `hasUserEvent=0` (JS trim은 자른다) |
| 24 | 메시지가 `\u0085`(NEL)만 | `hasUserEvent=1` (JS trim은 **안** 자른다) |
| 25 | 유효 줄 뒤에 후행 JSON 값 | 그 줄은 파싱 실패로 건너뜀 |

## 검증

```
cd go && go build ./internal/codex/...
cd go && (umask 022; go test ./internal/codex/ -count=1)
```

**주의:** `internal/codex`는 동시 세션이 건드릴 수 있는 패키지다. 빌드가 깨지면
기다렸다 재시도하고, 내 파일만 커밋한다.

뮤테이션(최소 7): `session_meta`를 처음 것이 이기게, 사용자 메시지를 마지막 것이
이기게, `model_provider` 빈 문자열을 그대로 채택, `cwd` 부재와 빈 문자열을 동일 취급,
`text`가 공백일 때 `input_text`로 넘어가지 않기, 어휘 prefilter 제거,
`jsTrim`을 `strings.TrimSpace`로 교체.

**목록에서 뺀 것:** "`event_msg` 진입 실패 후 `response_item`으로 폴백"은 등가
뮤테이션이다(리뷰어 MINOR). `record.type`이 두 값을 동시에 가질 수 없으므로 return을
지워도 마지막 `null`에 도달한다. 대신 기준 14는 `event_msg` payload가
`response_item`처럼 생겼을 때 그것을 `response_item`으로 취급하지 **않는지**를
검증한다.

## 다음 슬라이스로 미루는 것

- `.zst` 메모리 내 압축 해제 (`MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES = 64MiB`). 새
  외부 의존성 결정이 필요하다.
- `reconstructThreadRowFromRollout`과 스레드 조정 전체. 이 파서가 있으면 한 번에
  닫을 수 있다.
