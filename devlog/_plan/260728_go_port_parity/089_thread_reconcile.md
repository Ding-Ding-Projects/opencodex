# 089 — 스레드 조정 (wp8c2b3b2b2)

부모 유닛: `080_storage_safety.md` §080.3. 088(롤아웃 파서) 다음.

## 범위

`restoreThreadsFromManifest`(`cleanup.ts:2374-2470`) **전체**와
`reconstructThreadRowFromRollout`(`cleanup.ts:~2222-2270`). 088이 파서를
포팅했으므로 이제 통째로 닫을 수 있다 — 이전 사이클이 반쪽으로 자르려다 기각된
바로 그 이유가 해소됐다.

**`.zst`도 포함한다** (리뷰 라운드 1 BLOCKER). 초안은 zstd 의존성이 없다는 이유로
`.zst`만 있는 롤아웃을 실패시키려 했다. 리뷰어가 **직전 사이클에서 기각된 것과 같은
실수**라고 지적했고 맞다: 오라클이 성공하는 입력을 Go가 거부하면 문서화해도
파리티가 아니다. 결과는 오히려 더 나쁘다 — 파일은 이미 옮겨진 뒤라 그 복원이
영원히 pending으로 남는다.

"의존성이 없다"도 사실이 아니었다. 확인해 보니 네트워크가 되고
`github.com/klauspost/compress`를 받을 수 있어 이미 추가했다(v1.19.1, 순수 Go).

### `.zst` 압축 해제

`readThreadFieldsFromRollout`(`history-provider.ts:348-358`)의 나머지 절반:

```
경로가 없으면 null
.zst로 끝나면 decompressRolloutZstUtf8, 아니면 그냥 읽기
읽기가 던지면 null
```

`decompressRolloutZstUtf8`는 `MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES`(64MiB)를 상한으로
두고, 넘으면 `rollout_zst_too_large`를 던진다. **상한이 계약이다** — 압축 폭탄이
메모리를 다 먹는 것을 막는다. 그 throw는 호출자의 catch에 걸려 **null**이 되므로,
너무 큰 `.zst`는 "읽을 수 없는 롤아웃"으로 취급되어 §5의 `needsSessionMeta` 규칙을
탄다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:1381-1402` — `withWritableDb`
- `src/storage/cleanup.ts:2205-2212` — `threadSnapshotCoversRequiredColumns`
- `src/storage/cleanup.ts:2214-2220` — `requiredThreadColumnNames`
- `src/storage/cleanup.ts:2222-2270` — `reconstructThreadRowFromRollout`
- `src/storage/cleanup.ts:2374-2470` — `restoreThreadsFromManifest`
- `src/storage/cleanup.ts:2861-2884` — 호출자의 pending 처리

## 계약

### 1. 트랜잭션 (088 리뷰어가 넘긴 항목)

`withWritableDb`는 단순 open/close가 **아니다**:

```
openDbWritable(path, busyTimeout)
BEGIN IMMEDIATE
  body(db)
  COMMIT            <- 성공 시
  ROLLBACK          <- body가 던지면, 그 뒤 재던짐
finally: close
```

autocommit으로 두면 `threads` 삽입 후 `thread_dynamic_tools`에서 실패했을 때
스레드 행만 남는다. 또한 열린 트랜잭션을 close만 하는 것은 이 저장소가 이미
`satellite_locks.go:19-25`에서 안전하지 않다고 기록한 패턴이다.

Go: `acquireSatelliteLock`과 같은 방식으로 pinned connection을 열고, defer로
ROLLBACK-then-close, 성공 경로에서만 COMMIT.

### 2. 진입 가드 두 단계

```
needsThreads = manifest에 threadId 문자열이 하나라도 있거나
               lengthTruthy(backup.threadIds) 또는 lengthTruthy(backup.threads)

