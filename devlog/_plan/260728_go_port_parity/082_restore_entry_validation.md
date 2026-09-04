# 082 — 복원 진입 검증: 스테이지 ID, manifest, 안전 경로 (wp8c2a)

부모 유닛: `080_storage_safety.md` §080.3. 081(pending 저널) 다음 슬라이스.

## 절단면을 옮긴 이유 (리뷰어 라운드 1 BLOCKER)

초안은 "이동 루프까지"를 이 슬라이스로 잡았다. 리뷰어가 그것을 막았고, 재현해 보니
맞았다. 오라클은 **첫 rename보다 먼저** 위성 백업을 읽어 remap하고, resume 상태를
검증하고, state DB 쓰기 가능성을 probe하고, 위성 쓰기 락을 잡는다
(`cleanup.ts:2626-2723`). 코드 주석 자체가 "Locks happen before moves ... so failure
stays retryable (nothing has left the stage yet)"라고 명시한다. 이동 루프만 떼어내
포팅하면, 손상된 위성 백업이나 바쁜 DB에서 **TS는 파일을 하나도 옮기지 않는데 Go는
옮기는** 상태가 된다. 훅으로는 락 순서를 만들 수 없다.

따라서 절단면을 **이동 루프 이전, DB를 요구하지 않는 순수 검증 계층**으로 당긴다.

**후속 정정 (083 리뷰 라운드 1):** "083이 프리플라이트·락·이동을 한 덩어리로
가져간다"는 위 서술은 부정확했다. 프리플라이트 자체가 DB 핸들 경계로 다시 갈린다.
083은 핸들을 열지 않는 앞부분(경로 발견, 백업 읽기·remap, resume fail-closed,
pendingSections 초기화, `needsThreads` 존재 가드)을 가져가고,
`probeStateDbWritable`·위성 락·이동 루프·부분 카운트·조정·tombstone은 wp8c2b2다.

