# 083 — 위성 백업 읽기, 경로 remap, 재개 fail-closed (wp8c2b1)

부모 유닛: `080_storage_safety.md` §080.3. 082(진입 검증·이동 계획) 다음.

## 왜 또 쪼개는가

082의 리뷰어 블로커가 확정한 사실: 오라클은 **첫 rename보다 먼저** 위성 백업을 읽고
경로를 remap하고 resume을 검증하고 state DB를 probe하고 위성 락을 잡는다. 그 전체가
한 덩어리라는 뜻은 아니다. 그 안에서도 **DB 핸들을 열지 않는 앞부분**이 있다:

```
discoverRuntimeDbPaths      <- 디렉터리 나열만
readSatelliteBackupFile     <- 파일만 읽는다
remapSatelliteBackupPaths   <- 순수 함수
failClosedSatelliteResume   <- 순수 함수
pendingSections 초기화       <- 순수 함수
needAnySatellite 계산        <- 순수 함수
needsThreads + state DB 존재 가드  <- existsSync만, 핸들 없음
---- 여기까지가 이 슬라이스 ----
probeStateDbWritable        <- DB 연다
beginSatelliteWriteLocks    <- DB 연다, 락 잡는다
이동 루프
```

**초안은 절단면을 세 함수에서 끊었는데, 리뷰어가 그 사이에 주인 없는 단계가 남는다고
지적했고 맞았다.** `cleanup.ts:2626`의 경로 발견과 `2676-2690`의 `needsThreads` 가드는
082에도 초안 083에도 배정되지 않은 채였다. 그 가드는 `existsSync`만 쓰므로 DB 핸들
경계 이쪽이다. 이제 **`probeStateDbWritable` 직전까지** 전부 이 슬라이스가 가져간다.

082의 "이동 루프와 DB 프리플라이트, 락이 083으로 간다"는 서술도 이에 맞춰 정정된다:
083은 프리플라이트의 핸들 없는 앞부분이고, probe·락·이동은 wp8c2b2다.

## 오라클 (읽기 전용)

- `src/storage/cleanup.ts:706-729` — `SqlRow`, `SatelliteBackup`
- `src/storage/cleanup.ts:2186-2200` — `readSatelliteBackupFile`, `SatelliteBackupRead`
- `src/storage/cleanup.ts:859-882` — `remapSatelliteBackupPaths`
- `src/storage/cleanup.ts:2513-2527` — `failClosedSatelliteResume`
- `src/storage/cleanup.ts:2627-2673` — 호출 순서와 `pendingSections` 초기화

## 계약

### 0. 검증은 오라클만큼 얕아야 한다 (리뷰어 BLOCKER 1)

초안은 `ThreadIDs []string`과 구조화된 `SatelliteSection`을 제안했다. 그러면 오라클이
받아들이는 백업을 Go가 거부한다. 실측:

```
{"threadIds":[1]}            -> TS status ok
{"threadIds":[null]}         -> TS status ok
{"threadIds":[],"logs":[]}   -> TS status ok
```

오라클은 `threadIds`가 **배열이기만** 하면 되고 원소를 보지 않으며, `logs`가 배열이든
숫자든 신경 쓰지 않는다. 실제 형태 검증은 한참 뒤 소비 지점의 `isSqlRowArray`
(`cleanup.ts:2401-2403`, `2462-2466`)에서 일어난다.

따라서 이 슬라이스는 **어떤 중첩 값도 타입 디코드하지 않는다.** 최상위 문서를
`decodeSingleJSONDocument`의 `map[string]any` 결과 그대로 들고, `threadIds`는
배열인지만 확인한다. `json.RawMessage`는 쓰지 않는다 — 아래 truthiness 계산이
원시 바이트가 아니라 디코드된 값을 요구하기 때문이다.

### 1. 백업 읽기는 세 상태다

`missing` / `ok` / `invalid`. pending 마커와 같은 이유로 구분이 살아 있어야 한다:
백업이 **없는** 것은 위성 작업이 애초에 없었다는 뜻이고, **손상된** 것은 위성 행을
복원할 수 없다는 뜻이라 `db_reconcile_failed`로 끝나야 한다.

