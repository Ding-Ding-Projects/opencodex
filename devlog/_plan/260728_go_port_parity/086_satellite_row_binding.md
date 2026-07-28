# 086 — 위성 백업 행 바인딩과 오라클의 BLOB 결함 (wp8c2b3b1)

부모 유닛: `080_storage_safety.md` §080.3. 085(마무리) 다음.

## 두 번의 정정 끝에 확정된 사실

이 항목은 세 번 다르게 판단됐다. 순서대로 남긴다.

**1차 (이전 사이클): `NEEDS_HUMAN`.** "Bun은 `{"0":0,...}`, Go는 base64. 두 표현이
호환되지 않으니 사용자 결정이 필요하다."

**2차 (085 리뷰어 + 나): 결정론적 코덱.** `SqlRow` 값 타입에 객체가 없으므로
"객체면 BLOB"이 유일한 해석이고, Go가 그 형식을 읽고 쓰면 끝. `src/**` 변경 없음.

**3차 (이번 리뷰어 + 재현): 둘 다 틀렸다.** 결정적 반례:

```
JSON.stringify({blob: new Uint8Array([0,255,16]))
  -> {"blob":{"0":0,"1":255,"2":16}}
JSON.parse(그 문자열).blob instanceof Uint8Array
  -> false   (constructor: Object)
```

**오라클은 자기가 쓴 BLOB을 자기가 복원하지 못한다.** `writeSatelliteBackup`
(`cleanup.ts:1015`)은 `JSON.stringify`를 쓰고 `readSatelliteBackupFile`
(`cleanup.ts:2190`)은 `JSON.parse`만 한다. TypeScript의 `SqlRow` 캐스트는 컴파일
타임 전용이라 런타임에 아무 되살림도 하지 않는다. 그 평범한 객체가
`insertRowsConflictIgnore`를 거쳐 `db.run`에 그대로 넘어가는데, `bun:sqlite`는
`null|number|bigint|string|Uint8Array`만 받는다.

즉 이것은 Go의 포팅 격차가 아니라 **TypeScript 쪽 잠재 결함**이다.

### 왜 아직 아무도 못 겪었나

`rg -n "BLOB" src/ --type ts`는 storage 경로에서 0건이다. 이 위성 테이블들
(`logs`, `stage1_outputs`, `jobs`, `thread_goals`, `thread_goal_continuation_deferrals`)에
BLOB 컬럼이 실제로 채워지는 경로가 확인되지 않는다. 결함이 잠복해 있는 이유다.

## 이 슬라이스가 하는 일 — 그리고 하지 않는 일

**하지 않는다:** BLOB 라운드트립을 "고치는" 것. 오라클을 고치려면 `src/**`를
건드려야 하는데 그것은 이 목표의 스코프 밖(읽기 전용 오라클)이다. Go만 고치면
오라클보다 "더 나은" divergence가 된다.

**거부하는 것도 고치는 것이다** (리뷰 라운드 2 BLOCKER). 내 2차 초안은 `[]byte`
인코딩을 오류로 만들었다. 그것을 "파리티"라고 불렀지만 아니다 — 오라클은 그 백업을
**성공적으로 쓰고** 나중에 복원에서 실패한다. Go가 쓰기 시점에 거부하면 정리
트랜잭션이 오라클보다 먼저 중단되는 관측 가능한 divergence다. 더 안전하지만 다르다.

따라서 **인코딩도 오라클대로 한다**: `[]byte` → `{"0":n,...}` 숫자 키 객체를 쓰고,
알려진 복원 실패를 그대로 안고 간다. 거부는 별도 승인이 필요한 교차 런타임 하드닝
과제이지 이 파리티 슬라이스의 일이 아니다.

**한다:** 오라클이 **실제로 하는 것**을 포팅한다. 즉 `JSON.parse` 결과를 그대로
바인딩에 넘긴다. Go에서 그 의미는:

| JSON | Go 바인딩 값 | 근거 |
| --- | --- | --- |
| `null` | `nil` | 직접 대응 |
| 문자열 | `string` | 직접 대응 |
| 숫자 | `float64` | **JS는 하나의 number 타입뿐이다** |
| 객체 | **바인딩 실패** | 오라클도 여기서 실패한다 |
| 배열 / 불리언 | 바인딩 실패 | 동일 |

