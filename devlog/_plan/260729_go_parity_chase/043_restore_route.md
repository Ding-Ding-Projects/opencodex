# 043/044a — WP4c+d: 복원 조율자와 라우트

선행: 041(판정), 042(스테이징/롤백).
상태: 복원 경로 완료. cleanup 실행 라우트는 미완(아래 §남은 것).

## 계획보다 얇았다

040은 복원을 "네 원시요소를 엮는 조율자"로 잡았다. P에서 트리를 다시 보니 이미
`RestoreRemainingWork`(`restore_remaining.go:15`)가 이동 이후 단계 전체를 담고 있었다.
정말 없던 건 **`ExecuteRestoreMoves`를 부르는 사람**이었다 — 비테스트 호출자가 0이었다.

그래서 조율자는 30줄이다. 각 단계는 이미 개별 테스트가 있었고, 순서대로 실행하는
코드만 없었다. 기능이 서류상으로만 존재했던 셈이다.

## 구현

### `go/internal/storage/restore_entry.go`

`RestoreTrashEntry(trashID, codexHome, busyTimeoutMS, hooks)`:
`PlanTrashRestore` → `PrepareRestorePreflight` → `ExecuteRestoreMoves(..., RestoreRemainingWork(...))`.

**에러 코드를 뭉개지 않는다.** 각 단계 코드를 그대로 반환한다. 라우트가 그것을 서로 다른
HTTP 상태로 매핑하기 때문이다 — 뭉개면 사용자에게 "성공할 수 없는 재시도"를 시킨다.

락은 `ExecuteRestoreMoves`가 소유하므로 조율자는 아무것도 잡지 않는다.

### `go/internal/management/storage_routes.go`

`POST /api/storage/trash/restore` 등록. 오라클
(`logs-usage-routes.ts:383-393`)과 같은 매핑:

| 코드 | 상태 | 사용자가 할 일 |
| --- | --- | --- |
| `codex_busy`, `dest_exists` | 409 | Codex 종료 후 재시도 / 충돌 파일 정리 |
| `missing_trash` | 404 | 그 항목은 없다 |
| `invalid_trash` | 400 | id를 고쳐라 |
| 그 외 | 500 | — |

복원 전체를 **뮤테이션 슬롯** 안에서 돌린다(`storage.Mutations().WithSlot`). 동시에 도는
cleanup은 이 복원이 되돌리는 바로 그 파일을 옮기고 있을 것이다. 슬롯 경합은
`storage_mutation_busy` + 409다.

## 활성화 증거

라이브 Go 프록시(`:10884`, 임시 `CODEX_HOME=/tmp/wp4dhome`):

```
BEFORE  archived_sessions/ 비어 있음 (파일은 .trash/1700000000 에 격리됨)
POST /api/storage/trash/restore {"id":".trash/1700000000"}
     -> HTTP 200 {"ok":true,"count":1,"bytes":16,
                  "restoredPaths":["archived_sessions/rollout-...zzzz.jsonl"]}
AFTER   archived_sessions/rollout-...zzzz.jsonl 존재, 내용 "quarantined body"
        .trash/ 디렉터리 자체가 사라짐
```

에러 매핑도 라이브로 확인:
`.trash/9999999999` → **404** `missing_trash`, 빈 body → **400** `invalid_trash`.
500으로 뭉개지지 않는다.

## 남은 것 — cleanup 실행 라우트

`POST /api/storage/cleanup`과 `/cleanup-policy/run`은 **여전히 404**다.

복원은 조율자가 없었을 뿐 전 단계가 이식돼 있었지만, cleanup 실행은 조율자 자체가
더 크다 — 매니페스트 저널(스테이징 전/후 2회 기록)과
`reconcileDeletedThreads`(state DB에서 스레드 행 삭제 + 위성 백업 기록)가 남아 있다.
041의 판정과 042의 이동 원시요소가 그 조율자의 입력을 검증된 상태로 만들어뒀다.

즉 지금 시점의 정직한 상태는: **격리된 세션을 되돌릴 수 있다. 아직 격리할 수는 없다.**