needsThreads && state DB 없음 -> db_reconcile_failed
state DB 없음 (needsThreads 아님) -> ok, 아무것도 안 함
```

### 3. 커버리지 판정과 재구성 대상

```
requiredCols = PRAGMA table_info("threads")에서 notnull=1
snapshotThreads = isSqlRowArray(backup.threads) ? backup.threads : []
completeSnapshots = requiredCols를 전부 가진 행들
coveredIds = completeSnapshots 중 id가 문자열인 것들

toReconstruct = entries 중 threadId가 문자열이고
                rolloutPath가 문자열이고
                coveredIds에 없는 것
```

**`id`가 문자열이 아닌 완전한 스냅샷은 삽입되지만 `coveredIds`에 들어가지 않는다**
(088 리뷰어 지적). 그래서 manifest의 그 스레드가 재구성 대상이 된다. 둘 다 일어난다.

### 4. 롤아웃 경로 해석은 세 단계 폴백

```
1. absFromRel(codexHome, entry.rolloutPath)  -- 던지면 undefined
2. abs가 없거나 그 파일이 없으면 -> physicalRelPaths를 순회하며 존재하는 첫 것으로
   abs를 교체. 못 찾으면 abs는 **그대로 둔다**
3. abs가 여전히 undefined일 때만 -> throw missing_rollout_for_thread
```

**2단계는 교체 시도이지 필수가 아니다** (리뷰 라운드 1 MAJOR, 재현함).
`absFromRel`이 성공했는데 그 파일이 없고 physical 후보도 전부 없으면 **원래 경로가
살아남는다.** 그러면 파서가 nil을 돌려주고, 스키마가 목록 필드를 요구하지 않는
경우 기본값 행으로 **성공**한다. 초안은 그것을 실패로 잘못 적었다.

그다음 **`.jsonl.zst`면 평문 형제를 선호한다**: `abs`가 `.zst`로 끝나고
`abs[:-4]`가 존재하면 그것으로 바꾼다.

### 5. 재구성 행

`id`와 `rollout_path`는 manifest에서(바인딩 기준), 나머지는 롤아웃 필드에서.
**각 컬럼은 `allowedCols`에 있을 때만** 넣는다.

| 컬럼 | 출처 |
| --- | --- |
| `model_provider`, `source`, `first_user_message`, `has_user_event` | 파서 필드 |
| `cwd`, `history_mode`, `cli_version` | 파서 필드가 **존재할 때만** |
| `archived` | `entry.archived ?? 1` — **`null`도 1이 된다** |
| `archived_at` | 항상 `null` |

그다음 남은 NOT NULL 컬럼을 안전 기본값으로 채운다: `model_provider`→`"openai"`,
`source`→`"cli"`, `first_user_message`→`""`, `has_user_event`→`0`,
`archived`→`entry.archived ?? 1`. **그 외 미지의 필수 컬럼이 있으면 nil을 반환**한다
— 발명할 수 없는 값이다.

마지막으로 스키마가 목록 필드(`model_provider`/`source`/`first_user_message`) 중
하나라도 요구하는데 **파서가 nil을 돌려줬으면 nil**이다. 읽을 수 없는 롤아웃으로
행을 지어내지 않는다.

재구성이 nil이면 `thread_reconstruct_failed` throw → `db_reconcile_failed`.

### 6. 삽입 순서와 선택 테이블

```
completeSnapshots가 비어있지 않으면 -> threads에 삽입
reconstructed가 비어있지 않으면 -> threads에 삽입   (별도 호출)
backup.dynamicTools가 isSqlRowArray && thread_dynamic_tools 존재 -> 삽입
backup.spawnEdges가 isSqlRowArray && thread_spawn_edges 존재 -> 삽입
```

`isSqlRowArray` 실패나 테이블 부재는 **조용히 건너뛴다**(오류 아님). 위성 행과 달리
여기서는 실제로 검증한다.

### 7. 호출자 배선 (088 리뷰어가 넘긴 항목)

오라클 순서(`cleanup.ts:2861-2884`):

```
pendingSections.state 이면:
  restoreThreadsFromManifest
  실패 -> abortAfterMoves(codex_busy 또는 db_reconcile_failed)
  pendingSections.state = false
  persistPending()  -- 던지면 abortAfterMoves("fs_failed")
