# 085 — 완결성 게이트와 tombstone 마무리 (wp8c2b3a)

부모 유닛: `080_storage_safety.md` §080.3. 084(probe·락·이동) 다음.

## 절단면

084가 이동 직후 `continueWith`를 호출하는 지점에서 멈췄다. 그 뒤 오라클의 순서는:

```
restoreThreadsFromManifest      <- state DB에 쓴다
위성 커밋 (logs/memories/goals)  <- 위성 DB에 쓴다, 백업 행을 바인딩한다
완결성 게이트                     <- 파일시스템만
finalizeRestoredStage            <- 파일시스템만
removeEmptyTrashRoot             <- 파일시스템만
```

**이번 슬라이스는 pending 가드와 뒤의 세 개**, 즉 DB에 아무것도 쓰지 않는 마무리
계층이다. 메타데이터 조정과 위성 커밋은 086으로 미룬다.

### 빠뜨렸던 단계 (리뷰 라운드 1 BLOCKER)

초안은 위성 커밋 바로 다음이 완결성 게이트라고 적었는데 틀렸다. 그 사이에
**pending 가드**가 있다(`cleanup.ts:2964-2971`):

```
if (pendingSections.state || pendingSections.logs
    || pendingSections.memories || pendingSections.goals) {
  return abortAfterMoves("db_reconcile_failed");
}
```

이것이 없으면 084의 `continueWith`에 마무리를 그대로 꽂았을 때 **아직 빚진 구간이
있는데도 파일시스템 게이트를 통과해 스테이지를 tombstone 처리하고 지운다.**
`satellite-backup.json`과 복구 마커가 그 DB 작업이 일어나기도 전에 사라지므로,
되돌릴 수 없는 데이터 손실이다. 이 가드는 마무리 계층에 속하며 이번 슬라이스가
가져간다.

### 위성 커밋을 미루는 이유 (정정)

초안은 BLOB 라운드트립을 `NEEDS_HUMAN`으로 분류했다. **리뷰어가 그것을 반박했고
맞다.** 실측:

```
JSON.stringify(new Uint8Array([0,255,16]))  ->  {"0":0,"1":255,"2":16}
```

`SqlRow`의 값은 스칼라 아니면 `Uint8Array`뿐이므로(`cleanup.ts:706`), 임의의 객체가
정상적으로 들어올 수 없다. 즉 **숫자 키 객체 형태를 `[]byte`로 디코드하는 것은
결정론적 호환 코덱이지 제품 정책 결정이 아니다.** 사용자 판단을 요구할 사안이
아니었고, 그렇게 분류한 것은 어려운 작업을 회피한 셈이다.

정정된 이유: 위성 커밋은 **그 코덱 구현과 회귀 픽스처를 요구하는 별도 단위**라서
미루는 것이지, 막혀 있어서가 아니다. 086이 구현할 계약을 여기에 못박아 둔다.

**거부 시점이 계약의 일부다** (리뷰 라운드 2 MAJOR). 코덱을
`ReadSatelliteBackupFile`에 넣으면 안 된다. 오라클의 백업 읽기는 문서·객체·
`threadIds`만 보고 행 값은 손대지 않으며(`cleanup.ts:2186-2200`), 잘못된 행 값은
**파일이 이미 옮겨진 뒤** 위성 블록 안에서 터져 `abortAfterMoves`로 간다. 읽기에서
미리 거부하면 `{"blob":{"0":1,"2":2}}` 같은 스테이지가 **이동 전에** 실패해 오라클과
다른 결과가 된다. 따라서 083이 백업을 미해석으로 들고 있는 설계를 유지하고,
디코드와 거부는 **SQL 바인딩 지점에서만** 일어나며 실패는
`AbortAfterMoves(RestoreDBReconcileFailed)`로 매핑한다.

**빈 BLOB을 반드시 다뤄야 한다** (리뷰 라운드 2 MAJOR). 실측:

```
JSON.stringify(new Uint8Array())  ->  {}
JSON.stringify({})                ->  {}
```

길이 0인 `Uint8Array`와 빈 객체는 **직렬화 결과가 같다.** 위 문단의 "연속 숫자 키"
규칙을 문자 그대로 구현하면 `{}`를 거부해 유효한 빈 BLOB이 복원 실패가 된다.
`SqlRow` 값에 빈 객체는 유효하지 않으므로(`cleanup.ts:706`) 모호성은 실질적으로
없다. `{}` → `[]byte{}`로 디코드한다.

086의 코덱 계약:

- `{}` → `[]byte{}`.
- 비어 있지 않은 객체는 키가 정확히 `"0".."len-1"` 연속이고 값이 전부 `0..255`
  정수일 때 `[]byte`로 디코드.