읽기/바인딩 쪽에서 객체가 실패하는 것은 오라클과 **같은** 동작이다(평범한 객체를
`db.run`에 넘기면 드라이버가 거부한다). 쓰기 쪽은 위에서 정정한 대로 오라클과 같이
**성공**한다. 비대칭으로 보이지만 그것이 오라클의 실제 모양이다.

**숫자는 항상 `float64`다** (리뷰어 MAJOR, 내 초안이 틀렸음). 초안은 JSON 표기에
`.`이나 `e`가 없으면 `int64`로 바인딩하자고 했는데, 오라클은 `1`, `1.0`, `1e0`을
**구분할 수 없다** — `JSON.parse`가 셋 다 같은 JS number를 낸다. 표기로 SQL 타입을
정하면 오라클에 없는 구분을 만들어낸다. `float64` 하나로 간다.

**객체를 만나면 실패한다.** 오라클과 같은 지점에서 같은 이유로 실패하되, Go는
드라이버 오류 대신 명시적 오류를 낸다. 오류 문구에 "이것은 업스트림 결함"임을 적어
다음 사람이 Go 버그로 오해하지 않게 한다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:706` — `SqlRow` 값 타입 (컴파일 타임 전용)
- `src/storage/cleanup.ts:1005-1020` — `writeSatelliteBackup`, `JSON.stringify`
- `src/storage/cleanup.ts:2186-2200` — `readSatelliteBackupFile`, `JSON.parse`만
- `src/storage/cleanup.ts:797` — `insertRowsConflictIgnore`, 값을 그대로 바인딩
- `src/storage/cleanup.ts:2891` — 위성 커밋 호출 지점

## 계약

### 1. 비유한 숫자

`JSON.stringify`는 `NaN`/`±Infinity`를 `null`로 쓴다(실측). 따라서 백업 파일에
그 토큰은 나타날 수 없고, 읽기 쪽은 그냥 `null`을 본다. Go 인코더도 비유한 값을
`null`로 내야 오라클과 같다 — `json.Marshal`은 에러를 내므로 명시적으로 처리한다.

### 2. `bigint`와 큰 정수

`bigint`는 타입에는 있지만 `JSON.stringify`가 **던진다**(실측). 다만 그것이
"안전 정수 밖은 거부"를 뜻하지는 않는다(리뷰 라운드 2 MAJOR). JS `number`는 안전
정수가 아니어도 `JSON.stringify`가 그대로 쓴다. 실측:

```
9007199254740992  isSafeInteger=false  ->  {"n":9007199254740992}
9007199254740994  isSafeInteger=false  ->  {"n":9007199254740994}
1e17              isSafeInteger=false  ->  정확히 표현 가능
```

`MAX_SAFE_INTEGER` 기준으로 거부하면 오라클이 받아들이는 값을 거부한다. 올바른
기준은 **float64로 정확히 왕복되는가**이다: `int64(float64(v)) == v`이면 통과.
그렇지 않은 값(예: `2^53+1`)은 JSON 숫자로 쓰면 TypeScript가 다른 값으로 읽으므로
거부한다 — 이것은 오라클이 `bigint`에서 던지는 것과 대응하는 지점이다.

### 3. 위성 행은 검증하지 않는다

`isSqlRowArray`는 **state 스냅샷**(`threads`, `dynamicTools`, `spawnEdges`)에만
쓰인다(`cleanup.ts:2401-2466`). 위성 섹션의 행은 검증 없이
`insertRowsConflictIgnore`로 직행하고, 거기서 `for (const row of rows)`와
`Object.keys(row)`를 만난다.

2차 초안은 그것을 알면서도 `BindableBackupRows`가 배열이 아니면 오류를 내게 했다.
그것도 divergence다(리뷰 라운드 2 MAJOR). JS의 실제 동작을 실측했다:

```
rows = "x"  ->  for..of가 문자 "x"를 순회, Object.keys("x") = ["0"]
rows = {}   ->  TypeError: rows is not iterable
```

즉 문자열 행 목록은 **오류가 아니라** 각 문자를 행으로 취급하고, 컬럼 `"0"`이
스키마에 없으면 조용히 건너뛰며 트랜잭션이 커밋된다. 객체는 순회 불가로 던진다.

**이 슬라이스는 행 목록/행 모양을 검증하지 않는다.** 배열이면 원소를 순회하고,
문자열이면 순회하며, 그 외 비순회 값은 오류다. JSON에서 올 수 있는 순회 가능 값은
배열과 문자열 **둘뿐**이므로 일반적인 iterable 추상을 만들지 않는다.

**타입이 계약을 감당해야 한다** (리뷰 라운드 3 MAJOR). 2차 초안은 여전히
`BindableBackupRows(...) ([]SqlRow, error)`를 반환했는데, 문자열 행은 `SqlRow`가
아니므로 그 타입으로는 `"x"`를 소비자에게 전달할 수 없다. 계약을 지키려면
**`[]any`(원시 행)**를 반환하고, 컬럼 추출은 087의 삽입 소비자가
`Object.keys` 의미론으로 처리해야 한다.

**UTF-16 함정.** `for..of`는 룬 단위지만 `Object.keys`는 UTF-16 코드 유닛 단위다.
실측:

```
rows = "💩"
  for..of item: "💩"        (룬 하나)
  Object.keys(그 item): ["0","1"]   (코드 유닛 둘)
