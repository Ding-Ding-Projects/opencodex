# 081 — restore-pending 저널과 진행 중 복원 보호 (wp8c-1)

부모 유닛: `080_storage_safety.md` §080.3. PHASE-SPLIT-01에 따라 §080.3 전체(7개 수용
기준 + 경쟁 계약)를 한 사이클로 삼지 않고, **가장 아래 의존성인 pending 저널 자체**만
먼저 닫는다. 이동 루프·메타데이터 조정·tombstone은 후속 슬라이스(082)에서 다룬다.

## 왜 이 슬라이스가 먼저인가

`restoreTrashEntry`의 크래시 안전성은 단 하나의 파일 위에 서 있다:
`.trash/<epoch>/restore-pending.json`. 이 마커가 없으면 중단된 복원은 이미 옮겨진
파일을 "목적지 선점"으로 오인해 `dest_exists`로 영구히 막히고, 마커를 잘못 읽으면
이미 옮겨진 파일을 무시한 채 새 복원을 시작한다. 저널의 읽기/쓰기/파싱 계약이 정확해야
이동 루프를 포팅할 의미가 있다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:755` — `RESTORE_PENDING_FILE = "restore-pending.json"`
- `src/storage/cleanup.ts:767-778` — `RestorePendingState`
- `src/storage/cleanup.ts:2284-2320` — `RestorePendingRead`, `parseRestorePendingState`
- `src/storage/cleanup.ts:2322-2337` — `readRestorePending`
- `src/storage/cleanup.ts:2339-2369` — `writeRestorePending`
- `src/storage/cleanup.ts:352-361` — `candidateOverlapsPendingRestore`
- `src/storage/cleanup.ts:363-372` — `filterCandidatesExcludingPendingRestore`
- `src/storage/cleanup.ts:377-418` — percent / reduceToBytes 스킵 선택
- `src/storage/cleanup.ts:419-431` — `collectRestorePendingAcceptedDestRels`
- `src/storage/cleanup.ts:433-446` — `previewArchivedCleanup`
- `src/storage/cleanup.ts:2513-2527` — `failClosedSatelliteResume`

## 실측된 현재 결함

측정 명령: `rg -n "PreviewArchivedCleanup|SelectOldestPercent" go/ --type go`

Go `PreviewArchivedCleanup`(`go/internal/storage/cleanup.go:266-268`)은
`SelectOldestPercent`를 호출한다. TS `previewArchivedCleanup`은
`selectOldestPercentSkippingPendingRestore`를 호출한다. 즉 **Go 미리보기는 진행 중인
복원이 배치 중인 롤아웃 파일을 삭제 후보로 내놓고, 그 후보들을 다이제스트에 포함한다.**

**영향 범위 정정 (리뷰어 라운드 1이 내 최초 서술을 바로잡음).** 나는 처음에 이것을
즉시 도달 가능한 데이터 손실 경로라고 썼는데 틀렸다. `go/internal/storage/cleanup.go:14-19`이
명시하듯 현재 Go 쪽은 읽기 전용이라 아무것도 격리하거나 삭제하지 못하며,
`rg -rn "PreviewArchivedCleanup" go/`는 프로덕션 호출자를 0건 반환한다. 따라서 지금의
실제 피해는 **잘못된 미리보기와 잘못된 다이제스트**이고, 데이터 손실은 실행 슬라이스가
포팅된 뒤에 열린다. 틀린 다이제스트는 나중에 apply 단계의 **실행 검증**을 오염시킨다 —
구체적으로 오라클은 겹침으로 인한 불일치를 `stale_preview`가 아니라
`restore_pending_overlap`으로 구분하는데(`cleanup.ts:1763-1779`), 필터가 없으면
그 구분 자체가 성립하지 않는다. 그 실행 로직은 082 소관이다.

Go에는 pending 마커 개념 자체가 없다(`rg -n "restore-pending" go/` → 0건).

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/restore_pending.go`

```
const RestorePendingFile = "restore-pending.json"

type RestorePendingSections struct {
    State    bool `json:"state"`
    Logs     bool `json:"logs"`
    Memories bool `json:"memories"`
    Goals    bool `json:"goals"`
}
type RestorePendingState struct {
    Version          int                    `json:"version"`
    FilesRestored    bool                   `json:"filesRestored"`
    AcceptedDestRels []string               `json:"acceptedDestRels"`
    Pending          RestorePendingSections `json:"pending"`
}

type RestorePendingStatus int   // missing / valid / invalid
type RestorePendingRead struct { Status RestorePendingStatus; State *RestorePendingState }
```