검증은 최상위가 객체이고 `threadIds`가 배열이면 `ok`다(`cleanup.ts:2192-2194`).

**읽기 오류 분류** (리뷰어 MAJOR): `existsSync`가 false일 때만 `missing`이다. 그 뒤의
어떤 읽기·파싱 실패도 catch에 걸려 `invalid`가 된다. 즉 파일 자리에 디렉터리가 있거나
권한이 없으면 `invalid`다. 이것을 `missing`으로 접으면 손상된 백업이 "백업 없음"
경로를 타게 되는데, TS는 거기서 `db_reconcile_failed`를 낸다.

### 2. 저장된 경로는 신뢰하지 않는다

`remapSatelliteBackupPaths`는 백업에 적힌 `path`를 **현재 런타임에서 발견한 경로로
덮어쓴다**. 섹션이 백업에 있는데 현재 그 DB가 없으면 `{ok:false}` → 호출자가
`db_reconcile_failed`. 이것은 보안 성질이기도 하다: 백업 파일은 사용자가 편집할 수
있고, 거기 적힌 경로를 그대로 열면 임의 SQLite 파일에 쓰게 된다.

`threadIds`/`threads`/`dynamicTools`/`spawnEdges`는 경로가 없으므로 그대로 옮긴다.

**조건은 키 존재가 아니라 JS truthiness다** (리뷰어 MAJOR, 내가 독립적으로 재현함).
오라클의 `...(backup.threads ? {threads} : {})`와 `if (backup.logs)`는 전부
truthiness 검사다. 실측:

```
{"threads":null} -> remap 결과에서 빠짐,  Boolean = false
{"threads":0}    -> 빠짐,                Boolean = false
{"threads":[]}   -> 남음,                Boolean = true
{"logs":null}    -> remap이 ABSENT로 취급, pendingSections.logs = false,
                    failClosed가 "logs 없음"으로 판단
```

`json.RawMessage`의 nil로는 이것을 표현할 수 없다. 실측:

```
absent  : nil=true   value=""
null    : nil=false  value="null"     <- 부재가 아니다
present : nil=false  value="[1,2]"
```

따라서 **`decodeSingleJSONDocument`의 untyped 결과에서 JS truthiness를 직접 계산**하고
그 불리언을 조건으로 쓴다. `RawMessage != nil`을 조건으로 쓰면 `"logs":null`인 백업이
logs 섹션을 가진 것으로 취급되어, 재개가 존재하지 않는 백업 섹션을 기다리게 된다.

JS truthy 판정: `null`/`false`/`0`/`-0`/`""`는 falsy, 그 외 객체·배열·비어있지 않은
문자열·0이 아닌 숫자는 truthy. `[]`와 `{}`는 **truthy**다.

**숫자는 `json.Number`로 도착한다** (리뷰어 라운드 2 MAJOR). `UseNumber`를 쓰므로
`map[string]any`의 숫자는 `float64`가 아니라 `json.Number`다. `float64`만 처리하는
타입 스위치는 모든 숫자 필드를 잘못 판정한다. `jsTruthy`는 `json.Number`를
`jsonNumberValue`로 변환해야 하고, 그러면 `1e400`은 `+Inf`가 되어 **truthy**가 된다
(JS도 동일). `NaN`은 JSON 리터럴로 올 수 없다 — `JSON.parse("NaN")`은 던진다 —
므로 별도 처리가 필요 없지만, 방어적으로 falsy로 둔다.

### 2b. `?.length`는 배열 길이가 아니라 속성 접근이다 (리뷰어 라운드 2 BLOCKER)

초안은 `needsThreads`를 "`backup.threads`의 길이가 0이 아님"이라고 썼다. 오라클은
`Boolean(satelliteBackup?.threads?.length)`인데, 이것은 **어떤 값에서든 `length`
프로퍼티를 읽는** JS 연산이다. 실측:

```
{"threads":"x"}            -> needsThreads = true   (문자열 길이 1)
{"threads":{"length":1}}   -> needsThreads = true   (객체의 length 멤버)
{"threads":{"length":"0"}} -> needsThreads = true   ("0"은 truthy 문자열!)
{"threads":7}              -> needsThreads = false  (숫자에 length 없음)
{"threads":[]}             -> needsThreads = false  (길이 0)
```

`[]any`만 인식하는 Go 구현은 앞의 세 케이스에서 TS가 거부하는 복원을 통과시킨다.
따라서 `lengthTruthy(value any) bool`를 별도로 정의한다:

| 값 | `length` | 결과 |
| --- | --- | --- |
| `[]any` | 원소 수 | 0이면 false |
| `string` | 문자 수 | 빈 문자열이면 false |
| `map[string]any` | `value["length"]` | 그 멤버에 `jsTruthy` 적용 |
| 그 외 (숫자·불리언·nil·부재) | 없음 | false |

`threadIds`에도 같은 함수를 쓴다 — 오라클이 `?.threadIds?.length`로 똑같이 읽는다.

### 3. 재개는 구간별로 fail closed

`failClosedSatelliteResume`: 빚진 구간이 하나도 없으면 통과. 하나라도 있는데
백업이 없으면 `db_reconcile_failed`. 구간별로 백업에 해당 섹션이 없으면
`db_reconcile_failed`. **`state`는 검사하지 않는다.**

초안은 그 이유를 "state는 백업이 아니라 manifest와 롤아웃에서 복원되므로"라고 썼는데
리뷰어가 정확하지 않다고 지적했고 맞다. state 복원은 `backup.threadIds`와 선택적
`threads`/`dynamicTools`/`spawnEdges`를 **실제로 소비한다**(`cleanup.ts:2374-2467`).
정확한 불변식은 이렇다: **백업의 state 스냅샷은 가속기이지 유일한 출처가 아니다.**
manifest와 롤아웃에서 재구성하는 경로가 남아 있으므로 섹션이 없어도 fail closed할
이유가 없다. 위성 세 구간은 그런 대체 경로가 없어서 fail closed다.

구현 시 주의: 이 설명을 문자 그대로 "state는 백업을 안 쓴다"로 읽고 스냅샷을 버리면
안 된다.

### 4. `pendingSections` 초기화

```
state:    prior ? prior.state    : true
logs:     prior ? prior.logs     : Boolean(backup?.logs)
memories: prior ? prior.memories : Boolean(backup?.memories)
goals:    prior ? prior.goals    : Boolean(backup?.goals)
```

재개일 때는 **이전 마커의 값을 그대로** 쓴다. 백업에서 다시 계산하면 이미 커밋된
구간을 다시 빚진 것으로 만든다. 신규일 때만 백업 유무로 정한다. `state`의 신규
기본값은 `true`인데, 백업과 무관하게 스레드 메타데이터는 항상 조정 대상이기 때문이다.

## BLOB 라운드트립은 이 슬라이스에서 열지 않는다

기록된 NEEDS_HUMAN: Bun은 `Uint8Array`를 `{"0":0,"1":1,...}`로 쓰고 Go는 `[]byte`를
base64로 쓴다. 두 표현은 서로 읽을 수 없다. **이 슬라이스는 행 값을 해석하지 않는다** —
`readSatelliteBackupFile`이 검증하지 않는 것처럼, 여기서는 `logs.rows` 등을
`map[string]any` 안에 디코드된 채로 두되 **읽지도 재직렬화하지도 않는다.** 실제 행
바인딩은 커밋 단계(wp8c2b2)의 일이고, 그때 태그된 코덱 결정이 필요하다. 지금
`SqlRow`를 구체 타입으로 디코드하면 그 미해결 결정을 암묵적으로 내리게 된다.

표현은 문서 전체에서 하나다: `decodeSingleJSONDocument`의 `map[string]any`.
이중 표현(`json.RawMessage` + 디코드값)을 두지 않는다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/satellite_read.go`

```
type SatelliteBackupStatus int  // missing / ok / invalid

// SatelliteBackup는 최상위 키를 미해석 상태로 들고 다닌다. 중첩 값을 타입
// 디코드하면 오라클이 받아들이는 백업을 거부하게 된다.
type SatelliteBackup struct {
    fields map[string]any   // decodeSingleJSONDocument 결과 그대로
}