failAfterStateCommit 훅
위성 커밋 (087)
pending 가드 + 완결성 게이트 + tombstone (085)
```

이 슬라이스가 **`RestoreRemainingWork`를 만들어 084의 `continueWith`에 꽂는다.**
그러면 `restore_incomplete_no_continuation` 이음매가 사라진다.

`FailAfterStateCommit` 훅을 `RestoreMoveHooks`에 추가한다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/thread_reconcile.go`

```
func ReconcileThreadsFromManifest(state RestoreMovedState, plan RestorePlan,
    paths RuntimeDBPaths, codexHome string, busyTimeoutMS int) RestoreErrorCode

func withWritableStateDB(path string, busyTimeoutMS int,
    body func(conn *sql.Conn) error) error

func requiredThreadColumnNames(ctx, conn) ([]string, error)
func threadSnapshotCoversRequiredColumns(row SqlRow, required []string) bool
func isSqlRowArray(raw any) ([]SqlRow, bool)
func resolveRolloutPath(entry CleanupManifestEntry, codexHome string) (string, bool)
func reconstructThreadRow(entry CleanupManifestEntry, rolloutPath string,
    allowed map[string]bool, required []string) SqlRow
```

### 새 파일 `go/internal/storage/restore_remaining.go`

```
// 084의 continueWith에 그대로 넘길 수 있는 완전한 이동 후 시퀀스.
func RestoreRemainingWork(plan RestorePlan, pre RestorePreflight, codexHome string,
    busyTimeoutMS int, hooks *RestoreMoveHooks) func(RestoreMovedState) RestoreResult
```

### 새 파일 `go/internal/codex/rollout_read.go`

088이 텍스트 파서를 포팅했고, 여기서 파일을 읽는 나머지 절반을 채운다:

```
const MaxRolloutZstDecompressedBytes = 64 << 20

// 경로가 없거나 어떤 이유로든 읽지 못하면 nil.
func ReadThreadFieldsFromRollout(path string) *RolloutThreadFields
func decompressRolloutZst(path string) ([]byte, error)
```

`ReadThreadFieldsFromRollout`:

```
path가 빈 문자열이거나 파일이 없으면 -> nil
.zst로 끝나면 decompressRolloutZst, 아니면 os.ReadFile
어느 쪽이든 오류면 -> nil   (오라클의 catch)
ParseThreadFieldsFromRolloutText(string(raw))
```

**출력 상한은 메모리/윈도 제한이 아니라 출력 길이 제한이어야 한다**
(리뷰 라운드 2 MAJOR). `WithDecoderMaxMemory`는 디코더의 윈도 크기까지 함께
제한하므로, 출력은 작지만 윈도가 큰 정상 프레임을 거부할 수 있다. 오라클의
`maxOutputLength`는 출력만 본다.

따라서 `zstd.WithDecodeAllCapLimit(true)`를 켜고 `DecodeAll`에 용량
`MaxRolloutZstDecompressedBytes`인 목적지를 넘긴다. 그 옵션은 `DecodeAll`을 남은
목적지 용량으로 제한한다. 그 뒤 오라클과 같은 모양으로 `len(decoded) > maxBytes`를
한 번 더 확인한다(중복이지만 계약을 코드에 남긴다).

**경계는 포함(inclusive)이다.** 오라클의 사후 검사가 `>`이고 klauspost도 `>`에서만
거부하므로, 정확히 64MiB로 풀리는 스트림은 **성공**한다. 64MiB와 64MiB+1 픽스처로
양쪽을 고정한다.

