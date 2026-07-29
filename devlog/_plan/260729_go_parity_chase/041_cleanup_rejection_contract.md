# 041 — WP4a: 정확 후보 해석과 거절 계약 (파괴적 IO 없음)

선행: WP1–WP3 완료. `040_storage_execute_port.md`의 분할 중 첫 조각.
상태: 계획.

## 왜 쪼갰나

040은 한 사이클에 넣기 큰 유닛이고, 그 안에서 **판정**과 **파일 이동**은 위험도가
다르다. 판정이 틀리면 잘못된 목록이 만들어지고, 파일 이동이 틀리면 데이터가 사라진다.
그래서 판정을 먼저 검증된 상태로 만들고, 그것을 입력으로 받아 042가 이동을 수행한다.

이 문서는 **파일을 하나도 건드리지 않는다.** 순수 판정만 다룬다.

## P 재검증에서 확인한 것 (2026-07-29)

040을 쓸 때보다 이식된 범위가 넓었다. 트리를 다시 세어보니:

| 오라클 | go | 상태 |
| --- | --- | --- |
| `probeStateDbWritable` (`cleanup.ts:547`) | `ProbeDBWritable` (`dbprobe.go:135`) | **있음** |
| `CleanupErrorCode` 어휘 | `dbprobe.go:42` (`codex_busy`, `db_reconcile_failed`) | **있음** |
| `listArchivedCandidates` | `cleanup.go:133` | 있음 |
| `selectOldestPercent` | `cleanup.go:204` | 있음 |
| `computePreviewDigest` / `Exact` | `cleanup.go:238` / `:247` | 있음 |
| `previewArchivedCleanup` / `Exact` | `cleanup.go:380` / `:405` | 있음 |
| `collectRestorePendingAcceptedDestRels` | `restore_pending.go:240` | 있음 |
| `resolveExactArchivedCandidates` (`cleanup.ts:470`) | — | **없음** |
| `executeArchivedCleanup`의 거절 순서 | — | **없음** |

즉 이 조각에서 새로 쓰는 것은 딱 둘이다.

## 변경 지도

### NEW `go/internal/storage/cleanup_resolve.go`

```go
+// ResolveExactArchivedCandidates maps caller-supplied relative paths onto real
+// candidates. A path that no longer exists means the preview the user saw is
+// gone, so this reports failure rather than silently cleaning a smaller set
+// (oracle: src/storage/cleanup.ts:470).
+func ResolveExactArchivedCandidates(relPaths []string, codexHome string) ([]ArchivedCandidate, bool)
```

오라클 계약 그대로: 빈 입력은 빈 슬라이스 + true(성공), 하나라도 매칭 실패면 nil + false.
`false`를 받은 호출자는 `stale_preview`로 접는다.

### NEW `go/internal/storage/cleanup_decide.go`

거절 계약만 담는다. **파일을 옮기지 않고**, "무엇을 지울 것인가"와 "왜 거절하는가"만
결정한다.

```go
+type CleanupDecision struct {
+	Candidates []ArchivedCandidate
+	Mode       string
+	Percent    int
+	// Error is empty when the cleanup may proceed.
+	Error string
+}
+
+func DecideArchivedCleanup(options ExecuteCleanupOptions) CleanupDecision
```

순서는 오라클 `cleanup.ts:1733-1780`을 그대로 따른다. **순서 자체가 계약이다**:

1. `mode`가 `quarantine`/`permanent`가 아니면 → `invalid_mode`
2. `digest`가 64자리 hex가 아니면 → `invalid_digest`
3. 후보 선택 (정확 경로 / 백분율). 정확 해석 실패 → `stale_preview`
4. digest 대조 실패 시:
   - 필터 전 digest는 일치하고 pending restore와 겹치는 후보가 있으면
     → `restore_pending_overlap`
   - 아니면 → `stale_preview`
5. pending restore 겹침 재확인 → `restore_pending_overlap`
6. 후보 0개 → 성공(지울 것 없음)

4번의 두 갈래가 이 유닛에서 가장 미묘하다. 사용자가 본 미리보기와 실제 후보가 다를 때,
"목록이 낡았다"와 "복원 대기 중인 파일과 겹쳐서 막혔다"는 원인이 다르고 사용자가 취할
행동도 다르다. 오라클이 굳이 두 코드를 나눈 이유다.

### NEW `go/internal/storage/cleanup_decide_test.go`

거절 6종을 각각 발화시킨다. 특히 4번은 두 갈래를 **따로** 만든다 — 낡은 미리보기와
pending 겹침을 같은 테스트로 덮으면 분기 하나가 죽어도 통과한다.

## 수용 기준

1. 여섯 갈래가 각각 정확한 코드를 반환한다.
2. `restore_pending_overlap`이 `stale_preview`로 뭉개지지 않는다.
3. 후보 0개가 오류가 아니라 성공이다.
4. 어떤 경로에서도 파일시스템이 변경되지 않는다 (이 유닛은 판정만 한다).

### 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

거절 분기는 전부 기본 경로 밖이다. 각각을 실제 픽스처로 발화시키고 반환 코드를 읽는다.
4번 두 갈래는 서로의 대조군이다: 같은 드리프트 상황에서 pending 겹침이 있을 때와 없을 때
**다른 코드**가 나오는 것을 확인해야 분기가 살아 있다.

파일 불변은 별도 증거로 남긴다: 판정 전후로 임시 홈의 디렉터리 목록이 동일함을 확인한다.

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/storage/ -count=1
```

## 다음 조각

- **042** 격리/영구 삭제 실행기 + 롤백 (이 문서의 `CleanupDecision`을 입력으로 받는다)
- **043** 복원 조율자
- **044** 라우트 등록 + 정책 실행
