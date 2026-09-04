# 040 — WP4: storage 실행기 이식 (cleanup / trash restore / policy run)

선행: WP1–WP3. 이 유닛에서 유일하게 파괴적 IO를 수행하므로 마지막이다.
상태: 계획. **단일 사이클로 닫히지 않을 가능성이 높다 — 아래 §분할 참조.**

## 무엇이 깨져 있나

go 런타임에서 Storage 페이지의 읽기 기능은 오늘 살아났지만, 실제로 무언가를 **지우거나
되돌리는** 버튼은 전부 404다.

| 경로 | 오라클 | go |
| --- | --- | --- |
| `POST /api/storage/cleanup` | `logs-usage-routes.ts:273` | ABSENT |
| `POST /api/storage/trash/restore` | `logs-usage-routes.ts:374` | ABSENT |
| `POST /api/storage/cleanup-policy/run` | `logs-usage-routes.ts:468` | ABSENT |

지난 세션의 계획은 이것을 "라우트만 붙이면 되는 배선"으로 적었다. 실측 결과 **틀렸다**.
`go/internal/storage/cleanup_execute_types.go:5`의 주석이 직접 말한다:

> the execution port lands later

즉 계약 타입(`ExecuteCleanupOptions`, `CleanupResult`)은 이식됐지만 실행기 자체가 없다.

## 이미 있는 것 (그리고 없는 것)

go에 이식된 원시요소는 많다. 실행기가 필요로 하는 거의 전부다:

| 오라클 | go | 상태 |
| --- | --- | --- |
| `listArchivedCandidates` | `cleanup.go:133` | 있음 |
| `selectOldestPercent` | `cleanup.go:204` | 있음 |
| `computePreviewDigest` / `computeExactPreviewDigest` | `cleanup.go:238` / `:247` | 있음 |
| `previewArchivedCleanup` / `previewExact...` | `cleanup.go:380` / `:405` | 있음 |
| `collectRestorePendingAcceptedDestRels` | `restore_pending.go:240` | 있음 |
| 스테이지 디렉터리 / no-replace rename | `quarantine.go:78` / `:115` | 있음 |
| 복원 이동 / 마무리 / 위성 커밋 | `restore_moves.go:159`, `restore_finalize.go:124`, `satellite_commit.go:147` | 있음 |
| `resolveExactArchivedCandidates` | — | **없음** |
| `executeArchivedCleanup` | — | **없음** |
| `restoreTrashEntry` | — | **없음** |

없는 셋이 정확히 "조율자" 층이다. 오라클 `executeArchivedCleanup`
(`src/storage/cleanup.ts:1733`)은 검증 → 선택 → digest 대조 → pending 겹침 차단 →
스테이징 → 롤백의 순서를 강제하는 상태 기계이고, 그 순서가 안전성의 전부다.

규모: 오라클 `src/storage/cleanup.ts` 3,014줄 대 go `cleanup.go` 425줄.

## 실행기의 계약 (오라클 `cleanup.ts:1733`에서)

거절 조건이 성공 경로보다 중요하다. 순서대로:

1. `mode`가 `quarantine`/`permanent`가 아니면 → `invalid_mode`.
2. `digest`가 64자리 hex가 아니면 → `invalid_digest`.
3. 후보 선택: `candidateRelPaths`가 있으면 정확 경로, 없으면 백분율.
   정확 경로 해석이 실패하면 → `stale_preview`.
4. **digest 대조**: 계산된 preview digest ≠ 요청 digest면 거절. 단, 필터 전 digest가
   일치하고 pending restore와 겹치는 후보가 있으면 → `restore_pending_overlap`
   (사용자에게 "왜" 막혔는지 다르게 말해주기 위한 분기다).
5. pending restore 겹침 재확인 → `restore_pending_overlap`.
6. 후보 0개면 성공하되 아무것도 지우지 않는다.
7. 그 뒤에야 스테이징/삭제.

digest는 미리보기와 실행을 묶는 장치다. 이게 없으면 사용자가 본 목록과 실제로 지워지는
목록이 달라질 수 있다. **이 계약을 느슨하게 이식하면 데이터가 사라진다.**