이 슬라이스가 닫는 것: 스테이지 ID 해석, manifest 파싱, 안전 물리 경로 판정,
어휘적 경로 해석, 생존자 트리밍, 이동 **계획**(수립까지, 실행 없음).

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:1963-1996` — `RestoreErrorCode`, `RestoreResult`
- `src/storage/cleanup.ts:79-87` — `CleanupManifestEntry`
- `src/storage/cleanup.ts:1998-2003` — `TrashManifest`
- `src/storage/cleanup.ts:2010-2070` — `parseTrashManifest`
- `src/storage/cleanup.ts:2072-2096` — `resolveTrashStageDir`
- `src/storage/cleanup.ts:2473-2481` — `isSafeArchivedPhysicalRel`
- `src/storage/cleanup.ts:1534-1542` — `absFromRel`
- `src/storage/cleanup.ts:2594-2624` — pending 읽기 + 생존자 트리밍
- `src/storage/cleanup.ts:2729-2760` — 이동 계획

## 계약

### 1. 스테이지 ID 정규화 (리뷰어 MAJOR, 초안이 틀렸음)

초안은 "슬래시나 백슬래시가 있으면 invalid"라고 썼는데 틀렸다. 오라클은 정규화를
**먼저** 한다: `trim()` → 네이티브 구분자를 `/`로 → 후행 `/` 제거. 그다음에야
`.trash/` 접두사와 나머지를 검사한다. 실측(node):

```
"  .trash/123///  " -> ".trash/123"   유효
".trash/12-3/"      -> ".trash/12-3"  유효
".trash/"           -> ".trash"       invalid (접두사 불일치)
```

`toForwardSlash`는 `p.split(sep).join("/")`이라 **플랫폼 의존적**이다. POSIX에서
`sep`은 `/`이므로 백슬래시는 그대로 남아 `rest.includes("\\")`에 걸린다. Windows에서
`sep`은 `\`이므로 `.trash\123`이 `.trash/123`으로 정규화되어 **유효**해진다.
Go는 `strings.ReplaceAll(id, string(os.PathSeparator), "/")`로 같은 플랫폼 의존성을
재현한다. 이것을 "정리"해서 양쪽 구분자를 다 받으면 POSIX에서 오라클이 거부하는 ID를
받게 된다.

검사 순서: 접두사 → `rest`가 비었나 / `/` 포함 / `\` 포함 / `..` 포함 → 정규식 →
`absFromRel` → 존재 → 디렉터리 여부.

`existsSync` 실패는 `missing_trash`, 디렉터리가 아니면 `invalid_trash`,
`statSync` 자체가 실패하면 `missing_trash`(존재 확인 뒤 사라진 경우).

### 2. manifest 검증 범위 (리뷰어 MAJOR, 초안이 과장했음)

초안은 "잘못된 선택 필드 하나가 전체를 무효화"라고 썼는데, 그것은 **엔트리 안의**
선택 필드에만 해당한다. 최상위 `quarantinedAt`과 `mode`는 잘못되면 **조용히
누락**될 뿐 manifest는 유효하다(`cleanup.ts:2057-2062`). `"mode":"other"`이거나
`"quarantinedAt":1e400`인 manifest를 Go가 거부하면 오라클이 받는 것을 거부하는 것이다.

엔트리 안에서는 전부 아니면 전무다: `relPath`가 빈 문자열이 아닌 문자열,
`bytes`/`mtimeMs`가 유한한 숫자, `physicalRelPaths`가 비지 않은 배열이며 모든 원소가
빈 문자열이 아닌 문자열, `threadId`/`rolloutPath`는 **키가 있다면** 문자열,
`archived`는 **키가 있다면** null 또는 숫자.

`"threadId": null`은 키가 존재하므로 `"threadId" in entry`가 true이고
`typeof null !== "string"`이라 **거부**된다. Go의 `value, present := entry["threadId"]`는
JSON null에 대해 `present == true, value == nil`이므로 동일하게 거부한다 (리뷰어가
node와 `go doc`으로 양쪽 확인).

### 3. 숫자 디코딩 — 표준 Unmarshal로는 오라클을 재현할 수 없다 (리뷰어 MAJOR)

초안은 `1e400`이 `map[string]any`에서 `+Inf`로 디코드된다고 썼다. **틀렸다.** 실측:

```
json.Unmarshal(`{"bytes":1e400}`, &m)
  -> err = json: cannot unmarshal number 1e400 into Go value of type float64
JSON.parse(`{"bytes":1e400}`).bytes
  -> Infinity
```

즉 표준 디코드는 **문서 전체를 거부**하는데 오라클은 문서를 받아들이고 그 필드만
`Number.isFinite`로 처리한다. 차이가 관측 가능한 지점이 둘이다:

- `{"quarantinedAt":1e400}` — TS는 manifest 유효, 필드만 누락. Go 표준 디코드는 전체 거부.
- `{"archived":1e400}` — TS는 `typeof Infinity === "number"`라 **수용**. Go 표준 디코드는 전체 거부.

해법은 `json.Decoder` + `UseNumber()`로 받고 `json.Number`를 직접
`strconv.ParseFloat`하되 **`ErrRange`일 때 반환된 `±Inf` 값을 그대로 쓴다**. 실측 확인:

```
quarantinedAt raw=1e400 parsed=+Inf inf=true parseErr=...value out of range
bytes         raw=1.5   parsed=1.5  inf=false parseErr=<nil>
```

`strconv.ParseFloat`은 오버플로에서 `±Inf`와 `ErrRange`를 **함께** 돌려주므로,
`ErrRange`를 무시하고 값을 취하면 `JSON.parse`와 정확히 같아진다. 구문 오류
(`ErrSyntax`)는 값을 못 쓰므로 거부한다.

필드별 규칙:

| 필드 | Inf 허용? |
| --- | --- |
| entry `bytes` | 아니오 (`Number.isFinite`) |
| entry `mtimeMs` | 아니오 |
| entry `archived` | **예** (`typeof === "number"`만 검사) |
| top-level `quarantinedAt` | 아니오 — 단 거부가 아니라 **누락** |

**정정: 081의 `restore_pending.go`에도 같은 결함이 있다.** 나는 처음에 "거기 숫자
필드는 `version`뿐이니 문제없다"고 썼는데, 리뷰어가 반례를 요구했고 재현해 보니
내 판단이 틀렸다. 오라클 파서는 자기가 읽는 6개 키 외에는 **전부 무시**하므로,
미지의 필드에 오버플로 숫자가 들어 있어도 마커는 유효하다:

```
{"version":1,"filesRestored":true,"acceptedDestRels":[],
 "pending":{...},"junk":1e400}
  TS  -> 유효 (junk = Infinity, 그냥 무시됨)
  Go  -> json: cannot unmarshal number 1e400 ... => invalid
