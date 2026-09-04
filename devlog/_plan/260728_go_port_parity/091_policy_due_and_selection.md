# 091 — 정책 due 판정과 선택 계산 (wp8d2a)

부모 유닛: `080_storage_safety.md` §080.4. 090(정규화) 다음.

## 절단면

§080.4의 남은 부분은:

```
due 판정 + 선택 계산     <- 이 슬라이스 (순수 함수)
단일 비행 작업 + 워커 타임아웃 <- 092
스케줄러 + 종료 소유권      <- 093
```

due 판정과 선택 계산은 시계를 인자로 받는 순수 함수다. 작업 실행은 goroutine,
10분 타임아웃, 종료 취소가 얽히므로 따로 간다.

## 오라클 (읽기 전용)

- `src/storage/policy.ts:278-296` — `isPolicyDue`
- `src/storage/policy.ts:299-315` — `selectReduceToBytes`
- `src/storage/policy.ts:321-330` — `percentForAtLeastCount`
- `src/storage/policy.ts:340-375` — `selectPolicyPreview`

## 계약

### 1. due 판정은 이유별로 분기한다

```
enabled 아니면            -> false   (항상 첫 관문)
reason === "manual"       -> true    (일정 무시)
schedule === "manual"     -> false
schedule === "startup":
    reason === "startup"  -> true
    그 외                 -> reason === "schedule" && nextRun 존재 && now >= nextRun
daily/weekly:
    nextRun 없으면        -> true
    아니면                -> now >= nextRun
```

**`manual` 이유가 일정보다 먼저다.** 사용자가 직접 누른 실행은 일정과 무관하게 돈다.
단 `enabled`는 그보다 먼저이므로 꺼진 정책은 수동으로도 안 돈다.

**startup 일정의 두 번째 분기가 미묘하다.** startup 정책인데 이유가 startup이 아니면
보통 안 돌지만, `nextRun`이 설정돼 있고 지났으면 **schedule 이유일 때만** 돈다.
주석이 이유를 밝힌다: 실행 시점에 `codex_busy`로 미뤄진 경우를 나중 티커가 집어간다.
즉 `reason === "manual"`은 위에서 이미 처리됐고, 여기 남는 건 `schedule`뿐이다.

**그래서 `reason === "schedule"` 가드는 관측 불가능하다** (리뷰 라운드 1 MAJOR,
재현함). 96개 유효 조합을 전부 돌려 가드를 지운 버전과 비교하면 차이가 0이다.
`manual`과 `startup`이 이미 위에서 반환되므로 여기 도달하는 이유는 `schedule`뿐이다.
가드는 코드로 남기되(오라클이 그렇게 쓰여 있다) **뮤테이션 목록에서는 뺀다.**

`now >= nextRun`은 **포함**이다. 정확히 그 밀리초면 due다.

### 2. `selectReduceToBytes`는 pending-restore를 보지 않는다

084에서 포팅한 `SelectReduceToBytesSkippingPendingRestore`와 **다른 함수**다. 이쪽은
필터가 없다. 오라클이 두 개를 따로 두고 있으므로 그대로 둔다.

```
reduceToBytes가 유한하지 않거나 음수 -> 빈 결과
총합 <= 목표                        -> 빈 결과
need = 총합 - 목표
오래된 것부터 담고 freed >= need 이면 중단
```

**초과 담기를 허용한다.** 마지막 후보가 need를 넘겨도 그대로 포함한다 — 부분 파일
삭제는 없기 때문이다.

### 3. `percentForAtLeastCount`는 선형 탐색이다

`selectOldestPercent`가 최소 `n`개를 고르게 하는 가장 작은 퍼센트를 1..100에서
찾는다.

```
selectedCount <= 0 또는 totalCount <= 0 -> 0
selectedCount >= totalCount             -> 100
pct = 1..100: got = max(1, floor(total * pct / 100)); got >= selected 이면 pct
끝까지 못 찾으면 100
```

`max(1, ...)`가 있어서 `pct=1`도 최소 1개를 고른다. 즉 `selectedCount == 1`이면
항상 1이 답이다.

### 4. `selectPolicyPreview`는 target 종류로 갈린다

```
reduceToBytes가 정의됨:
    desired = selectReduceToBytesSkippingPendingRestore(all, reduceTo, home)
    preview = previewExactArchivedCleanup(desired, home)
    percent = 0 으로 보고하고 candidateRelPaths를 채운다

그 외:
    percent = min(100, max(0, floor(removeOldestPercent ?? 0)))
    selected = selectOldestPercentSkippingPendingRestore(all, percent, home)
    digest = computePreviewDigest(selected, percent)
    candidateRelPaths 없음
```

**`archivedBytes`는 두 경로 모두 전체 후보의 합이다** — 선택된 것이 아니라.

**여기서는 pending-restore 필터를 쓴다.** §2와 대비된다: 정책 미리보기는 사용자에게
보여주고 apply로 이어지므로 진행 중인 복원을 건드리면 안 되지만,
`selectReduceToBytes` 자체는 순수 계산 헬퍼다.

`reduceToBytes` 경로가 퍼센트로 근사하지 않는 이유가 주석에 있다: 근사하면
**과다 삭제**한다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/policy_due.go`

```
type PolicyRunReason string  // manual | startup | schedule

func IsPolicyDue(policy StorageCleanupPolicy, nowMS float64, reason PolicyRunReason) bool
func SelectReduceToBytes(candidates []ArchivedCandidate, reduceToBytes float64) []ArchivedCandidate
func PercentForAtLeastCount(totalCount, selectedCount int) int

