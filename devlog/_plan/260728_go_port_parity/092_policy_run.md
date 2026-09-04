# 092 — 정책 실행 흐름 (wp8d2b1)

부모 유닛: `080_storage_safety.md` §080.4. 091(due 판정·선택) 다음.

## 절단면

```
runStorageCleanupPolicy + commitPolicyRunMetadata  <- 이 슬라이스
단일 비행 작업 관리자 + 10분 워커 타임아웃          <- 093
스케줄러 티커 + 종료 소유권                        <- 094
```

실행 흐름은 주입된 `load`/`save`/`execute`/`now`로 돌아가는 결정론적 함수다.
goroutine과 타임아웃은 그 위 계층이다.

## 오라클 (읽기 전용)

- `src/storage/policy.ts:377-388` — `advanceNextRun`, `deferBusy`
- `src/storage/policy.ts:397-417` — `commitPolicyRunMetadata`
- `src/storage/policy.ts:424-508` — `runStorageCleanupPolicy`
- `src/storage/policy.ts:511-521` — `maybeRunDueStorageCleanupPolicy`

## 계약

### 1. 메타데이터 커밋은 정책을 **다시 읽는다**

`commitPolicyRunMetadata`는 인자로 받은 정책이 아니라 `load()`를 **새로 호출**해
정규화한 뒤 `lastRun`/`nextRun`만 덮어쓴다.

**이유가 주석에 있다:** 긴 실행 중에 사용자가 `enabled`/`trigger`/`target`/
`schedule`/`mode`를 바꿨을 수 있고, 시작 시점의 스냅샷을 저장하면 그 편집을
**되돌린다.** 실행이 소유한 필드는 두 개뿐이다.

`nextRun`은 **최신 schedule** 기준으로 계산한다 — 실행 시작 시점 것이 아니라.

### 2. `advance`와 `defer_busy`

```
advance:    nextRun = computeNextRun(latest.schedule, now)
            undefined면 nextRun 키를 삭제
defer_busy: nextRun = now + BUSY_DEFER_MS   (schedule 무관)
```

`defer_busy`가 schedule을 보지 않는 것이 중요하다. startup 정책이 바쁜 DB로 미뤄지면
`nextRun`이 생기고, 091에서 확인한 startup 두 번째 분기가 나중 티커에서 그것을
집어간다.

`BUSY_DEFER_MS` 값은 오라클 상수에서 읽는다(15분).

### 3. 실행 사다리

```
정책 로드 + 정규화
holdAfterLoadMs 훅 (테스트 전용 스핀)
enabled 아니면            -> skipped: "disabled",       저장 없음
force 아니고 due 아니면    -> skipped: "not_due",        저장 없음
selection 계산
archivedBytes <= trigger  -> skipped: "under_threshold", advance 저장
count === 0               -> skipped: "nothing_selected", advance 저장
execute(...)
  codex_busy 실패         -> deferred: "codex_busy",     defer_busy 저장
  그 외 실패              -> error,                      advance 저장
  성공                    -> lastRun 포함 advance 저장
```

**앞의 두 스킵은 저장하지 않는다.** 비활성이거나 due가 아니면 아무 일도 없었으므로
`nextRun`을 건드릴 이유가 없다. 뒤의 두 스킵은 저장한다 — 실제로 평가가 일어났고
다음 실행 시각을 밀어야 타이트 루프가 안 생긴다.

**비busy 실패도 advance한다.** 주석이 이유를 밝힌다: 안 밀면 티커마다 재시도해
타이트 루프가 된다.

### 4. `execute` 인자는 조건부 스프레드다

`candidateRelPaths`, `codexHome`, `busyTimeoutMs`는 **있을 때만** 전달된다.
Go에서는 포인터/옵션 구조체로 부재를 표현한다.

`percent`는 selection의 것이고, `digest`도 selection의 것이다 — 정책의 것이 아니다.

### 5. `maybeRunDue...`는 예외를 삼킨다

startup/schedule 진입점은 어떤 예외든 잡아서 `null`을 반환하고 로그만 남긴다.
**스케줄러 티커가 정책 버그로 죽으면 안 되기 때문이다.**

**`recover()`만으로는 부족하다** (리뷰 라운드 1 BLOCKER). TypeScript는
`selectPolicyPreview`가 **throw**하는 것을 잡는데, Go에서 그 함수는 091에서
`error`를 반환하도록 포팅됐다. `recover`는 패닉만 잡으므로 셀렉터 에러는 잡히지
않는다.

