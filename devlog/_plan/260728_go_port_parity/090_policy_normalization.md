# 090 — 정리 정책 정규화 (wp8d1)

부모 유닛: `080_storage_safety.md` §080.4. 089(스레드 조정) 다음.

## 절단면

§080.4는 세 덩어리다:

```
정책 스키마 정규화 + 기본값 + PUT 병합   <- 이 슬라이스
due 판정과 단일 비행 작업                 <- 091
스케줄러와 종료 소유권                     <- 092
```

정규화 자체는 순수 함수이고 나머지가 전부 그 위에 선다. **PUT 병합도 이 슬라이스가
가져간다** — 초안은 제목에만 적고 API에서 빠뜨렸는데, 그러면 나중 서버 작업이 잘못된
PUT 본문을 거부할 오라클 등가물 없이 `Normalize`만 쓰게 되고, TypeScript 엔드포인트가
거부하는 입력을 받아들인다(리뷰 라운드 1 BLOCKER).

PUT 병합은 `Date.now()`를 쓰므로 순수하지 않다. **시계를 인자로 받는다.**

## 오라클 (읽기 전용)

- `src/storage/policy.ts:76-85` — `defaultStorageCleanupPolicy`
- `src/storage/policy.ts:87-93` — `isFiniteNonNegInt`, `isFinitePositiveInt`
- `src/storage/policy.ts:95-105` — `isValidPolicyTarget`
- `src/storage/policy.ts:111-178` — `normalizeStorageCleanupPolicy`
- `src/storage/policy.ts:185-256` — `parseStorageCleanupPolicyInput`
- `src/server/management/logs-usage-routes.ts:447-465` — 호출 지점
- `src/types.ts:470` — `StorageCleanupPolicy`

## 계약

### 1. 기본값은 항상 비활성

```
enabled: false
trigger: { archivedBytesOver: 5 GiB }
target:  { removeOldestPercent: 25 }
schedule: "manual"
mode: "quarantine"
```

최상위가 객체가 아니면(배열 포함) **기본값 그대로** 반환한다.

### 2. `enabled`는 명시적 `true`만

`o.enabled === true`. 문자열 `"true"`도, `1`도 아니다. 그리고 **아래 target 규칙이
이것을 다시 끌 수 있다.**

### 3. target이 fail-closed의 핵심이다

```
"target" 키가 없으면            -> 기본값 유지, enabled 그대로
target이 객체가 아니면          -> enabled = false
target이 객체지만 무효면        -> enabled = false
target이 유효하면               -> 채택
```

**손상된 영속 target이 조용히 "오래된 25% 삭제"로 폴백하면 안 된다.** 그건 사용자가
설정한 적 없는 삭제 정책이다. 그래서 정책 자체를 끈다.

`isValidPolicyTarget`: `reduceToBytes`와 `removeOldestPercent` 중 **정확히 하나**가
`undefined`가 아니어야 한다. 둘 다 있거나 둘 다 없으면 무효.

- `reduceToBytes`: 유한한 음이 아닌 **정수**
- `removeOldestPercent`: 유한하고 `(0, 100]`. **정수일 필요는 없다**

**주의:** 검증은 정수를 요구하지 않는데 채택할 때는
`Math.min(100, Math.max(1, Math.floor(percent)))`를 적용한다. 즉 `0.5`는 **유효하고**
`floor` 후 `max(1,...)`에 걸려 **1**이 된다. `99.9`는 `99`가 된다.

### 4. trigger는 fail-closed가 아니다

`archivedBytesOver`가 무효면 그냥 **기본값을 쓴다.** target과 다르다 — trigger가
잘못돼도 삭제 범위가 넓어지지 않기 때문이다.

`trigger` 자체가 객체가 아니어도 기본값이고 `enabled`에 영향이 없다.

### 5. schedule과 mode

schedule은 네 리터럴 중 하나가 아니면 기본값 `"manual"`.
mode는 **`"permanent"`일 때만** permanent, 그 외 전부 `"quarantine"`. 영구 삭제는
명시적으로만 켜진다.

### 6. lastRun은 전부 아니면 전무

세 필드가 모두 유효해야 채택한다. 하나라도 어긋나면 `lastRun` 자체가 **없다**.
`at`은 양의 정수, `freedBytes`와 `removed`는 음이 아닌 정수.