type PolicySelection struct {
    ArchivedBytes     int64
    Percent           int
    Count             int
    Bytes             int64
    Digest            string
    CandidateRelPaths []string   // reduceToBytes 경로에서만
}
func SelectPolicyPreview(policy StorageCleanupPolicy, codexHome string) (PolicySelection, error)
```

`SelectPolicyPreview`가 에러를 반환하는 이유: 083에서 확정한 대로
`CollectRestorePendingAcceptedDestRels`가 읽을 수 없는 `.trash`에서 에러를 내고
셀렉터들이 그것을 전파한다.

`percent` 계산의 `?? 0`은 Go에서 `RemoveOldestPercent == nil`일 때 0이다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `enabled=false` + 이유 manual | **false** — enabled가 manual보다 먼저다 |
| 2 | enabled + manual 이유 + schedule=**manual/startup/daily/weekly** 각각 | **전부 true** — 이유가 모든 일정을 이긴다 (4 케이스) |
| 3 | enabled + schedule=manual + 이유 startup/schedule | false |
| 4 | schedule=startup + 이유 startup | true |
| 5 | schedule=startup + 이유 schedule + nextRun 없음 | false |
| 6 | schedule=startup + 이유 schedule + nextRun이 미래 | false |
| 7 | schedule=startup + 이유 schedule + `now == nextRun` | **true** (포함 경계) |
| 8 | schedule=daily + nextRun 없음 | true |
| 9 | schedule=daily + `now == nextRun` / 미래 / 과거 | true / false / true |
| 9b | schedule=**weekly** + nextRun 없음 / `now == nextRun` / 미래 / 과거 | true / true / false / true — daily와 동일 분기임을 고정 |
| 9c | schedule=daily/weekly + 이유 **startup** + nextRun 없음 | **true** — 마지막 분기는 이유를 보지 않는다 |
| 10 | `SelectReduceToBytes`: 비유한/음수 목표 | 빈 결과 |
| 11 | 총합 <= 목표 | 빈 결과 |
| 12 | 3개 후보 100바이트씩, 목표 150 | 오래된 2개 (freed 200 >= need 150, 초과 허용) |
| 13 | `SelectReduceToBytes`의 시그니처 | codexHome을 받지 않으므로 pending 상태를 볼 수 **없다**. 필터 부재는 타입으로 보장되며 별도 테스트 대상이 아니다 |
| 14 | `PercentForAtLeastCount(0,0)` / `(10,0)` / `(0,5)` | 전부 0 |
| 15 | `(10,10)` / `(10,20)` | 100 |
| 16 | `(10,1)` | **1** — floor(10*1/100)=0이지만 max(1,...)이 1을 만든다 |
| 17 | `(10,5)` | 50 |
| 18 | `(3,2)` | 67 (floor(3*67/100)=2) |
| 19 | preview: reduceToBytes target. **픽스처: 10바이트 후보 200개, `reduceToBytes=1990`** | 정확히 1개 선택. 퍼센트 근사는 1%에서 2개를 집으므로 이 픽스처가 그 뮤테이션을 구분한다 |
| 20 | preview: percent target | `CandidateRelPaths == nil` (빈 슬라이스가 아니라 nil), percent digest |
| 21 | preview: `archivedBytes`. **픽스처: 전체 1000바이트 중 10바이트만 선택되게** | 두 경로 모두 `ArchivedBytes == 1000`, `Bytes == 10`. 전부 선택되는 픽스처로는 두 값이 같아져서 뮤테이션을 놓친다 |
| 22 | preview: pending-restore 겹침 | 두 경로 모두 **제외됨** |
| 23 | preview: 읽을 수 없는 `.trash` + 후보 존재 + **percent > 0** (또는 충족되지 않은 유한 reduce 목표) | 에러 전파 |
| 23b | preview: 읽을 수 없는 `.trash` + 후보 존재 + percent가 nil/0 | **에러 없음** — 셀렉터가 `.trash`를 읽기 전에 반환한다 |
| 23c | preview: 읽을 수 없는 `.trash` + 후보 존재 + `총합 <= reduceToBytes` | **에러 발생.** 셀렉터는 일찍 반환하지만 `PreviewExactArchivedCleanup`이 빈 목록에도 무조건 필터를 부른다 |
| 24 | preview: percent가 nil | percent=0, 선택 0개 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 6): `enabled` 검사를 manual 뒤로(기준 1), `now >= nextRun`을 `>`로(기준 7/9),
`percentForAtLeastCount`의 `max(1,...)` 제거(기준 16), preview의 `archivedBytes`를
선택분 합으로(기준 21), reduceToBytes 경로를 퍼센트 근사로(기준 19),
percent 경로에서 `CandidateRelPaths`를 빈 슬라이스로 채우기(기준 20).

**픽스처가 곧 검출력이다** (리뷰 라운드 2 MAJOR). `archivedBytes` 뮤테이션은 선택이
부분집합일 때만 보이고, reduceToBytes 근사 뮤테이션은 후보가 100개를 넘을 때만 보인다.
실측: 후보 200개에서 원하는 1개는 `percentForAtLeastCount`로 1%가 되는데, 그 1%가
실제로는 2개를 집는다.

**목록에서 뺀 둘** (리뷰 라운드 1 MAJOR, 둘 다 재현함):
- startup 분기의 `reason === "schedule"` 제거 — 96개 조합에서 차이 0인 등가 뮤테이션.
- `SelectReduceToBytes`에 pending 필터 추가 — 그 함수는 `codexHome`을 받지 않으므로
  필터를 넣을 수조차 없다. 시그니처가 이미 보장한다.