따라서 `RunStorageCleanupPolicy`는 `(PolicyRunResult, error)`를 반환하고,
`MaybeRunDue`가 **그 에러를 nil로 바꾼다.** `recover`는 추가로 남겨 패닉까지
삼키게 한다 — 오라클의 catch가 둘 다 잡기 때문이다.

## 구현 (diff 수준)

### 새 파일 `go/internal/storage/policy_run.go`

```
const BusyDeferMS = 15 * 60 * 1000

type PolicyNextRunAction string

const (
    PolicyNextRunAdvance   PolicyNextRunAction = "advance"
    PolicyNextRunDeferBusy PolicyNextRunAction = "defer_busy"
)

type PolicyRunMetadataPatch struct {
    NowMS   float64
    NextRun PolicyNextRunAction   // "advance" | "defer_busy"
    LastRun *PolicyLastRun        // nil이면 기존 값 보존
}

type PolicyRunDeps struct {
    // NowMS는 포인터다: 오라클에서 now:0은 유효한 값이고 undefined일 때만
    // Date.now()로 대체된다. 값 타입이면 0과 미지정을 구분할 수 없다.
    NowMS       *float64
    CodexHome   string
    Force       bool
    LoadPolicy  func() StorageCleanupPolicy
    SavePolicy  func(StorageCleanupPolicy)
    Execute     func(ExecuteCleanupOptions) CleanupResult
    BusyTimeoutMS *int
    HoldAfterLoadMS float64
}

type PolicyRunResult struct {
    OK        bool
    Skipped   string   // disabled | not_due | under_threshold | nothing_selected
    Deferred  string   // codex_busy
    Error     string
    Mode      string
    FreedBytes int64
    Removed   int
    TrashDir  string
    Policy    StorageCleanupPolicy
}

func CommitPolicyRunMetadata(load func() StorageCleanupPolicy,
    save func(StorageCleanupPolicy), patch PolicyRunMetadataPatch) StorageCleanupPolicy
// reason은 deps 밖에 있다: 오라클의 maybeRunDue(reason, deps)는 호출자가 넣은
// reason을 항상 덮어쓰므로, deps에 넣어두면 모순된 값을 줄 수 있는 API가 된다.
//
// 이름이 오라클과 다르고 비공개인 것은 의도적이다 (아래 참조).
func runPolicyWithDeps(reason PolicyRunReason, deps PolicyRunDeps) (PolicyRunResult, error)
func maybeRunPolicyWithDeps(reason PolicyRunReason, deps PolicyRunDeps) *PolicyRunResult
```

`ExecuteCleanupOptions`와 `CleanupResult`는 **아직 Go에 없다.** 정리 실행 자체가
포팅되지 않았기 때문이다(§080.2는 원시 함수까지만 왔다). 이 슬라이스는 `Execute`를
**주입 함수로만** 다루고 실제 구현은 붙이지 않는다 — 오라클도 `deps.execute`로
주입 가능하게 해두었다.

### 공개 진입점은 이 슬라이스에서 만들지 않는다 (리뷰 라운드 2 BLOCKER)

나는 주입 전용 API에 오라클 이름(`RunStorageCleanupPolicy`,
`MaybeRunDueStorageCleanupPolicy`)을 붙이려 했다. 리뷰어가 그것을 파리티가 아니라고
했고 맞다: 오라클은 `maybeRunDueStorageCleanupPolicy(reason)` 한 인자로 호출 가능하고
설정 로드/저장과 실행 기본값을 스스로 채운다. 기본값 없는 동명 함수는 **다른 API**다.

확인 결과 그 기본값 셋(`readStorageCleanupPolicyFromConfig`,
`writeStorageCleanupPolicyToConfig`, `executeArchivedCleanup`)은 Go에 **하나도 없다** —
`rg`로 0건. 즉 지금 기본값을 채울 방법이 없다.

따라서 이 슬라이스는 **비공개 코어**(`runPolicyWithDeps`,
`maybeRunPolicyWithDeps`)만 만든다. 오라클 이름의 공개 진입점은 그 세 기본값이
포팅된 뒤 얇은 래퍼로 붙인다. 지금 공개하면 나중에 시그니처를 바꿔야 한다.

### `error != nil`일 때의 규약

Go에는 "결과를 반환하면서 동시에 throw"가 없고 오라클에도 그런 경로가 없다.
`error != nil`이면 `PolicyRunResult`는 **제로값이며 의미 없다** — 호출자는 무시해야
한다. `maybeRunPolicyWithDeps`가 그렇게 하고 `nil`을 돌려준다.