- 그 외 객체는 거부하되 **SQL 바인딩 시점에서**, `db_reconcile_failed`로.
- 쓰기: Go 백업 작성기도 같은 숫자 키 객체를 낸다. base64를 쓰면 TS가 그것을 TEXT로
  바인딩한다.
- 픽스처: Bun이 쓴 백업과 Go가 쓴 백업을 양쪽이 읽어 같은 바이트를 얻는지. 빈 BLOB,
  0과 255를 포함한 바이트, 그리고 거부 케이스를 각각 포함한다.

마무리 계층은 행을 전혀 만지지 않으므로 그와 무관하게 지금 닫을 수 있다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:2964-2971` — pending 가드
- `src/storage/cleanup.ts:2975-2998` — 완결성 게이트
- `src/storage/cleanup.ts:2531-2551` — `finalizeRestoredStage`
- `src/storage/cleanup.ts:2999-3013` — 최종 반환과 `removeEmptyTrashRoot`
- `src/storage/cleanup.ts:~2100` — `removeEmptyTrashRoot`
- `src/storage/cleanup.ts:2147` — `listTrashEntries`의 `TRASH_EPOCH_DIR` 필터

## 계약

### 0. pending 가드가 먼저다

어느 구간이든 아직 빚져 있으면 `abortAfterMoves("db_reconcile_failed")`. 락을
롤백하고 마커를 재기록하고 계획 시점 카운트로 실패를 반환한다. **스테이지는
그대로 남는다** — 이것이 재시도 가능성을 지키는 지점이다.

`state`도 포함된다. 084의 `RestoreMovedState.Pending`은 포인터이므로, 086이 조정을
끝내며 플래그를 내리면 이 가드가 자연히 통과한다. 그 전까지는 마무리가 항상 여기서
멈춘다 — 그것이 올바른 임시 동작이다.

### 1. 완결성 게이트는 두 가지를 본다

```
for (const item of moved) {
  if (!existsSync(item.to) || existsSync(item.from)) return abortAfterMoves("fs_failed");
}
```

계획된 모든 파일이 목적지에 있어야 하고, **스테이지에 원본이 남아 있어도 안 된다.**
`alreadyMoved`도 포함되므로 재개 케이스에서 이전에 놓인 목적지가 사라졌다면 여기서
걸린다.

### 2. 스테이지에 남은 롤아웃이 없어야 한다

`manifest.json`, `satellite-backup.json`, `restore-pending.json` **세 개만** 건너뛴다.
그 외 이름 중 **롤아웃 파일 이름인 것**이 하나라도 있으면 `fs_failed`.
롤아웃이 아닌 잔여 파일(예: 임시 파일)은 무시한다.

`readdirSync` 실패도 `fs_failed`.

**왜 중요한가:** 이 게이트를 통과해야 스테이지를 파괴한다. 남은 롤아웃이 있는데
지우면 사용자가 복구할 수 없는 데이터가 사라진다.

### 3. tombstone은 이름으로 목록에서 감춘다

`.tombstone-<epoch>-<uuid>`로 rename한다. `listTrashEntries`는 `TRASH_EPOCH_DIR`
(`^(\d+)(-\d+)?$`)에 맞는 이름만 보므로 점으로 시작하는 tombstone은 자동으로
빠진다. 삭제가 아니라 **rename이 먼저**인 이유: rename은 원자적이라 목록에서
사라지는 시점이 명확하고, 실패하면 원래 스테이지와 모든 증거가 그대로 남아 재시도가
가능하다.

rename 실패 → `false` → 호출자가 `fs_failed`. **`abortAfterMoves`가 아니다.**
오라클은 여기서 `{ok:false, trashDir, ...partialCounts, error:"fs_failed"}`를 직접
돌려준다(`cleanup.ts:2999-3005`). 즉 락 롤백과 마커 재기록을 다시 하지 않는다 —
이미 위에서 다 끝났기 때문이다.

tombstone 삭제는 **최선 노력**이다. 실패해도 성공을 반환한다. 고아 tombstone은
목록에 안 보이므로 해가 없다.

### 4. 빈 trash 루트는 치운다

`removeEmptyTrashRoot`: 존재하고 비어 있음을 **관찰한 뒤** 최선 노력으로 재귀
삭제한다. 모든 오류를 삼킨다. 고아 tombstone이 남아 있으면 비어 있지 않으므로
유지된다.

원자적 보장은 아니다(리뷰어 MINOR): 확인과 삭제 사이에 생긴 항목은 함께 지워질 수
있다. 오라클이 그렇고, 여기에 Go만의 방어를 추가하면 divergence다.

### 5. 성공 카운트

`partialCounts` — 즉 084가 계산한 계획 시점 값이다. 배치 상태로 재계산하지 않는다.

## 구현 (diff 수준)

### `go/internal/storage/restore_moves.go` 수정

`RestoreMoveHooks`에 추가:

```
FailAtLeftoverStageGate bool
FailStageTombstoneRename bool
FailTombstoneDelete      bool
```

`RestoreMovedState`에 `CodexHome string`을 추가한다 — 마무리가 trash 루트 경로를
알아야 하는데 지금은 계속 함수가 그것을 받지 못한다.

### 새 파일 `go/internal/storage/restore_finalize.go`

```
// 계획된 파일이 전부 제자리에 있고 스테이지에 롤아웃이 남지 않았는지 확인한다.
func VerifyRestoreCompleteness(moved []StagedFile, stageDir string, hooks *RestoreMoveHooks) bool

