# 087 — 위성 커밋 블록 (wp8c2b3b2a)

부모 유닛: `080_storage_safety.md` §080.3. 086(행 바인딩) 다음.

## 절단면

086이 값 변환까지 끝냈다. 084의 `continueWith` 안에서 실행되는 이동 후 단계는:

```
restoreThreadsFromManifest   <- state DB. 롤아웃에서 스레드 행 재구성까지 딸려온다
위성 커밋 (logs/memories/goals)  <- 이 슬라이스
pending 가드 + 완결성 게이트 + tombstone  <- 085에서 완료
```

**스레드 조정을 함께 넣지 않는 이유:** `restoreThreadsFromManifest`는 스키마의 NOT
NULL 컬럼을 조사하고, 스냅샷이 그것을 다 덮지 못하면 **롤아웃 파일에서 세션 메타를
읽어 행을 재구성**한다(`cleanup.ts:2374-2467`). 그것은 history-provider 경로에
의존하는 별도 단위다. 위성 커밋은 그런 재구성이 없고 백업 행을 그대로 넣으므로
깔끔히 분리된다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:2886-2960` — 위성 커밋 블록 전체
- `src/storage/cleanup.ts:961-981` — `restoreConsolidateGlobalJob`
- `src/storage/cleanup.ts:797-830` — `insertRowsConflictIgnore`

## 계약

### 1. 구간별로 하나씩, 커밋 직후 마커 갱신

각 구간(logs → memories → goals)마다 동일한 순서다:

```
pending[구간] && backup[구간] 일 때만 진입
  락이 없으면 오류
  필수 테이블이 없으면 오류
  행 삽입
  commitSatelliteLock(락)
  locks[구간] = undefined      <- 이중 롤백 방지
  pending[구간] = false
  persistPending()             <- 커밋 직후 즉시
```

**마커 갱신이 커밋 바로 뒤인 것이 핵심이다.** 그 사이에 크래시하면 이미 커밋된 행이
재개 때 다시 삽입된다. `ON CONFLICT DO NOTHING`이 대부분 막아주지만, 계약은 마커가
진실의 원천이라는 것이다.

### 2. 진입 조건은 `pending && backup` 둘 다

빚지지 않은 구간은 건너뛴다. 백업에 섹션이 없는 구간도 건너뛴다. 후자는
`FailClosedSatelliteResume`이 이미 걸렀어야 하지만, 오라클이 여기서도 확인하므로
같이 확인한다.

### 3. 테이블 존재 검사는 구간마다 다르다

| 구간 | 필수 테이블 | 선택 테이블 |
| --- | --- | --- |
| logs | `logs` | 없음 |
| memories | `stage1_outputs` | `jobs` |
| goals | `thread_goals` | `thread_goal_continuation_deferrals` |

**필수 테이블이 없으면 오류**, 선택 테이블이 없으면 그 부분만 건너뛴다.

### 4. memories의 consolidate 잡 복원

`jobs` 테이블이 있고 `consolidateTouched`가 참일 때만:

```
postImage가 없으면 아무것도 안 한다
현재 행이 없으면 -> snapshot이 있으면 삽입, 없으면 종료
현재 행 != postImage 이면 -> 종료 (다른 프로세스가 바꿨다)
현재 행 == postImage 이면 -> snapshot이 있으면 키(kind, job_key)로 업데이트,
                             없으면 DELETE
```

**`sqlRowEqual` 비교가 동시성 보호다.** 정리가 남긴 이미지와 현재 행이 같을 때만
되돌린다. 그렇지 않으면 그 사이 다른 프로세스가 한 갱신을 덮어쓴다.

### 5. 남은 락 정리

세 구간을 마친 뒤 `rollbackAllSatelliteLocks(locks)`로 **빚진 일이 없어 커밋하지
않은 락**을 닫는다. 이미 커밋한 락은 `undefined`가 되어 있으므로 이중 처리되지 않는다.
Go의 `RollbackAllSatelliteLocks`는 필드를 nil로 지우므로 같은 효과다.

### 6. 실패는 전부 `abortAfterMoves`

블록 전체가 하나의 try다. 어떤 실패든 `mapDbError`가 `codex_busy`면 그대로,
아니면 `db_reconcile_failed`. 084가 이미 `AbortAfterMoves`를 넘겨준다.

**부분 커밋은 되돌리지 않는다.** logs가 커밋된 뒤 memories가 실패하면 logs는 그대로
두고 마커에 memories만 남는다. 그것이 재개의 근거다.

### 7. 행 값 변환은 086을 쓴다

`IterateBackupRows`로 행을 꺼내고, 각 컬럼 값을 `BindableBackupValue`로 바꾼다.
객체 값(오라클의 BLOB 결함)은 여기서 실패하고 `db_reconcile_failed`가 된다 —
오라클이 드라이버 거부로 실패하는 것과 같은 지점이다.

**컬럼 키는 UTF-16 코드 유닛이다** (086이 087 계약으로 넘긴 항목). 행이 문자열일 때
`Object.keys("💩")`는 `["0","1"]`이므로, Go가 룬 인덱스를 쓰면 갈린다. 문자열 행에서
컬럼을 뽑을 때 `utf16.Encode`로 코드 유닛 인덱스를 만든다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/satellite_commit.go`