```

즉 Go가 `range`(룬)로 순회하고 컬럼 키를 룬 인덱스로 매기면 오라클과 달라진다.
**행 순회는 룬 단위, 컬럼 키는 UTF-16 코드 유닛 단위**다. 기준 9에 비-BMP 문자를
넣어야 룬 기반과 바이트 기반 구현을 모두 잡아낸다 — `"x"` 하나로는 못 잡는다.

이 UTF-16 세부는 087이 실제로 컬럼을 뽑을 때 필요하다. 이 슬라이스는 원시 행을
**그대로 넘기는 것**까지만 책임지고, 그 사실을 087 계약에 명시한다.

### 3b. 고아 서로게이트는 이 슬라이스가 고칠 수 없다 (범위 명시)

리뷰 라운드 4가 실제 mismatch를 찾았고 재현했다:

```
{"v":"\ud800"}
  JS  -> length 1, code d800        (보존)
  Go  -> "\ufffd", bytes ef bf bd   (치환)
```

Go의 `encoding/json`은 짝 없는 서로게이트를 U+FFFD로 바꾼다. 따라서 그 값은
`IterateBackupRows`나 087의 컬럼 추출기가 보기 **전에** 이미 손실된다.

**이것은 이 슬라이스가 만든 격차가 아니다.** `decodeSingleJSONDocument`를 쓰는 모든
포팅 파서 — `restore_pending.go`, `restore_manifest.go`, `satellite_read.go` — 가
같은 치환을 겪는다. 즉 pending 마커의 `acceptedDestRels`, manifest의 `relPath`,
백업의 모든 문자열이 동일하게 영향받는다.

**결정: 이 슬라이스의 파리티 계약을 well-formed 유니코드로 한정하고, 고아 서로게이트
divergence를 wp12 수렴으로 올린다.** 근거:

- 여기서 커스텀 JSON 문자열 파서를 도입하면 이 슬라이스만 다른 디코더를 쓰게 되어
  나머지 파서들과 불일치가 생긴다. 그건 더 나쁘다.
- 제대로 고치려면 `decodeSingleJSONDocument` 자체를 UTF-16 보존형으로 바꿔야 하고,
  그 변경은 이미 커밋된 세 파서의 동작을 모두 건드린다. 수렴 사이클의 일이다.
- 실제 도달 가능성은 낮다: 이 경로의 문자열은 파일 경로, 스레드 ID, SQL 컬럼 값이고
  고아 서로게이트를 담으려면 상류가 이미 손상돼 있어야 한다.

기준 9c는 well-formed 비-BMP(`💩`)를 검증하고, 고아 서로게이트는 **알려진
divergence로 문서화**하되 테스트로 고정하지 않는다 — 지금 고정하면 wp12가 고칠 때
테스트를 뒤집어야 한다.

### 4. 키 순서는 의미가 없다

Go의 `json.Marshal`은 맵 키를 사전순으로 정렬하므로 12바이트 BLOB은
`"0","1","10","11","2",...` 순으로 나간다. 오라클은 `0..11` 순이다. **디코더가 키
집합만 보므로 의미 차이는 없지만**, "Bun 형식 그대로"라는 표현은 부정확하다.
어차피 이 슬라이스는 BLOB을 쓰지 않으므로(§위) 해당 없음.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/rowbind.go`

