# 084 — probe, 위성 락, 이동 루프, 부분 카운트 (wp8c2b2)

부모 유닛: `080_storage_safety.md` §080.3. 083(핸들 없는 프리플라이트) 다음.

## 이 슬라이스가 닫는 것

083이 `probeStateDbWritable` 직전에서 멈췄다. 여기서부터 **첫 rename까지의 순서가
하나의 계약**이다: probe → 필요한 락만 취득 → pending 마커 내구성 쓰기 → 목적지
디렉터리 생성 → no-replace 이동 루프. 그 뒤의 메타데이터 조정·완결성 게이트·
tombstone은 085.

절단면 근거: 이동 루프의 실패 처리(`cleanup.ts:2795-2818`)는 위성 락을 롤백하고
**순수하게 파일 배치 상태만 보고** 부분 카운트를 계산해 반환한다. DB 트랜잭션은
그다음 줄부터 시작한다. 즉 여기까지가 "DB를 열되 아직 쓰지는 않는" 구간이다.

**정정 (리뷰 라운드 1 BLOCKER):** 초안은 이동 루프 직후에서 끊고 열린 락을 반환하려
했다. 리뷰어가 두 가지를 지적했고 둘 다 맞다.

1. 실질적 경계는 이동 루프가 아니라 **`abortAfterMoves`**(`cleanup.ts:2836-2847`)다.
   그것이 락을 롤백하고 마커를 최선 노력으로 다시 쓰고 부분 카운트를 반환한다.
   그 직전에 `holdAfterFileMovesMs`와 `failAfterFileMoves` 훅이 있다
   (`2849-2859`). 이 셋을 빼면 이동 후 크래시·경쟁 경계가 통째로 빠진다.
2. **열린 SQLite 락을 함수 경계 너머로 반환하면 안 된다.** Go의
   `RollbackAllSatelliteLocks`는 명시적 호출로만 해제되므로, 호출자가 결과를 받고
   cleanup을 등록하기 전에 조기 반환하거나 패닉하면 `BEGIN IMMEDIATE` 트랜잭션이
   그대로 남는다. 오라클에는 그런 창이 없다 — 같은 함수가 계속 소유하기 때문이다.