```
// 084의 continueWith 안에서 호출된다. 락은 여전히 084 소유.
// 훅은 RestoreMoveHooks에 필드를 추가해 전달한다: 별도 타입을 만들면 084의
// 계속 함수가 그것을 넘겨줄 통로가 없다.
func CommitSatelliteSections(state RestoreMovedState,
    hooks *RestoreMoveHooks) RestoreErrorCode

func commitLogs(...) error
func commitMemories(...) error
func commitGoals(...) error
func restoreConsolidateGlobalJob(...) error

// 원시 행에서 컬럼을 뽑는다. Object.keys 의미론.
func backupRowColumns(raw any) (SqlRow, error)
```

`backupRowColumns`는 **`Object.keys`를 그대로 재현한다** (리뷰 라운드 1 BLOCKER).
초안은 map과 string이 아닌 모든 것을 빈 행으로 뭉갰는데, 그러면 배열 행이 조용히
건너뛰어지고 `null` 행이 성공한다. 실측:

```
Object.keys([1,2])         -> ["0","1"]
Object.keys([])            -> []
Object.keys([1,true,null]) -> ["0","1","2"]
Object.keys(5)             -> []
Object.keys(true)          -> []
Object.keys(null)          -> TypeError
```

| 원시 행 | 결과 |
| --- | --- |
| `map[string]any` | 각 값을 `BindableBackupValue`로 |
| `[]any` | 인덱스를 키로(`"0"`, `"1"`...), 각 값을 `BindableBackupValue`로 |
| `string` | `utf16.Encode` 코드 유닛마다 키. 값은 그 코드 유닛 하나로 된 문자열 |
| 숫자 / 불리언 | **빈 행** — 컬럼이 0개라 삽입에서 건너뛰어진다 |
| `nil` | **오류** — `Object.keys(null)`이 던진다 |

`nil`이 오류인 것이 중요하다: 초안대로면 `rows: [null]`인 백업이 성공적으로
"복원됨"으로 보고된다.

### 고아 서로게이트는 이 슬라이스로 고칠 수 없다 (스코프 확정)

리뷰 라운드 2가 이것을 BLOCKER로 다시 제기했다. 지적 자체는 정확하다:
`JSON.parse('"\ud800"')`는 JS에서 `length=1`, 코드 유닛 `0xd800`으로 남지만 Go의
`encoding/json`은 U+FFFD로 치환하므로 `backupRowColumns`가 보기 전에 값이 바뀐다.

**그러나 이 슬라이스의 스코프를 넓혀도 해결되지 않는다.** 이유는 디코더가 아니라
Go 문자열 타입 자체다. 같은 제약이 이미 이 저장소에 문서화돼 있다
(`go/internal/cli/runtime_api.go:196-203`):

> JavaScript keeps the lone high surrogate, but **Go has no way to carry one in a
> valid string**, and utf16.Decode would turn it into U+FFFD.

즉 "위성 백업 디코딩에서 코드 유닛을 보존하라"는 처방은 `string`이 아닌 별도 표현
(`[]uint16` 등)을 도입해야 성립하고, 그러면 `SqlRow` 값 타입과 SQL 바인딩 경로 전체가
바뀐다. 그것은 이 슬라이스가 아니라 표현 자체의 설계 결정이다.

또한 이 문제는 여기서 처음 나온 것이 아니다. 동일한 U+FFFD 치환이 **동시 진행 중인
wp9b(이미지 브리지)에서도 리뷰 지적으로 나왔고**, 086에서 이미 wp12 수렴으로
올렸으며, 모든 포팅된 파서가 공유하는 `decodeSingleJSONDocument`에 걸려 있다.

**결정: 이 슬라이스의 문자열 계약을 well-formed 유니코드로 한정한다.** wp12가
표현 수준에서 다룰 항목이며, 그 전까지는 알려진 divergence다. 기준 18은
well-formed 비-BMP(`💩`)를 검증하고, 고아 서로게이트는 테스트로 고정하지 않는다.

### 마커 지연 뮤테이션은 관측 불가다 (리뷰 라운드 2 MINOR)

"구간별 `persistPending`을 세 구간 뒤로 미루기"는 훅 기반 테스트로 잡히지 않는다.
훅이 던지면 `AbortAfterMoves`가 최선 노력으로 마커를 다시 쓰므로 최종 디스크
상태가 같아진다. 진짜 크래시 창을 만들려면 커밋 후 `AbortAfterMoves` 전에 멈추는
별도 seam이 필요하고, 그것은 오라클에 없는 훅이다. 뮤테이션 목록에서 뺀다.