```
// 백업에서 읽은 JSON 값을 SQL 바인딩 값으로 바꾼다.
// 오라클이 실패하는 입력에서 같이 실패한다.
func BindableBackupValue(raw any) (any, error)
// 행 목록을 오라클의 for..of와 같은 단위로 순회해 원시 행을 돌려준다.
// []SqlRow가 아니라 []any인 이유: 문자열 행 목록의 원소는 SqlRow가 아니다.
func IterateBackupRows(raw any) ([]any, error)

// SQL 값을 백업 JSON 값으로 바꾼다. 오라클이 쓸 수 없는 값은 거부한다.
func BackupJSONValue(value any) (any, error)
```

`errBackupObjectValue`: "a JSON object in a row value cannot be bound; the
TypeScript runtime cannot revive its own Uint8Array serialization either
(cleanup.ts:1015 writes JSON.stringify, 2190 reads JSON.parse), so this is an
upstream defect rather than a porting gap".

### `go/internal/storage/sqlrows.go` 주석 수정

현재 주석은 "태그된 코덱이 양쪽에 필요하다"고 결론짓는다. 전제는 맞지만 결론이
불완전하다 — 진짜 문제는 형식 선택이 아니라 **TypeScript가 되살리지 않는다**는
것이다. 실측 근거와 함께 교체한다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `null` / 문자열 | `nil` / `string` |
| 2 | `1` / `1.0` / `1e0` | **셋 다 `float64(1)`** — 오라클은 구분하지 못한다 |
| 3 | `-0` | `float64` 음의 0 |
| 4 | `1e400` | 값은 `+Inf`. 바인딩 전용이므로 그대로 통과 |
| 5 | `{"0":0,"1":255}` | **바인딩 오류**, 오류 문구에 업스트림 결함 언급 |
| 6 | `{}` | 바인딩 오류 (빈 객체도 되살려지지 않는다) |
| 7 | 배열 / 불리언 | 바인딩 오류 |
| 8 | 행 목록이 배열 | 원소를 순회 |
| 9 | 행 목록이 문자열 `"x"` | **오류가 아니라** `"x"` 하나를 행으로 순회 |
| 9c | 행 목록이 `"💩"` (비-BMP) | 룬 하나를 행으로 순회. 룬 기반과 바이트 기반 구현을 구분한다 |
| 9d | `IterateBackupRows`의 반환 타입 | `[]any` — 문자열 행이 손실 없이 전달됨 |
| 9b | 행 목록이 객체 `{}` | 순회 불가 오류 (JS TypeError에 대응) |
| 10 | `nil`/`string`/`float64` 인코드 | 자연스러운 JSON |
| 11 | `math.NaN()` / `±Inf` 인코드 | `null` — `JSON.stringify`와 동일 |
| 12 | `int64(2^53)` / `int64(1e17)` 인코드 | **성공** — float64로 정확히 왕복된다 |
| 12b | `int64(2^53+1)` 인코드 | 오류 — float64 왕복이 값을 바꾼다 |
| 13 | `int64(42)` 인코드 | JSON 숫자 42 |
| 14 | `[]byte{0,255,16}` 인코드 | `{"0":0,"1":255,"2":16}` — 오라클과 동일하게 **쓴다**. 알려진 복원 실패는 업스트림 결함으로 남긴다 |
| 14b | `[]byte{}` 인코드 | `{}` |
| 15 | Node가 쓴 실제 문자열로 왕복 | `null`/문자열/숫자가 정확히 복원 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 5): 숫자를 표기로 int64/float64 분기, 객체를 바이트로 수락(바인딩),
비유한 값을 `null` 대신 그대로, float64 왕복 검사를 `MAX_SAFE_INTEGER` 비교로 교체,
`[]byte` 인코딩을 base64로.

## 기록해야 할 것

오라클의 BLOB 결함을 goalplan 원장에 **업스트림 이슈**로 남긴다. `NEEDS_HUMAN`이
아니다 — Go가 할 일은 없고, `src/**` 수정은 이 목표의 스코프 밖이다. 사용자가
opencodex 업스트림에 별도로 다룰 사안이다.

087 계약에 명시할 것: 원시 행에서 컬럼을 뽑을 때 **UTF-16 코드 유닛** 인덱스를
키로 쓴다. Go의 룬 인덱스를 쓰면 비-BMP 문자에서 오라클과 갈린다.

wp12 수렴으로 올릴 것: `decodeSingleJSONDocument`가 짝 없는 서로게이트를 U+FFFD로
치환한다. 이미 커밋된 `restore_pending.go`/`restore_manifest.go`/`satellite_read.go`가
모두 영향받으므로 개별 슬라이스가 아니라 수렴에서 한 번에 다뤄야 한다.