```

`pending` 객체 안에 미지의 오버플로 필드가 있어도 같다. 즉 Go는 오라클이 받아들이는
마커를 거부한다 — **오라클보다 엄격한 divergence**이고, 앞으로 마커에 필드가 하나라도
추가되면 전방 호환성이 깨진다. 반대 방향(Go가 받는데 TS가 거부)은 리뷰어가 찾지
못했다.

**이 슬라이스에서 `restore_pending.go`도 함께 고친다.** 커밋 02e9d0259의 후속
수정이며, `parseRestorePendingState`가 `json.Decoder` + `UseNumber`를 쓰도록 바꾼다.
`version`이 `1e400`이면 여전히 거부된다(`+Inf != 1`). 회귀 테스트를 추가한다.

### 4. 안전 물리 경로

`archived_sessions/`로 시작, `..` 미포함, 그 뒤에 `/` 없음, 롤아웃 파일 이름
(`.jsonl` 또는 `.jsonl.zst`). Go에는 `isRolloutFileName`이 이미 있고 동일하다
(`cleanup.go:74-77`).

### 5. `absFromRel`은 어휘적이다

`..` 포함, 절대 경로, `^[A-Za-z]:[\\/]` 드라이브 접두사면 거부. 그다음
`resolve(codexHome, ...parts)`와 `relative`로 홈 밖 이탈 확인.
**realpath 하지 않는다** — 심볼릭 링크를 따라가면 오라클이 허용하는 경로를 거부한다.
Go는 `filepath.Join` + `filepath.Rel`을 쓰되, 리뷰어 지적대로 **`Rel`이 `"."`을
돌려주는 경우도 거부**해야 TS의 `if (!rel)`와 같아진다.

### 6. 생존자 트리밍과 이동 계획의 `absFromRel`은 비대칭이다

트리밍(`cleanup.ts:2611-2619`)은 try/catch로 감싸 실패를 "생존 아님"으로 흡수한다.
계획(`cleanup.ts:2740-2745`)은 실패를 `invalid_trash`로 올린다. 이 비대칭은 실제이고
보존한다.

### 7. pending 마커는 트리밍 **전에** 읽는다 (리뷰어 MAJOR)

오라클은 manifest 파싱 직후 `readRestorePending`을 호출하고 `invalid`면 즉시
`fs_failed`를 낸다(`cleanup.ts:2594-2601`). `acceptedDest`는 `valid`인 경우에만
채워진다. 초안은 `accepted` 맵을 인자로 받는 것으로만 적어 이 fail-closed 지점을
빠뜨렸다. 진입 함수가 `ReadRestorePending`을 직접 호출하도록 명시한다.

### 8. 이동 계획 판정표 (검사 순서 포함)

오라클 순서: `alreadyMoved` 조건 → `toExists` → `!fromExists`.

| from | to | accepted | 결과 |
| --- | --- | --- | --- |
| 없음 | 있음 | 예 | `alreadyMoved` |
| 있음 | 있음 | 예 | `dest_exists` (from이 남아 있으면 재개 아님) |
| 있음 | 있음 | 아니오 | `dest_exists` |
| **없음** | **있음** | **아니오** | **`dest_exists`** — 리뷰어가 지적한 누락 케이스. `fs_failed`가 아니다 |
| 있음 | 없음 | - | `toMove` |
| 없음 | 없음 | - | `fs_failed` |

### 9. `acceptedDestRels`는 계획 전체다

`[...alreadyMoved, ...toMove]`의 relPath 전부. 이 슬라이스는 계획까지만 하므로
마커 쓰기는 083이지만, `plannedDestRels()`를 여기서 노출해 083이 그대로 쓰게 한다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/restore_manifest.go`