따라서 이 슬라이스는 **락 소유권을 밖으로 내보내지 않는다.** 이동 이후 단계를
**계속 함수(continuation)로 받아** 소유한 채 호출한다. 085는 그 계속 함수를 채운다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:547-557` — `probeStateDbWritable`
- `src/storage/cleanup.ts:2691-2702` — probe 호출과 에러 매핑
- `src/storage/cleanup.ts:2704-2726` — 위성 락 취득
- `src/storage/cleanup.ts:2727-2731` — `failBeforeMoves`
- `src/storage/cleanup.ts:2762-2784` — `persistPending`과 초기 쓰기
- `src/storage/cleanup.ts:2786-2818` — 이동 루프와 실패 시 부분 결과
- `src/storage/cleanup.ts:1963-1996` — `RestoreResult`

## 계약

### 1. probe는 state 구간을 빚졌을 때만

`if (pendingSections.state)` 안에 있다. 재개가 state를 이미 끝냈다면 probe하지
않는다. `probe.error`가 `codex_busy`면 그대로, 아니면 `db_reconcile_failed`.

**확인함:** 오라클 `probeStateDbWritable`(`cleanup.ts:551-556`)은 이름과 달리
state·logs·goals·memories를 **전부** probe한다. Go `ProbeStateDBWritable`
(`dbprobe.go:195-203`)도 같은 순서로 넷을 probe하므로 일치한다.

### 2. 락은 **아직 빚진 구간만**

```
beginSatelliteWriteLocks(paths, busyTimeoutMs, {
  logs: pendingSections.logs, memories: ..., goals: ...
})
```

주석이 이유를 명시한다: "so a busy DB for an already-finished section cannot
block resume". 이미 커밋된 구간의 DB가 바빠도 재개가 막히면 안 된다.
`AllSatellites()`를 쓰면 이 성질이 깨진다.

실패는 `codex_busy`면 그대로, 아니면 `db_reconcile_failed`.
**이 시점에도 파일은 하나도 움직이지 않았다.**

### 3. `failBeforeMoves`는 락을 롤백한다

이동 전 모든 실패 경로는 취득한 락을 롤백하고 카운트 0으로 반환한다.

### 4. 마커는 첫 이동 전에, 계획 전체를 담아

`acceptedDestRels`는 `[...alreadyMoved, ...toMove]`의 relPath 전부 — 083이
`PlannedDestRels()`로 이미 노출했다. 초기 쓰기 실패는 `failBeforeMoves("fs_failed")`.

`persistPending`은 호출 횟수를 세어 **첫 호출만** `failInitialPendingWrite` 훅에
반응하고, 이후 호출은 `failPendingWriteBeforeRename` 훅에 반응한다. 이 슬라이스는
초기 쓰기와 `abortAfterMoves`의 최선 노력 재기록, 두 번을 쓰므로 **두 훅 모두**
필요하다. 초안은 후자를 085로 미뤘는데, `abortAfterMoves`를 포함하면 여기서 두 번째
쓰기가 실제로 일어나므로 틀렸다.

`abortAfterMoves`의 재기록 실패는 **삼킨다** — 파일은 이미 복원됐고 이전 원자적
마커가 그대로 남아 있기 때문이다.

### 5. 목적지 디렉터리 생성

`mkdirSync(join(codexHome, ARCHIVED_SESSIONS_DIR), {recursive:true})`가 이동 루프의
**try 블록 안에서** 첫 줄로 실행된다(`cleanup.ts:2796`). 083 리뷰어가 지적한 누락
항목이다. 실패하면 catch로 떨어져 이동 실패 경로를 탄다.

### 6. 이동 실패는 절대 되돌리지 않는다

- 위성 락 롤백
- **성공한 rename을 되돌리지 않는다**
- **`acceptedDestRels`를 좁히지 않는다** (마커는 이미 계획 전체를 담고 있다)
- 에러 코드: EEXIST면 `dest_exists`, 아니면 `fs_failed`

### 6b. 이동 이후 경계: `abortAfterMoves`와 두 훅

순서(`cleanup.ts:2849-2859`):

1. `holdAfterFileMovesMs` — 지정되면 그 밀리초만큼 **스핀 대기**한다. 정리 작업이
   진행 중인 복원과 경쟁하도록 만드는 테스트 전용 장치다. `Math.max(0, floor(ms))`.
2. `failAfterFileMoves` — `abortAfterMoves("fs_failed")`.
3. 그 뒤가 085(메타데이터 조정).

`abortAfterMoves(error)`는 항상: 락 롤백 후 `satelliteLocks = undefined`(재롤백
방지) → `persistPending()` 최선 노력 → `{ok:false, trashDir, ...partialCounts, error}`.
**주의:** 여기서 쓰는 것은 배치 상태로 재계산한 값이 아니라 계획 시점에 고정된
`partialCounts`다. 이동 루프 **안**의 실패만 배치 상태로 다시 센다.

### 7. 이동 루프 안의 부분 카운트

`placed = [...alreadyMoved, ...newlyMoved]`. 엔트리 중 **물리 경로가 전부 placed에
있는 것만** 센다. `restoredPaths`는 그 엔트리들의 **논리 `relPath`를 중복 제거**한
것이고, bytes는 그 엔트리들의 bytes 합.

반쪽 엔트리를 세면 사용자가 대화 절반을 잃은 것을 모른 채 "복원됨"을 본다.

### 8. 성공 경로의 카운트는 다르게 계산된다

`partialCounts`는 **계획 시점에** `restoredPaths = [...new Set(entries.map(e => e.relPath))]`,
`bytes = entries의 합`으로 고정된다(`cleanup.ts:2758-2760`). 성공 경로는 생존자
트리밍을 거친 전체 엔트리를 보고하고, 실패 경로만 배치 상태로 다시 계산한다.

## 오라클 차이 좁히기 (083에서 잠재 이슈로 기록됨)

`quarantine.go`의 `RenameNoReplace`가 EEXIST 아닌 모든 link 오류를
`errRenameNoReplaceUnsupported`로 접는다. 오라클(`cleanup.ts:892-909`)은
EXDEV/EPERM/ENOTSUP/EINVAL만 변환하고 나머지는 재던진다. 이 슬라이스가 첫 소비자를
만들므로 여기서 좁힌다: 그 네 개만 `unsupported`, 나머지는 원본 오류 보존.

## 구현 (diff 수준)

### `go/internal/storage/quarantine.go` 수정

link 오류 분기를 `syscall.EXDEV`/`EPERM`/`ENOTSUP`/`EINVAL`로 좁히고 나머지는 원본
반환. Windows 코드는 검증할 수 없으므로 그 플랫폼에서는 현행 보수적 동작을 유지하고
그 사실을 주석에 남긴다.

### 새 파일 `go/internal/storage/restore_moves.go`

```
type RestoreResult struct {
    OK            bool
    TrashDir      string
    Count         int
    Bytes         float64
    RestoredPaths []string
    Error         RestoreErrorCode
}