### 훅의 발동 조건은 "첫 커밋"이 아니다 (리뷰 라운드 1 MAJOR)

오라클을 정확히 읽으면(`cleanup.ts:2899, 2924, 2947-2951`):

| 구간 | 발동 조건 |
| --- | --- |
| logs | 훅이 참이면 무조건 |
| memories | 훅 && `!backup.logs` |
| goals | 훅 && `!backup.logs` && `!backup.memories` |

**백업 섹션의 존재 여부**로 판단하지, 실제로 커밋이 일어났는지로 판단하지 않는다.
logs 섹션이 백업에 있지만 이미 커밋돼 pending이 false인 재개에서는, memories가
커밋돼도 훅이 발동하지 **않는다**. "첫 커밋 후 발동"으로 구현하면 그 경우가 갈린다.

### `RestoreMovedState` 확장

`Backup *SatelliteBackup`을 추가한다. 084는 이미 프리플라이트를 받으므로 그대로
넘기면 된다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | logs만 빚짐, 백업에 logs 있음 | logs 행이 삽입되고 커밋, `Pending.Logs` false, 마커 갱신 |
| 2 | 커밋 후 락 | 같은 DB에 `BEGIN IMMEDIATE` **재취득 가능** |
| 3 | logs 빚졌는데 백업에 없음 | 이 함수는 **건너뛰고 pending을 그대로 둔다**. 오류를 내지 않지만 085의 pending 가드가 뒤이어 `db_reconcile_failed`를 낸다 — 복원 성공이 아니다 |
| 4 | 백업에 logs 있는데 안 빚짐 | 건너뜀 |
| 5 | `logs` 테이블 없음 | `db_reconcile_failed` |
| 6 | memories: `stage1_outputs` 없음 | `db_reconcile_failed` |
| 7 | memories: `jobs` 없음 | stage1만 삽입하고 통과 |
| 8 | goals: `thread_goal_continuation_deferrals` 없음 | goals만 삽입하고 통과 |
| 9 | 세 구간 모두 빚짐 | logs → memories → goals 순서로 커밋 |
| 10 | 훅 참, 백업에 logs 있음 | logs 커밋 직후 발동. memories/goals는 마커에 남음 |
| 10b | 훅 참, 백업에 logs 없고 memories 있음 | memories 커밋 후 발동 |
| 10c | 훅 참, 백업에 logs 있고 `pending.logs=false`(재개), memories 빚짐 | memories 커밋 후 **발동하지 않음** — 조건은 섹션 존재이지 커밋 발생이 아니다 |
| 10d | 훅 참, 백업에 goals만 | goals 커밋 후 발동 |
| 11 | 10 이후 재개 | 남은 구간만 커밋, 첫 구간 재삽입 없음 |
| 12 | consolidate: postImage 없음 | 아무 동작 없음 |
| 13 | consolidate: 현재 행 없음 + snapshot 있음 | 삽입 |
| 14 | consolidate: 현재 행 != postImage | **아무 동작 없음** (동시 갱신 보호) |
| 15 | consolidate: 현재 행 == postImage + snapshot 있음 | 키로 업데이트 |
| 16 | consolidate: 현재 행 == postImage + snapshot 없음 | DELETE |
| 17 | 행 값에 객체 | `db_reconcile_failed` (오라클의 BLOB 결함 지점) |
| 18 | 행 목록이 `"💩"` | 행은 룬 하나, 그 행의 컬럼 키는 `"0"`,`"1"` (코드 유닛) |
| 18b | 행이 `[1,2]` 배열 | 컬럼 `"0"`,`"1"` — 건너뛰지 않는다 |
| 18c | 행이 `null` | **오류** — `Object.keys(null)`이 던진다 |
| 18d | 행이 숫자 / 불리언 | 빈 행이라 삽입에서 건너뛰어짐, 오류 아님 |
| 19 | 빚지지 않은 구간의 락 | 블록 끝에서 롤백됨 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 6): 진입 조건에서 `backup` 검사 제거, 필수 테이블 검사 제거,
선택 테이블 없을 때 실패, `sqlRowEqual` 비교 제거(무조건 되돌림),
컬럼 키를 룬 인덱스로, `nil` 행을 빈 행으로 취급.

훅 발동 조건을 "첫 커밋"으로 바꾸는 것도 뮤테이션으로 넣는다 — 기준 10c가 잡는다.

**뮤테이션 목록에서 뺀 것:** "커밋 후 `locks[구간] = nil` 제거"는 관측 불가다
(리뷰어 MINOR). 커밋이 이미 DB 핸들을 닫으므로 나중 롤백은 삼켜지고, 락 재취득
테스트로는 필드가 비워졌는지 증명되지 않는다. Go의 `RollbackAllSatelliteLocks`가
필드를 nil로 지운다는 점은 084에서 이미 확인했다.