// 스테이지를 목록에 안 보이는 tombstone으로 rename하고 최선 노력으로 지운다.
func FinalizeRestoredStage(stageDir, codexHome string, hooks *RestoreMoveHooks) bool

// 비어 있을 때만 trash 루트를 지운다. 모든 오류를 삼킨다.
func RemoveEmptyTrashRoot(codexHome string)

// 084의 continueWith에 넣을 수 있는 마무리 계속 함수. 086이 메타데이터 조정을
// 앞에 끼워 넣을 때 그 뒤를 이 함수가 담당한다.
// pending 가드 -> 완결성 게이트 -> tombstone -> 빈 루트 정리.
func FinalizeRestore(state RestoreMovedState, plan RestorePlan,
    codexHome string, hooks *RestoreMoveHooks) RestoreResult
```

`FinalizeRestore`는 084가 넘긴 `AbortAfterMoves`를 게이트 실패에 쓰고,
tombstone 실패에는 쓰지 않는다(§3).

UUID: `crypto/rand`로 16바이트를 읽어 RFC 4122 v4 형식으로 만든다. 이름의 유일성만
필요하고 암호학적 강도가 요구되지는 않지만, `math/rand`는 시드가 같으면 충돌하므로
쓰지 않는다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 0a | `Pending.State`가 참인 채 마무리 | `db_reconcile_failed`, **스테이지 보존**, 마커 보존 |
| 0b | `Pending.Logs`만 참 | 동일 |
| 0c | 모든 플래그가 거짓 | 가드 통과 |
| 1 | 정상 마무리 | `OK:true`, 스테이지가 사라짐, 계획 시점 카운트 |
| 2 | 마무리 후 `listTrashEntries` | 해당 스테이지가 목록에 없음 |
| 3 | 이동 후 목적지 파일이 사라짐 | `fs_failed` |
| 4 | 이동 후 스테이지에 원본이 다시 나타남 | `fs_failed` |
| 5 | 스테이지에 롤아웃 파일이 남음 | `fs_failed`, **스테이지 보존** |
| 6 | 스테이지에 세 메타 파일만 남음 | 통과 |
| 7 | 스테이지에 롤아웃 아닌 잔여 파일 | 통과 (무시) |
| 8 | `FailAtLeftoverStageGate` | `fs_failed` |
| 9 | `FailStageTombstoneRename` | `fs_failed`, 스테이지가 원래 이름 그대로 남아 재시도 가능 |
| 10 | `FailTombstoneDelete` | **`OK:true`** — 고아 tombstone은 무해 |
| 11 | 10 직후 `listTrashEntries` | tombstone이 목록에 없음 |
| 12 | 마무리 후 trash 루트가 비었음 | 루트도 사라짐 |
| 13 | 다른 스테이지가 남아 있음 | 루트 유지 |
| 14 | 고아 tombstone이 남아 있음 | 루트 유지 (비어 있지 않음) |
| 15 | tombstone 이름 | `.tombstone-<epoch>-<uuid>`, 두 번 호출해도 충돌 없음 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 7): **pending 가드 제거**(기준 0a/0b가 잡는다), 게이트에서
`existsSync(item.from)` 검사 제거, 게이트에서 잔여 롤아웃 검사 제거, 메타 파일 예외
목록에서 하나 빼기, tombstone rename 실패를 성공으로, tombstone 삭제 실패를 실패로,
`RemoveEmptyTrashRoot`가 비어있지 않아도 삭제.

## 086으로 미루는 것

`restoreThreadsFromManifest`와 위성 커밋. 둘 다 백업 행을 SQL에 바인딩하므로 위에
적은 숫자 키 BLOB 코덱과 그 회귀 픽스처가 함께 들어가야 하며, 거부는 읽기가 아니라
바인딩 시점에서 일어나야 한다. **NEEDS_HUMAN이 아니다** — 결정론적 호환 작업이며
별도 단위일 뿐이다.