func (b *SatelliteBackup) Has(section string) bool          // JS truthiness
func (b *SatelliteBackup) LengthTruthy(key string) bool      // JS ?.length 의미론
// SectionPath는 REMAP된 백업에서만 유효하다. 부재·falsy·미지 섹션은 "".
// truthy이기만 하면 값의 모양과 무관하게 발견된 런타임 경로를 돌려준다.
func (b *SatelliteBackup) SectionPath(section string) string

func ReadSatelliteBackupFile(stageDir string) (*SatelliteBackup, SatelliteBackupStatus)
func RemapSatelliteBackupPaths(backup *SatelliteBackup, paths RuntimeDBPaths) (*SatelliteBackup, bool)
func FailClosedSatelliteResume(owed RestorePendingSections, backup *SatelliteBackup) RestoreErrorCode
func InitialPendingSections(prior *RestorePendingState, backup *SatelliteBackup) RestorePendingSections
func jsTruthy(value any) bool
func lengthTruthy(value any) bool

// probe 직전까지의 핸들 없는 프리플라이트 전체
type RestorePreflight struct {
    Paths            RuntimeDBPaths
    Backup           *SatelliteBackup
    Pending          RestorePendingSections
    NeedAnySatellite bool
}
// prior는 인자가 아니라 plan이 들고 온다. 마커를 두 번 읽으면 계획과 프리플라이트가
// 서로 다른 마커를 볼 수 있고(TOCTOU), 오라클은 한 번만 읽는다.
func PrepareRestorePreflight(plan RestorePlan, codexHome string) (RestorePreflight, RestoreErrorCode)
```

`RestorePlan`에 필드를 추가한다 (082 수정):

```
// PriorPending은 계획 단계에서 읽은 그 마커다. nil이면 신규 복원.
PriorPending *RestorePendingState
```

`PrepareRestorePreflight`가 `cleanup.ts:2626-2690`을 순서대로 재현한다: 경로 발견 →
백업 읽기(`invalid`면 `db_reconcile_failed`) → remap(실패면 `db_reconcile_failed`) →
resume fail-closed → pendingSections 초기화 → `needAnySatellite` →
`pendingSections.state`일 때 `needsThreads` 가드. **probe는 호출하지 않는다.**

`needsThreads` = manifest 엔트리 중 `threadId`가 문자열인 것이 있거나,
`lengthTruthy(threadIds)`이거나, `lengthTruthy(threads)`.
참인데 `paths.State`가 비었거나 존재하지 않으면 `db_reconcile_failed`.

### remap이 섹션 값을 어떻게 다루는가

오라클은 `next.logs = { ...backup.logs, path: paths.logs }`다. 실측:

```
[]                            -> {"path":"/runtime/logs.sqlite"}
7                             -> {"path":"/runtime/logs.sqlite"}
"text"                        -> {"0":"t",...,"path":"/runtime/logs.sqlite"}
{"path":"/evil.sqlite",...}   -> {"path":"/runtime/logs.sqlite",...}
```

즉 **truthy이기만 하면 모양과 무관하게 객체가 되고 `path`는 항상 런타임 값으로
덮인다.** 저장된 `/evil.sqlite`는 절대 살아남지 못한다 — 이것이 §2의 보안 성질이다.
Go는 문자열의 인덱스 프로퍼티까지 재현할 필요는 없다(그 필드를 읽는 소비자가 없다).
대신 계약을 이렇게 고정한다: truthy 섹션이면 `SectionPath`가 발견된 런타임 경로를
돌려주고, 런타임 DB가 없으면 remap이 실패한다.

`RestoreDBReconcileFailed` 에러 코드를 `restore.go`에 추가한다.

파싱은 082의 `decodeSingleJSONDocument`를 재사용한다 — 같은 오버플로/후행값 규칙이
적용되어야 한다.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 백업 파일 없음 | `missing`, nil |
| 2 | `threadIds`가 있는 최소 백업 | `ok` |
| 3 | 최상위가 배열/스칼라/null / `threadIds` 부재 / `threadIds`가 객체 / 잘린 JSON / 후행 값 | 전부 `invalid` (6 케이스) |
| 3b | 백업 파일 자리에 디렉터리 | `invalid`, `missing` 아님 |
| 3c | `{"threadIds":[],"junk":1e400}` | `ok` — 오버플로 숫자가 백업을 무효화하지 않는다 |
| 4 | `{"threadIds":[1]}` / `{"threadIds":[null]}` / `{"threadIds":[],"logs":[]}` / `{"threadIds":[],"threads":7}` | 전부 **`ok`** — 오라클은 여기서 검증하지 않는다 |
| 5 | `logs` 섹션 있고 런타임 logs DB 있음 | remap 성공, path가 **런타임 경로로 교체됨** |
| 6 | `logs` 섹션 있고 런타임 logs DB 없음 | remap 실패 |
| 7 | memories / goals 각각 동일 | 동일 |
| 8 | 섹션이 하나도 없음 | remap 성공, 섹션 부재 유지 |
| 8b | `{"logs":null}` / `{"logs":0}` / `{"logs":""}` | remap이 **부재로 취급**(런타임 logs DB가 없어도 성공), `Has("logs")` false |
| 8c | `{"logs":[]}` / `{"logs":{}}` / `{"logs":1}` / `{"logs":"x"}` | **존재로 취급**. 런타임 logs DB가 있으면 `SectionPath`가 그 경로, 없으면 remap 실패 |
| 8d | `{"logs":{"path":"/evil.sqlite"}}` + 런타임 logs DB 존재 | `SectionPath`가 **런타임 경로**, `/evil.sqlite` 아님 |
| 9 | `threadIds`/`threads`/`dynamicTools`/`spawnEdges` | remap이 그대로 보존, 없던 키는 계속 없음 |
| 10 | 빚진 구간 없음 | `FailClosedSatelliteResume` = OK (백업이 nil이어도) |
| 11 | logs 빚졌는데 백업 nil | `db_reconcile_failed` |
| 12 | logs 빚졌는데 백업에 logs 없음 | `db_reconcile_failed` |
| 13 | logs 빚졌고 백업에 logs 있음, memories도 빚졌는데 백업에 없음 | `db_reconcile_failed` |
| 14 | state만 빚짐 | **OK** — state는 검사 대상이 아니다 |
| 15 | prior 없음 + 백업에 logs만 있음 | sections = {state:true, logs:true, memories:false, goals:false} |
| 16 | prior 있음(logs 이미 완료) + 백업에 logs 있음 | sections.logs = **false** (prior 우선) |
| 17 | `pendingSections.state` 참 + threadId 있는 엔트리 + state DB 없음 | `db_reconcile_failed` |
| 18 | 같은 상황에서 state DB 존재 | 프리플라이트 통과 (probe는 이 슬라이스 밖) |
| 19 | `pendingSections.state` 참인데 threadId도 threadIds도 threads도 없음 | state DB가 없어도 이 가드는 통과 (뒤이은 probe는 이 슬라이스 밖) |
| 19b | `{"threads":"x"}` / `{"threads":{"length":1}}` / `{"threads":{"length":"0"}}` + state DB 없음 | 전부 `db_reconcile_failed` |
| 19c | `{"threads":7}` / `{"threads":[]}` + state DB 없음 | 통과 — `length`가 없거나 0 |
| 21 | `jsTruthy(json.Number)` | `0`/`-0` falsy, `1`·`1e400`(=+Inf) truthy |
| 20 | `needAnySatellite` | logs/memories/goals 중 하나라도 빚지면 참 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 9): `invalid`→`missing` 접기, remap이 저장된 경로를 유지,
누락 DB에서 remap 성공, fail-closed에 `state` 추가, `InitialPendingSections`가
prior 대신 백업을 재계산, `jsTruthy`를 키 존재 검사로 대체,
`needsThreads` 가드 제거, `lengthTruthy`를 `[]any` 전용으로 축소,
`jsTruthy`가 `json.Number`를 무조건 truthy로 처리.