## 변경 지도

### NEW `go/internal/storage/cleanup_resolve.go`

`ResolveExactArchivedCandidates(relPaths []string, codexHome string) ([]ArchivedCandidate, bool)`
— 오라클 `cleanup.ts:470`. 두 번째 반환값이 false면 호출자가 `stale_preview`로 접는다.

### NEW `go/internal/storage/cleanup_execute.go`

`ExecuteArchivedCleanup(options ExecuteCleanupOptions) CleanupResult` — 위 7단계를 그
순서대로. 이미 있는 원시요소를 조합하며, 새로 쓰는 것은 순서 강제와 롤백이다.

스테이징은 `CreateExclusiveStageDir` + `RenameNoReplace`를 쓴다. 부분 실패 시
이미 옮긴 파일을 되돌리고 `CleanupResult.OK=false`로 끝낸다 — 절반만 지워진 상태를
남기지 않는다.

### NEW `go/internal/storage/restore_entry.go`

`RestoreTrashEntry(...)` — 오라클 `cleanup.ts:2565`. `PlanTrashRestore`(있음) →
`ExecuteRestoreMoves`(있음) → `CommitSatelliteSections`(있음) → `FinalizeRestore`(있음)를
엮는 조율자. 개별 조각이 다 있으므로 이 파일은 셋 중 가장 얕다.

### MODIFY `go/internal/management/storage_routes.go`

세 라우트를 등록하고 `api.go:166`의 허용 목록에 추가한다. 응답 형태는 오라클과
바이트 대조 가능하게 맞춘다.

### MODIFY `go/internal/management/api.go`

파괴적 라우트이므로 `:215`의 쓰기-권한 목록에 함께 등록한다.

## 수용 기준

1. 잘못된 mode/digest가 거절되고, 거절 코드가 오라클과 같다.
2. 드리프트된 digest가 `stale_preview`로 거절된다.
3. pending restore와 겹치는 후보가 `restore_pending_overlap`으로 거절된다.
4. 격리 모드가 파일을 trash로 옮기고 원본 위치를 비운다.
5. 부분 실패가 롤백되어 절반 상태를 남기지 않는다.
6. 복원이 파일을 원위치로 되돌리고 위성 DB 섹션을 커밋한다.

### 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

거절 분기 5종은 각각 실제로 발화시킨다 — 잘못된 digest, 드리프트, pending 겹침, 빈 후보,
부분 실패(주입). 특히 **롤백**은 스테이징 중간에 실패를 주입해 파일이 원위치에 남아
있는 것을 파일시스템에서 직접 확인한다.

격리 성공 경로는 임시 `CODEX_HOME`에 실제 롤아웃 파일을 만들고, 라이브 go 프록시로
`POST /api/storage/cleanup`을 쳐서 파일이 실제로 이동한 것을 디스크에서 읽는다.
**절대 사용자의 실제 `~/.codex`에서 실행하지 않는다.**

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/storage/ ./internal/management/ -count=1
```

## 분할 (예상)

한 사이클에 넣기에 크다. B 단계 진입 전 P에서 다음으로 쪼갤 것을 권고한다:

- **041** 정확 후보 해석 + digest/거절 계약 (파괴적 IO 없음, 순수 판정)
- **042** 격리/영구 삭제 실행기 + 롤백
- **043** 복원 조율자
- **044** 라우트 등록 + 정책 실행

041이 042의 입력을 검증된 상태로 넘기므로 의존성 순서가 성립한다. 실제 분할은 041을
마친 뒤 남은 규모를 보고 goalplan에 append한다(LOOP-UNIT-CHAIN-01).

## 위험

이 유닛은 사용자 데이터를 지운다. 셋 중 유일하게 되돌릴 수 없는 실수가 가능하다.
`permanent` 모드는 trash를 거치지 않으므로, 테스트는 전부 임시 홈에서만 돌린다.
구현 중 실제 `~/.codex`를 가리키는 경로가 기본값으로 들어가지 않는지 각 커밋에서 확인한다.