### 7. nextRun

`undefined`나 `null`이면 없음. 양의 정수면 채택. 그 외(0, 음수, 소수, 문자열)는
**없음**이 된다 — `else if`에 걸리지 않으면 변수가 초기값 `undefined`로 남는다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/policy.go`

```
type PolicySchedule string  // startup | daily | weekly | manual

type PolicyTarget struct {
    ReduceToBytes      *float64
    RemoveOldestPercent *float64
}
type PolicyLastRun struct {
    At         float64
    FreedBytes float64
    Removed    float64
}
type StorageCleanupPolicy struct {
    Enabled  bool
    Trigger  PolicyTrigger
    Target   PolicyTarget
    Schedule PolicySchedule
    Mode     string
    LastRun  *PolicyLastRun
    NextRun  *float64
}

type PolicyTrigger struct {
    ArchivedBytesOver float64 `json:"archivedBytesOver"`
}

func DefaultStorageCleanupPolicy() StorageCleanupPolicy
func IsValidPolicyTarget(raw any) bool
func NormalizeStorageCleanupPolicy(raw any) StorageCleanupPolicy

// PUT 병합. now는 주입한다 — computeNextRun이 시계를 쓴다.
func ParseStorageCleanupPolicyInput(raw any, previous *StorageCleanupPolicy,
    nowMS float64) (StorageCleanupPolicy, string)
```

`PolicyTrigger`를 빠뜨렸던 것을 보완한다(리뷰 라운드 1 BLOCKER — 제안한 API가
컴파일되지 않았다).

**JSON 태그가 전 필드에 필요하다** (리뷰 라운드 1 MAJOR). Go 기본값은 필드 이름을
그대로 키로 쓰므로 `Enabled`, `Trigger`가 나가고 TypeScript는 `enabled` 키를 못 찾아
정책을 비활성으로 정규화한다. `lastRun`과 `nextRun`은 없을 때 **키 자체가 빠져야**
하므로 `omitempty` + 포인터다.

```
Enabled  bool          `json:"enabled"`
Trigger  PolicyTrigger `json:"trigger"`
Target   PolicyTarget  `json:"target"`
Schedule PolicySchedule `json:"schedule"`
Mode     string         `json:"mode"`
LastRun  *PolicyLastRun `json:"lastRun,omitempty"`
NextRun  *float64       `json:"nextRun,omitempty"`
```

`PolicyTarget`의 두 필드도 포인터 + `omitempty`다 — 오라클은 둘 중 하나만 내보낸다.

**중첩 구조체도 전부 태그가 필요하다** (리뷰 라운드 2 MAJOR). 초안은 바깥 정책만
적었는데, 그러면 `RemoveOldestPercent`, `At`, `FreedBytes`, `Removed`가 그대로 키가
된다:

```
PolicyTarget:
  ReduceToBytes       *float64 `json:"reduceToBytes,omitempty"`
  RemoveOldestPercent *float64 `json:"removeOldestPercent,omitempty"`

PolicyLastRun:
  At         float64 `json:"at"`
  FreedBytes float64 `json:"freedBytes"`
  Removed    float64 `json:"removed"`
```

### null은 부재가 아니다 (리뷰 라운드 2 MAJOR)

병합 네 필드의 조건은 `o.x !== undefined`, 즉 **키 존재 여부**다. JSON `null`은 키가
있으므로 **이전 값을 덮어쓴다.** 실측:

```
prev = {schedule:"daily", nextRun:999}, body = {"nextRun":null}
  merged.nextRun -> null   (999 아님)
  재계산 분기: o.nextRun === undefined 가 false -> 실행되지 않음
  최종: nextRun 없음