`.zst` 판정은 **정확한 접미사 일치**다(`strings.HasSuffix(path, ".zst")`).

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 완전한 스냅샷 | `threads`에 삽입, 재구성 없음 |
| 2 | 스레드 작업 없음 + state DB 없음 | ok |
| 3 | 스레드 작업 있음 + state DB 없음 | `db_reconcile_failed` |
| 4 | `threads` 테이블 없음 | `db_reconcile_failed` |
| 5 | NOT NULL 컬럼 하나 빠진 스냅샷 + 평문 롤아웃 | **재구성되어 삽입** |
| 5b | NOT NULL이 **아닌** 컬럼이 빠진 스냅샷 + 읽을 수 없는 롤아웃 | 완전한 스냅샷으로 취급되어 재구성하지 않음. 재구성했다면 실패했을 것이므로 관측 가능 |
| 6 | 완전한 스냅샷인데 `id`가 숫자 | 삽입되고, **동시에** manifest 스레드가 재구성됨 |
| 7 | `backup.threads`가 배열 아님 / 원소가 객체 아님 | 스냅샷 0개 취급 |
| 8 | `rolloutPath`가 없는 엔트리 | 재구성 대상 아님 |
| 9 | `rolloutPath`가 가리키는 파일 없음 + physicalRelPaths에 존재하는 것 있음 | 그것으로 폴백 |
| 10 | `absFromRel`이 던짐(경로 이탈) | `db_reconcile_failed` |
| 10b | 경로는 해석되나 파일 없음 + physical 후보도 없음 + 스키마가 목록 필드 요구 안 함 | **기본값 행으로 성공** |
| 11 | `.zst`와 평문이 둘 다 있음 | **평문 선택** |
| 12 | `.zst`만 있음 | **압축 해제 후 성공** |
| 12b | 64MiB 상한을 넘는 `.zst` | 파서가 nil → §5 규칙 |
| 13 | 롤아웃이 파싱 불가 + 스키마가 목록 필드 요구 | `db_reconcile_failed` |
| 14 | 롤아웃 파싱 불가 + 스키마가 요구 안 함 | 기본값으로 삽입 |
| 15 | 미지의 NOT NULL 컬럼 | `db_reconcile_failed` |
| 16 | `archived`가 숫자 / `null` / 부재 | 각각 그 값 / **1** / 1 |
| 6b | 스냅샷 `id`가 숫자 `7`, manifest threadId가 `"7"`, **롤아웃은 읽을 수 없고 스키마가 목록 필드를 요구** | 재구성을 시도하다 `db_reconcile_failed`. 잘못된 구현은 `"7"`을 커버된 것으로 보고 스냅샷만으로 성공한다 |
| 12c | 정확히 64MiB로 풀리는 `.zst` | 성공 (경계 포함) |
| 12d | 64MiB+1로 풀리는 `.zst` | 파서가 nil → §5 규칙 |
| 17 | `dynamicTools` 있고 테이블 있음 | 삽입 |
| 18 | `dynamicTools` 있고 테이블 없음 | 건너뜀 |
| 19 | 트랜잭션: 삽입 후 실패 주입 | **스레드 행이 롤백됨** |
| 20 | 전체 시퀀스 성공 | `OK:true`, 스테이지 사라짐, `Pending` 전부 false |
| 21 | `FailAfterStateCommit` | state는 커밋된 채, 마커에 위성만 남음 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 8): COMMIT/ROLLBACK을 autocommit으로, 커버리지 판정에 전체 컬럼 사용
(기준 5b가 잡는다), `coveredIds`에 비문자열 id 포함(기준 6b), 평문 형제 선호 제거,
미지 필수 컬럼에 빈 값 채우기, `needsSessionMeta` 검사 제거, 호출자에서
`Pending.State` 정리 누락, physical 후보 실패 시 원래 `abs`를 버리기(기준 10b).