`ExecuteCleanupOptions`/`CleanupResult`는 **cleanup.go에 두고 오라클의 전체 모양으로**
정의한다(리뷰 라운드 1 MINOR). policy_run.go에 최소 버전을 두면 실행 포팅이 나중에
남의 파일에 있는 공유 계약을 고쳐야 한다. `CleanupResult`에는 정책이 지금 읽지 않는
`Percent`와 `RemovedPaths`도 포함한다.

선택 필드 표현: `CandidateRelPaths []string`(nil이면 부재), `CodexHome string`(빈
문자열이면 부재), `BusyTimeoutMS *int`, `NowMS *float64`.

## 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 비활성 정책 | `Skipped="disabled"`, **save 호출 0회**, execute 0회 |
| 2 | due 아님 + force 아님 | `Skipped="not_due"`, save 0회, execute 0회 |
| 3 | due 아님 + **force** | 계속 진행 (execute까지 도달) |
| 4 | 비활성 + force | **여전히 disabled** — force가 enabled를 이기지 못한다 |
| 5 | `archivedBytes <= trigger` | `Skipped="under_threshold"`, **advance 저장**, execute 0회 |
| 6 | `archivedBytes == trigger` 정확히 | 스킵 (포함 경계) |
| 7 | count 0 | `Skipped="nothing_selected"`, advance 저장 |
| 8 | execute가 codex_busy 실패 | `Deferred="codex_busy"`, `nextRun == now + 15분` |
| 9 | 8에서 schedule이 startup | **여전히 now + 15분** — defer는 schedule을 안 본다 |
| 10 | execute가 다른 실패 | `Error` 설정, **advance 저장**(타이트 루프 방지) |
| 11 | execute 성공 | `lastRun = {at: now, freedBytes, removed}`, advance |
| 12 | 실행 중 정책이 바뀜 (load가 두 번째 호출에서 다른 값) | 저장된 정책이 **다섯 필드 전부**(enabled/trigger/target/schedule/mode)에서 최신 값을 보존 — 세 개만 검사하면 trigger나 mode를 뭉개는 구현이 통과한다 |
| 12b | 실행 성공 + 그 사이 `lastRun`이 동시 편집됨 | 실행의 새 `lastRun`이 **덮어쓴다** |
| 12c | 실행 스킵/실패(패치에 lastRun 없음) + 그 사이 `lastRun` 편집됨 | 동시 편집된 `lastRun`이 **살아남는다** |
| 13 | 12에서 schedule이 manual→weekly로 바뀜 | `nextRun`이 **weekly** 기준으로 계산됨 |
| 14 | advance인데 schedule이 **manual** | `nextRun`이 없음 |
| 14b | advance인데 schedule이 **startup** | `nextRun`이 없음 — manual과 따로 확인 |
| 15 | execute 인자 | selection의 percent/digest, 정책의 mode, 그리고 **`now`가 항상 전달됨** |
| 16 | reduceToBytes target | `candidateRelPaths` 전달됨 |
| 17 | percent target | `candidateRelPaths` **전달 안 됨** |
| 18 | `codexHome`/`busyTimeoutMs` 미지정 | 해당 필드 부재로 전달 |
| 19 | `MaybeRunDue`가 패닉하는 load를 만남 | `nil` 반환, 패닉 전파 안 함 |
| 19b | 셀렉터가 **에러**를 반환 (읽을 수 없는 `.trash`) | 직접 호출은 그 에러를 반환, `MaybeRunDue`는 `nil` |
| 20 | `MaybeRunDue` 정상 | 결과 포인터 반환 |

## 검증

```
cd go && go build ./internal/storage/...
cd go && (umask 022; go test ./internal/storage/ -count=1)
```

뮤테이션(최소 9): disabled/not_due에서도 저장(기준 1/2), 임계값 비교를 `<`로(기준 6),
`defer_busy`가 schedule을 참조(기준 9), 비busy 실패에서 advance 생략(기준 10),
`commitPolicyRunMetadata`가 인자 정책을 저장(기준 12), `MaybeRunDue`의 recover 제거
(기준 19), percent 경로에서도 candidateRelPaths 전달(기준 17),
`MaybeRunDue`가 셀렉터 에러를 삼키지 않고 전파(기준 19b),
패치에 lastRun이 없어도 기존 lastRun을 지우기(기준 12c).