```

Go에서 `nil`을 "부재"로 접으면 999가 남거나 새 값이 계산된다. 둘 다 틀리다. 병합은
`value, present := o["nextRun"]` 형태의 **키 존재 검사**를 쓴다.

**다만 nil이 조용한 비우기인 것은 `lastRun`과 `nextRun`뿐이다** (리뷰 라운드 3
MAJOR). 네 필드 전부를 그렇게 다루면 잘못된 PUT을 받아들이게 된다. 실측:

```
{"trigger":null} -> 오류 "trigger must be an object"
{"target":null}  -> 오류 (isValidPolicyTarget(null)이 false)
{"lastRun":null} -> 조용히 비움
{"nextRun":null} -> 조용히 비움
```

`trigger`와 `target`은 존재 검사 후 **검증 단계로 넘어가고 거기서 거부된다.**
삭제 정책을 정하는 필드이므로 조용히 넘어가면 안 된다.

**숫자는 float64다.** 오라클의 `number`가 그렇고, `Math.floor(n) === n`으로 정수를
판정한다. int64로 받으면 `1.5`가 무효라는 사실을 표현할 수 없다.

입력은 086의 `decodeSingleJSONDocument` 결과와 같은 `map[string]any`를 받는다.
숫자는 `json.Number`로 오므로 `jsonNumberValue`를 거친다.

`hasOwnProperty` 의미론: Go의 `_, present := o["target"]`이 그대로 대응한다.
**`"target": null`은 키가 존재하므로 "객체가 아님" 분기를 타고 `enabled`를 끈다.**

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `nil` / 배열 / 문자열 / 숫자 | 기본값 그대로, 비활성 |
| 2 | `{}` | 기본값, 비활성 |
| 3 | `{"enabled":true}` | **활성** (target 키 없음) |
| 4 | `{"enabled":"true"}` / `{"enabled":1}` | 비활성 |
| 5 | `{"enabled":true,"target":{}}` | **비활성** — 둘 다 없음 |
| 6 | `{"enabled":true,"target":{"reduceToBytes":1,"removeOldestPercent":2}}` | **비활성** — 둘 다 있음 |
| 7 | `{"enabled":true,"target":null}` | **비활성** — 키가 존재하고 객체가 아님 |
| 8 | `{"enabled":true,"target":[]}` | 비활성 |
| 9 | `{"target":{"reduceToBytes":0}}` | 유효, 채택 |
| 10 | `{"target":{"reduceToBytes":-1}}` / `1.5` | 비활성 |
| 11 | `{"target":{"removeOldestPercent":100}}` | 100 채택 |
| 12 | `{"target":{"removeOldestPercent":0}}` / `101` / `-5` | 비활성 |
| 13 | `{"target":{"removeOldestPercent":0.5}}` | **유효, 값은 1** (floor 후 max) |
| 14 | `{"target":{"removeOldestPercent":99.9}}` | 유효, 값은 99 |
| 15 | `{"enabled":true,"trigger":{"archivedBytesOver":-1}}` | 기본값 5GiB, **enabled는 true 유지** — enabled를 함께 넣어야 비대칭이 증명된다 |
| 16 | `{"enabled":true,"trigger":"x"}` | **활성 유지**, trigger 기본값 |
| 17 | schedule이 네 값 중 하나 / 그 외 | 각각 채택 / `"manual"` |
| 18 | `{"mode":"permanent"}` / `{"mode":"PERMANENT"}` / 부재 | permanent / quarantine / quarantine |
| 19 | `lastRun` = `{at:1,freedBytes:0,removed:0}` | 채택 — **0이 두 필드에서 유효함을 증명** |
| 20 | `lastRun.at`이 0 / 음수 / 소수 / 부재 | `lastRun` 전체가 없음 |
| 21 | `lastRun.freedBytes`가 -1 / 1.5, `lastRun.removed`가 -1 / 1.5 | 각각 전체가 없음 (4 케이스) |
| 21b | `lastRun`에서 `freedBytes` 누락 / `removed` 누락 | 각각 전체가 없음 — 값이 무효인 것과 **키가 없는 것**은 서로 다른 뮤테이션을 잡는다 |
| 22 | `nextRun`이 양의 정수 / null / 0 / 1.5 / 문자열 | 채택 / 없음 / 없음 / 없음 / 없음 |
| 23 | 무관한 필드에 `1e400` | 정규화가 정상 동작 |
| 24 | 마샬 결과: target 두 변형 각각 + `lastRun`이 채워진 경우 | 모든 키가 소문자 카멜(`archivedBytesOver`, `reduceToBytes`, `removeOldestPercent`, `at`, `freedBytes`, `removed`), `lastRun`·`nextRun`은 없을 때 **키 자체가 부재** |
| 25 | PUT: 본문이 배열/문자열/null | `"body must be a JSON object"` |
| 26 | PUT: `enabled`가 문자열 / `mode`가 `"x"` / `schedule`이 `"x"` | 각각 고유 오류 메시지 |
| 27 | PUT: `trigger`가 배열 / `archivedBytesOver`가 -1 | 각각 고유 오류 |
| 28 | PUT: `target`이 무효 | **오류 반환** — 정규화처럼 조용히 비활성화하지 않는다 |
| 29 | PUT: `lastRun`/`nextRun` 생략 | 이전 값 보존 |
| 30 | PUT: schedule이 그대로 daily이고 nextRun이 이미 있음 | **재계산 안 함** |
| 31 | PUT: schedule이 manual→daily로 변경 | 재계산 |
| 31b | PUT: prev가 `{schedule:"daily",nextRun:999}`이고 body가 `{schedule:"weekly"}` | **재계산됨**(`now + 7일`). nextRun이 이미 있으므로 OR의 두 번째 항만 이것을 살린다. `&&` 구현이나 병합된 schedule과 비교하는 구현은 여기서 실패한다 |
| 32 | PUT: schedule이 daily인데 nextRun이 없음 | 재계산 |
| 33 | PUT: schedule이 manual/startup | `nextRun` 삭제 |
| 34 | PUT: schedule이 manual인데 `nextRun`을 명시 전송 | 그 값 유지 |
| 35 | PUT: prev에 `nextRun:999`, body가 `{"nextRun":null}`, schedule은 daily | **nextRun 없음** — null이 이전 값을 덮어쓰고 재계산도 억제한다 |
| 36 | PUT: prev에 `lastRun` 있고 body가 `{"lastRun":null}` | `lastRun` 없음 |
| 37 | PUT: `{"trigger":null}` | 오류 `"trigger must be an object"` — 비우기가 아니다 |
| 38 | PUT: `{"target":null}` | 오류 (정확한 target 메시지) — 비우기가 아니다 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 11): 무효 target에서 `enabled`를 끄지 않기, target 검증을 "적어도 하나"로
완화, percent 상한 검사 제거, `enabled`를 truthy 검사로, mode 기본값을 permanent로,
`lastRun`에서 키 존재 검사 생략(기준 21b), 무효 trigger에서 `enabled` 끄기(기준 15),
중첩 JSON 태그 제거(기준 24), PUT에서 일정이 그대로여도 `nextRun` 재계산(기준 30),
재계산 조건의 OR을 AND로(기준 31b), `null`을 부재로 취급(기준 35),
`trigger`/`target`의 nil을 조용한 비우기로 취급(기준 37/38).
### 8. PUT 병합은 거부와 병합이 분리돼 있다

거부 먼저. 문자열은 **정확히 이것**이며 테스트도 정확 일치로 확인한다:

```
본문이 객체가 아님        -> "body must be a JSON object"
enabled가 정의됐는데 불리언 아님 -> "enabled must be a boolean"
mode가 정의됐는데 두 값 밖    -> "mode must be quarantine or permanent"
schedule이 정의됐는데 네 값 밖 -> "schedule must be startup, daily, weekly, or manual"
trigger가 정의됐는데 객체 아님 -> "trigger must be an object"
trigger.archivedBytesOver 무효 -> "trigger.archivedBytesOver must be a non-negative integer"
target이 정의됐는데 무효      -> "target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)"
```

**정규화와 다르다.** 정규화는 무효 target에서 조용히 `enabled`를 끄지만, PUT은
**오류를 반환한다.** 사용자가 방금 보낸 값이므로 조용히 무시하면 안 된다.

병합은 `{...prev, ...o}`에 네 필드를 덮어쓴다: `trigger`, `target`, `lastRun`,
`nextRun`은 **`o`에 정의된 경우에만** 새 값이고 아니면 이전 값이다. 즉 실행 메타데이터는
클라이언트가 명시적으로 보내야만 바뀐다.

### 9. `nextRun` 재계산 규칙

병합 후 정규화하고 나서:

```
schedule이 daily|weekly 이고
  o.nextRun이 없고
  (policy.nextRun이 없거나 (o.schedule이 정의됐고 이전과 다름))
    -> nextRun = computeNextRun(schedule, now)

schedule이 manual|startup 이고 o.nextRun이 없으면
    -> nextRun 삭제
```

**일정이 그대로면 재계산하지 않는다.** 매 PUT마다 리셋하면 사용자가 설정을 저장할
때마다 예약이 뒤로 밀린다.