type RestoreMoveHooks struct {
    FailInitialPendingWrite     bool
    FailPendingWriteBeforeRename bool
    // nil이 비활성이다. 0은 유효한 임계값이며 첫 이동 직후 발동한다.
    FailAfterMoveCount          *int
    FailAfterFileMoves          bool
    HoldAfterFileMovesMS        int
}

// 이동 후 단계가 받는 컨텍스트. 락은 여전히 ExecuteRestoreMoves가 소유한다.
type RestoreMovedState struct {
    Moved   []StagedFile
    Locks   *SatelliteWriteLocks
    Pending RestorePendingSections
    // AbortAfterMoves는 오라클의 abortAfterMoves 그대로다: 락 롤백,
    // 마커 최선 노력 재기록, 계획 시점 partialCounts로 실패 반환.
    AbortAfterMoves func(RestoreErrorCode) RestoreResult
}

// probe -> 락 -> 마커 -> mkdir -> 이동 -> hold/fail 훅 -> continue(...).
//
// 락 소유권은 절대 반환되지 않는다. 취득 직후 `defer RollbackAllSatelliteLocks`를
// 걸어, 계속 함수가 패닉해도 락이 풀리도록 한다. Go의 롤백은 필드를 nil로
// 지우므로 멱등이고, 오라클의 `satelliteLocks = undefined` 가드에 해당하는 별도
// 처리가 필요 없다.
func ExecuteRestoreMoves(
    plan RestorePlan, pre RestorePreflight, codexHome string,
    busyTimeoutMS int, hooks *RestoreMoveHooks,
    continueWith func(RestoreMovedState) RestoreResult,
) RestoreResult