**JSON 태그는 선택이 아니라 정확성 요건이다** (리뷰어 블로커 #10, 재현함).
태그 없는 구조체를 `json.Marshal`하면 `{"Version":1,"FilesRestored":true,
"AcceptedDestRels":["a"]}`가 나온다(`/tmp/jsontag_probe.go` 실행으로 확인). 오라클
파서는 소문자 `o.version`/`o.filesRestored`를 읽으므로 그 마커를 `invalid`로 판정한다.
즉 태그를 빠뜨리면 **Go가 쓴 마커를 TS 런타임도, 이 슬라이스의 자체 파서도 읽지 못한다.**
왕복 테스트가 이것을 잡도록 수용 기준 5에 모드·키 이름 검증을 포함한다.

`AcceptedDestRels`는 nil일 때 `null`로 직렬화되는데 오라클 파서는 배열이 아니면
거부한다. 항상 non-nil 슬라이스로 정규화해서 쓴다.

- `parseRestorePendingState(raw []byte) *RestorePendingState`
  - 최상위가 객체가 아니면(배열·스칼라·null 포함) nil.
  - `version !== 1` 또는 `filesRestored !== true` → nil. **엄격 비교**이므로
    `version: "1"`, `filesRestored: "true"`도 거부한다. Go에서는
    `map[string]any` 디코드 후 `v, ok := o["version"].(float64); ok && v == 1`로
    재현한다. 리뷰어가 계산해 확인한 동치성: `1`, `1.0`, `1e0`은 TS `!== 1`을
    통과하고 float64 비교도 통과한다. `9007199254740993`은 양쪽 모두 거부되고
    `1e400`은 양쪽 모두 Inf가 되어 거부된다. **`json.Number`가 아니라 기본
    `float64` 디코드가 오라클과 일치한다.**
  - `acceptedDestRels`가 배열이 아니면 nil. **원소 중 하나라도 string이 아니면
    필터 길이가 달라져 nil** — 부분 수용이 아니라 전체 거부다.
  - `pending`의 4개 필드가 모두 boolean이 아니면 nil (누락도 거부).
- `ReadRestorePending(stageDir string) RestorePendingRead`
  - 파일 부재는 `missing`, 존재하지만 파싱 실패는 `invalid`.
  - **이 구분이 계약의 핵심**: `invalid`를 `missing`으로 접으면 이미 옮겨진 파일을
    무시한 새 복원이 시작된다(`cleanup.ts:2323` 주석).
  - NotExist가 아닌 읽기 오류(권한 등)는 `invalid`. TS도 `readFileSync`의 catch로
    떨어져 같은 결과가 된다.
- `WriteRestorePending(stageDir string, state RestorePendingState) error`
  - 스테이지 안의 비공개 temp → fsync → rename. temp 이름은
    `restore-pending.json.<pid>.<seq>.tmp`, seq는 프로세스 전역 단조 증가.
  - 실패 경로: write/fsync 실패 시 close 후 temp unlink 하고 에러 반환.
    rename 실패 시에도 temp unlink. **중단된 갱신은 이전 유효 마커를 남긴다.**
  - 0600으로 열고, 성공 후 `chmodPrivatePath(tmp, 0600)`.
  - **rename은 단일 `os.Rename`이다. `renameAtomic`을 쓰지 않는다**
    (리뷰어 MAJOR #8, 재현함). 오라클은 이 지점에서 `renameSync`
    (`cleanup.ts:2367`)를 쓰고, `renameAtomicFile`의 Windows 25/50ms 재시도는
    위성 백업 쪽(`cleanup.ts:1035`)에만 쓴다. Go에서 재시도를 붙이면 TS가 실패하는
    일시적 Windows 공유 위반에서 Go만 성공한다 — 오라클보다 "더 안전한" 쪽으로의
    divergence이며 금지 대상이다.
  - **디렉터리 fsync를 하지 않는다.** 오라클은 여기서 하지 않는다.
    `fsyncDirectoryBestEffort`는 위성 백업 쓰기 전용으로 남긴다.
- `CollectRestorePendingAcceptedDestRels(codexHome string) (map[string]struct{}, error)`
  - `.trash` 아래에서 `TrashEpochDirPattern`에 맞는 이름만 스캔.
  - `valid`인 마커의 `acceptedDestRels`만 합집합. `invalid`는 **건너뛴다**
    (오라클과 동일 — 손상 마커는 여기서 보호를 제공하지 않는다).
  - **에러 채널 없음, 의도적 divergence 아님** (리뷰어 MAJOR #11에 대한 답).
    오라클은 `existsSync` 후 가드 없는 `readdirSync`라 읽을 수 없는 `.trash`에서
    throw하고, 그 throw는 `previewArchivedCleanup` 호출자까지 전파된다. 그러나
    Go 쪽 형제 함수 `ListArchivedCandidates`(`cleanup.go:133-138`)는 이미
    `os.ReadDir` 오류를 빈 결과로 삼키는데, 이는 오라클
    `listArchivedCandidates`가 `try/catch`로 `[]`를 돌려주는 것과 정확히 같다.
    **즉 두 함수의 오라클 동작이 서로 다르다**: 후보 나열은 삼키고, pending 수집은
    던진다. 이 슬라이스는 그 차이를 보존한다 — Collect는
    `(map[string]struct{}, error)`를 돌려주고, 셀렉터와 Preview가 에러를 위로
    전파한다. Preview 시그니처가 바뀌므로 기존 호출자(테스트 2곳)도 함께 고친다.
  - 개별 스테이지의 마커 읽기 실패는 `invalid`로 흡수되고 에러가 되지 않는다.
    에러는 `.trash` 루트 자체를 열지 못한 경우에만 나온다.
- `CandidateOverlapsPendingRestore(c ArchivedCandidate, pending map[string]struct{}) bool`
  - 물리 경로 중 하나라도 일치하면 true. 그다음 논리 `RelPath`도 검사.
  - pending이 비었으면 즉시 false (핫 패스).
**`FailClosedSatelliteResume`은 이 슬라이스에서 제외한다** (리뷰어 블로커 #9,
재현함: `rg -n "SatelliteBackup" go/internal/storage/*.go`는 타입이 아니라
`WriteSatelliteBackup(stageDir string, backup any)`만 보여준다). 그 헬퍼는
`SatelliteBackup` 모델과 `pendingSections` 초기화(`cleanup.ts:2668-2673`)에
의존하므로 082 복원 슬라이스에서 그 모델과 함께 들어간다. 수용 기준 10을 삭제한다.

### 수정 `go/internal/storage/cleanup.go`

**시그니처 전체를 확정한다** (리뷰어 MAJOR #2 — 초안이 Collect의 반환형을 두 군데에
다르게 적어 내부 모순이었다):

```
func FilterCandidatesExcludingPendingRestore(candidates []ArchivedCandidate, codexHome string) ([]ArchivedCandidate, error)
func SelectOldestPercentSkippingPendingRestore(candidates []ArchivedCandidate, percent float64, codexHome string) ([]ArchivedCandidate, error)
func SelectReduceToBytesSkippingPendingRestore(candidates []ArchivedCandidate, reduceToBytes float64, codexHome string) ([]ArchivedCandidate, error)
func PreviewArchivedCleanup(codexHome string, percent float64) (CleanupPreview, error)
func PreviewExactArchivedCleanup(candidates []ArchivedCandidate, codexHome string) (CleanupPreview, error)
```

- `SelectOldestPercentSkippingPendingRestore`: **퍼센트 예산을 소비하지 않고 스킵**한다.
  목표 개수는 전체 후보 수 기준으로 계산하고, 스킵된 항목 자리를 다음 오래된 안전
  후보로 채우되 목표 도달 **또는 안전 후보 소진** 시 멈춘다.
- `SelectReduceToBytesSkippingPendingRestore`: `reduceToBytes`가 NaN/±Inf이거나
  음수면 빈 결과. 총합이 목표 이하면 빈 결과.

**조기 반환 순서를 오라클대로 보존한다** (리뷰어 MAJOR #3). 오라클은 두 셀렉터 모두
Collect를 **호출하기 전에** 조기 반환한다: percent 쪽은 `target === 0`에서
(`cleanup.ts:382-384`), reduceToBytes 쪽은 비유한/음수와 `total <= target`에서
(`cleanup.ts:403-407`). 따라서 **읽을 수 없는 `.trash`가 항상 Preview 실패를 뜻하지
않는다** — percent 0이거나 후보가 없으면 `.trash`를 건드리지도 않고 성공한다.
Go도 이 조기 반환들에서는 `nil` 에러를 돌려주고, Collect에 도달한 뒤에만 에러를
전파한다.

**`CleanupPreview`에 `CodexHome string` 필드를 추가한다** (리뷰어 MAJOR #8).
오라클 `CleanupPreview`는 `codexHome`을 갖고(`cleanup.ts:69-74`) 두 preview 생성자가
모두 채우는데(`440-446`, `456-463`) Go 타입(`cleanup.go:257-263`)에는 없다. 이것은
이 슬라이스가 두 번째 preview 생성자를 추가하기 때문에 지금 닫아야 한다.
관리 API 응답에는 절대 경로가 나가지 않는다는 점은 오라클도 동일하다
(`logs-usage-routes.ts:257`에서 `codexHome`을 와이어에서 제외).
- `PreviewExactArchivedCleanup(candidates, codexHome)` 추가
  (`cleanup.ts:451-463`): `percent`는 0으로 고정, 필터링된 집합으로
  `ComputeExactPreviewDigest`를 계산한다.
- `PreviewArchivedCleanup`의 `SelectOldestPercent` 호출을
  `SelectOldestPercentSkippingPendingRestore`로 교체 — **위에서 실측한 결함의 수정.**

### 082 이후로 명시 이관 (이 슬라이스에서 다루지 않음)

리뷰어 MAJOR #12가 요구한 대로 남은 오라클 사용처를 유실 없이 배정한다:

- `cleanup.ts:1764-1779` 실행 시점 `restore_pending_overlap` 거부 — **082**.
  미리보기 필터링만으로는 이 계약이 서지 않는다. apply 단계에서 다이제스트가 어긋날 때
  "겹침 때문인지 drift 때문인지"를 구분해 `restore_pending_overlap`을 돌려주는
  로직이며, 관리 API 문구(`src/server/management/logs-usage-routes.ts:305,314`)가
  이 코드에 묶여 있다.
- `src/storage/policy.ts:354,368` 정책 선택 경로 — **wp8d(080.4)**.
- `cleanup.ts:2111-2115` 스테이지 파일 계수에서 마커 제외 — **082**.
- `cleanup.ts:2984-2993` 완결성 게이트에서 마커 제외 — **082**.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 마커 없는 스테이지 | `ReadRestorePending` → `missing`, State nil |
| 2 | 유효 마커 | `valid`, acceptedDestRels·pending 4필드 정확히 복원 |
| 3 | `version: 2` / `"1"` / `filesRestored: "true"` / pending 필드 누락 / acceptedDestRels에 숫자 혼입 / 최상위 배열 / 잘린 JSON | 전부 `invalid` (7 케이스) |
| 4 | 읽을 수 없는 마커(0000) | `invalid`, `missing` 아님 |
| 5 | Write 후 Read 왕복 | 동일 state, 파일 모드 0600, temp 잔재 없음 |
| 6 | Write 중 rename 실패 주입 | 이전 유효 마커가 그대로 남고 temp 제거됨 |
| 7 | 두 스테이지에 각각 유효/손상 마커 | Collect가 유효한 쪽 rel만 반환 |
| 8 | pending 목적지와 겹치는 후보 | Preview가 그 후보를 제외하고 다음 오래된 후보로 백필한다. 목표 개수는 **전체 후보 수 기준으로 계산**되고, 안전 후보가 모자라면 소진 시점에 멈춘다(`cleanup.ts:382-391`). 반환 `Percent`는 스킵과 무관하게 `ClampPercent(percent)` 그대로 |
| 9 | reduceToBytes 선택 | pending 겹침은 건너뛰고 바이트에 계상되지 않음. NaN/±Inf/음수는 빈 결과(`math.IsNaN`/`math.IsInf`) |
| 10 | 읽을 수 없는 `.trash` 루트 + **후보 1개 이상 + 활성 셀렉터**(percent>0) | Collect가 에러를 반환하고 Preview가 그것을 전파. 개별 스테이지의 손상 마커는 에러가 아님 |
| 10b | 같은 읽을 수 없는 `.trash`에서 percent=0 / 후보 0개 / `total <= reduceToBytes` | **에러 없이 빈 결과** — 오라클이 Collect 전에 반환하므로 |
| 11 | 태그 없는 직렬화 회귀 | 기록된 마커의 원시 바이트에 `"version"`, `"filesRestored"`, `"acceptedDestRels"`, `"pending"` 키가 소문자로 존재 |
| 12 | `AcceptedDestRels`가 nil인 state를 기록 | 원시 JSON에 `"acceptedDestRels":[]`가 있고(`null` 아님), 되읽으면 `valid` + 빈 목록. `Array.isArray(null)`이 false라 오라클은 `null`을 거부한다(`cleanup.ts:2296`) |
| 13 | 두 preview 생성자 | `CodexHome`이 채워짐. exact 쪽 `Percent`는 0 |

## 검증

동시 세션이 다른 패키지를 계속 고치고 있으므로 이 슬라이스의 게이트는 storage 한정이다:

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

`go build ./...`과 파리티 스위트 전체는 wp12 수렴 사이클의 게이트로 남긴다.

뮤테이션(최소 5): `invalid`→`missing` 접기, 엄격 version 비교 완화,
acceptedDestRels 부분 수용, Preview의 스킵 제거, JSON 태그 제거.
각각 최소 1개 테스트가 FAIL해야 한다.