```
type CleanupManifestEntry struct {
    RelPath          string
    Bytes            float64
    MtimeMS          float64
    PhysicalRelPaths []string
    ThreadID         *string
    RolloutPath      *string
    Archived         *float64  // nil + ArchivedPresent=true 이면 JSON null
    ArchivedPresent  bool
}
type TrashManifest struct {
    QuarantinedAt *float64
    Mode          string
    Entries       []CleanupManifestEntry
}
func ParseTrashManifest(raw []byte) *TrashManifest
func IsSafeArchivedPhysicalRel(rel string) bool
func jsonNumberFloat(value any) (float64, bool)   // UseNumber + ErrRange 보존
```

### 새 파일 `go/internal/storage/restore.go`

```
type RestoreErrorCode string
const (RestoreInvalidTrash, RestoreMissingTrash, RestoreFSFailed, RestoreDestExists, ...)

func ResolveTrashStageDir(trashID, codexHome string) (stageDir, id string, code RestoreErrorCode)
func absFromRel(codexHome, relPath string) (string, error)

type StagedFile struct{ From, To, RelPath string }
type RestorePlan struct {
    // 두 정체성을 모두 들고 간다. TrashDirID는 모든 RestoreResult.trashDir에
    // 들어가고, StageDir는 083이 위성 백업 읽기, pending 쓰기, tombstone rename에
    // 쓴다. StagedFile.From에서 역산하게 두면 문서화되지 않은 암묵 의존이 된다.
    TrashDirID   string
    StageDir     string
    AlreadyMoved []StagedFile
    ToMove       []StagedFile
    Entries      []CleanupManifestEntry
}
// 오라클의 `[...alreadyMoved, ...toMove].map(m => m.relPath)`와 정확히 같은
// 순서·중복으로 돌려준다. 이 값이 마커에 그대로 기록되므로 재정렬이나 중복 제거는
// 마커의 내용을 바꾸는 것이다.
func (p RestorePlan) PlannedDestRels() []string

// 진입: 스테이지 해석 -> manifest -> pending(invalid면 fs_failed) -> 트리밍 -> 계획
func PlanTrashRestore(trashID, codexHome string) (RestorePlan, RestoreErrorCode)
```