func partialRestoreCounts(entries []CleanupManifestEntry, placed []StagedFile) (int, float64, []string)
func fullRestoreCounts(entries []CleanupManifestEntry) (int, float64, []string)
```

`continueWith`는 085가 메타데이터 조정을 끼워 넣는 자리다. 계속 함수를 받는 형태를
지금 정하는 이유는, 나중에 열린 락을 반환하는 형태로 바꾸면 위에서 말한 소유권 창이
생기기 때문이다.

### nil 계속 함수는 오라클에 없는 임시 이음매다 (리뷰어 라운드 2 MAJOR)

오라클은 이동 후 **항상** 메타데이터를 조정하며, 파일 이동이 끝났다는 이유만으로
성공을 반환하는 경로가 없다(`cleanup.ts:2861` 이후). nil 계속 함수를 "성공"으로
처리하면 사용자는 `pending.state`나 위성 작업이 남은 채로 `ok:true`를 받는다.

따라서 nil 경로는 **테스트 전용이며 성공을 반환하지 않는다.** 계약:

- `continueWith == nil`이면 락을 롤백하고 `RestoreResult{OK:false,
  Error: RestoreIncompleteNoContinuation}`을 돌려준다. 이 코드는 오라클 어휘에 없는
  내부 표시자이며, 085가 계속 함수를 채우면 도달 불가능해진다.
- 프로덕션 진입점은 이 슬라이스에서 만들지 않는다. 즉 이 이음매에 도달하는 경로는
  테스트뿐이다.
- 그 사실을 호출 지점 주석에 남긴다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | state 안 빚짐 + state DB 바쁨 | probe 생략, 진행 |
| 2 | state 빚짐 + DB 바쁨 | `codex_busy` |
| 3 | state 빚짐 + probe가 다른 실패 | `db_reconcile_failed` |
| 4 | logs만 빚짐 | logs 락만 취득, memories/goals 락 없음 |
| 5 | 이미 끝난 memories의 DB가 바쁨 + logs만 빚짐 | **성공** — 끝난 구간이 재개를 막지 않는다 |
| 6 | 락 취득 실패(바쁨) | `codex_busy`, **이동 0건** |
| 7 | 이동 전 실패 | 취득한 락이 롤백됨 |
| 8 | 초기 마커 쓰기 실패 | `fs_failed`, 스테이지에서 나간 파일 0건, 락 롤백 |
| 9 | `archived_sessions` 없는 홈 | mkdir 후 이동 성공 |
| 10 | 정상 이동 | 파일이 목적지에 있고 스테이지에서 사라짐, 마커의 acceptedDestRels가 계획 전체 |
| 11 | 2개 물리 경로 중 1개 이동 후 실패 | 이동된 것 유지, 되돌림 없음, 마커 안 좁아짐 |
| 12 | 11의 부분 카운트 | 반쪽 엔트리는 **제외** |
| 13 | 2개 엔트리 중 1개 완전 이동 후 실패 | 완전한 엔트리만 카운트, restoredPaths에 그 논리 경로만 |
| 14 | 이동 중 목적지 선점 | `dest_exists` |
| 15 | 성공 시 카운트 | 트리밍된 전체 엔트리 기준, 중복 제거된 논리 경로 |
| 16 | continueWith nil | 락 롤백됨(같은 DB의 쓰기 락을 **재취득해 증명**), 결과는 성공이 **아님** |
| 17 | continueWith 제공 | 호출 시점에 락이 열려 있고, 반환 후 롤백됨(재취득으로 증명) |
| 17b | continueWith가 패닉 | 패닉이 전파되더라도 락이 풀림(재취득으로 증명) |
| 17c | `FailAfterMoveCount = ptr(0)` | **첫 이동 직후 실패** — 0은 비활성이 아니다 |
| 18 | `FailAfterFileMoves` | 파일은 목적지에 남고, 락 롤백, 마커 재기록, 계획 시점 partialCounts |
| 19 | `HoldAfterFileMovesMS` | 이동 후 조정 전에 최소 그 시간만큼 지연 |
| 20 | `abortAfterMoves`의 마커 재기록이 실패 | 삼켜지고 결과는 그대로 |
| 21 | `RenameNoReplace`에 POSIX ENOENT | `unsupported`가 아니라 원본 오류 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 10): 락을 `AllSatellites()`로 확대, probe를 무조건 실행,
`failBeforeMoves`에서 락 롤백 제거, 마커를 이동 후에 쓰기, 이동 실패 시 rename
되돌리기, 부분 카운트에 반쪽 엔트리 포함, mkdir 제거,
`abortAfterMoves`에서 락 롤백 제거, `defer` 롤백을 계속 함수 뒤 명시 호출로 교체
(기준 17b가 잡는다), `FailAfterMoveCount`를 값 타입 + 0-비활성으로 되돌림.

**락 해제 증명 방식:** 롤백을 주장만 하지 않고, 같은 SQLite 파일에 대해
`BEGIN IMMEDIATE`를 다시 취득해 성공하는지로 검증한다. 그렇게 하지 않으면 락 관련
뮤테이션이 잡히지 않는다(리뷰어 지적).

## `RenameNoReplace` 좁히기의 안전성 (리뷰어 확인)

리뷰어가 확인해줬다: 오라클도 Go도 대체 rename으로 폴백하지 않으므로, 좁히기가
덮어쓰기 경로를 만들지는 **않는다**. 다만 기존 주석이 명시하듯 Windows 오류 코드는
검증할 수 없으므로 **POSIX errno 좁히기를 Windows link 오류에 적용하지 않는다.**
POSIX에서만 EXDEV/EPERM/ENOTSUP/EINVAL을 `unsupported`로 보고 나머지는 원본을
보존하며, Windows 분기는 현행 보수적 동작을 유지한다.