`RestoreResult`와 DB 프리플라이트, 락, 이동 실행, 부분 카운트는 **083**.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `.trash/` 접두사 없음 / rest 비었음(`.trash/`) / `..` 포함 / 내부 `/` / 정규식 불일치 | 전부 `invalid_trash` |
| 2 | `"  .trash/123///  "` | 정규화되어 유효, id는 `.trash/123` |
| 3 | POSIX에서 `.trash\123` | `invalid_trash` (백슬래시가 남는다) |
| 4 | 형식 유효하나 없는 스테이지 | `missing_trash` |
| 5 | 스테이지 경로가 파일 | `invalid_trash` |
| 6 | manifest: entries 부재/비배열/엔트리가 배열 / relPath 빈 문자열 / bytes 문자열 / bytes `1e400` / mtimeMs 누락 / physicalRelPaths 빈 배열 / 원소 빈 문자열 / threadId null / archived 문자열 | 전부 nil (11 케이스) |
| 7 | `{"mode":"other"}` / `{"quarantinedAt":1e400}` + 유효 엔트리 | **manifest 유효**, 해당 필드만 누락 |
| 8 | `{"archived":1e400}` | **엔트리 수용**, Archived가 +Inf |
| 9 | archived 부재 vs `null` | `ArchivedPresent`로 구분 |
| 10 | 물리 경로가 archived_sessions 밖 / `..` / 하위 디렉터리 / 비롤아웃 | `IsSafeArchivedPhysicalRel` false → `invalid_trash` |
| 11 | 물리 경로 2개 중 1개만 스테이지 존재 | 생존자만 남고 계획 진행 |
| 12 | 생존 0개 | `fs_failed` |
| 13 | 손상된 pending 마커 | `fs_failed`, **fail closed** |
| 14 | 수락된 목적지에 파일 있고 스테이지엔 없음 | `AlreadyMoved` |
| 15 | 목적지 있음 + 미수락 + **스테이지에도 없음** | `dest_exists` (리뷰어 지적 케이스) |
| 16 | 목적지 있음 + 수락됨 + **스테이지에 원본 있음** | `dest_exists` |
| 17 | `PlannedDestRels`, AlreadyMoved 1개 + ToMove 1개 | 정확히 `[alreadyMoved..., toMove...]` 순서, 중복 제거 없음 |
| 18 | 유효 manifest 뒤에 ` 0`이 붙은 입력 | nil (단일 문서 규칙) |
| 19 | 유효 마커 뒤에 ` 0` / 마커에 `"junk":1e400` / `pending` 안에 미지의 오버플로 필드 | 앞은 invalid, 뒤 둘은 **valid** (081 회귀 수정) |
| 20 | `absFromRel(home, "")` 직접 호출 | 에러. 정상 `archived_sessions/x.jsonl`은 성공 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 7): `missing_trash`→`invalid_trash` 병합, 최상위 선택 필드를
전체 거부로 승격, `UseNumber`를 표준 Unmarshal로 되돌림(두 파서 모두),
`alreadyMoved`에서 `!fromExists` 제거, `PlannedDestRels`를 ToMove로만 좁히기,
`absFromRel`에서 `Rel == "."` 검사 제거(기준 20이 잡는다),
두 번째 Decode의 `io.EOF` 검사 제거.

## 잠재 이슈로 기록 (이 슬라이스에서 손대지 않음)

`quarantine.go:115-138`의 `RenameNoReplace`는 EEXIST가 아닌 모든 link 오류를
`errRenameNoReplaceUnsupported`로 접는다. 오라클(`cleanup.ts:892-909`)은
EXDEV/EPERM/ENOTSUP/EINVAL만 변환하고 나머지는 그대로 재던진다. 083이 EEXIST만
`dest_exists`로, 나머지를 전부 `fs_failed`로 매핑하는 한 프록시 응답에서는 보이지
않는다(`rg` 결과 `IsRenameNoReplaceUnsupported`의 프로덕션 호출자 0건). 다만
**내보낸 Go API로서는 관측 가능한 divergence**이므로 083에서 이동 루프를 붙일 때
같이 좁힌다.
### 3b. 단일 문서만 받는다 (리뷰어 라운드 2)

`JSON.parse`는 값 하나만 받고 뒤에 다른 값이 붙으면 `SyntaxError`다. Go의
`Decoder.Decode`는 "다음 값 하나"를 읽으므로 뒤에 남은 것을 보지 않는다. 실측:

```
`{"entries":[]} 0`
  JSON.parse  -> SyntaxError
  Decode 1회  -> err=nil  (후행 ` 0`이 그대로 통과)
  Decode 2회  -> err=nil  (io.EOF 아님)
```

따라서 `UseNumber` 디코딩을 쓰는 **두 파서 모두**에서 첫 디코드 성공 후 두 번째
디코드를 호출해 `io.EOF`가 아니면 거부해야 한다. 이 규칙은
`ParseTrashManifest`와 수정될 `parseRestorePendingState` 양쪽에 적용된다.
