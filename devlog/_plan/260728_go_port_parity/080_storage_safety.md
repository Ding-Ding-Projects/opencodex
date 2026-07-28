# 080 — wp8: 스토리지 안전성

work-phase: `wp8`(4개 하위 슬라이스) · 선행: `070` · 후속: 090

오라클 `src/storage/cleanup.ts`는 3,014줄이고 Go에는 스캔 전용 `/api/storage`만 있다
(`go/internal/management/logs.go:298`). 이 단계는 **네 개의 독립 검증 가능한 슬라이스**로
나눈다. 크기가 아니라 빌드 순서 기준이다.

먼저 발견된 기존 스캐너 불일치 하나: Go 스캐너가 `.trash`를 `other`로 집계한다
(`go/internal/storage/scanner.go:110`). TS는 명시적으로 제외한다(`src/storage/scanner.ts:202`).
격리(quarantine)를 도입하면 이 차이가 사용자에게 보이므로 슬라이스 1에서 함께 고친다.

## 080.1 읽기 전용 프리뷰 계약

### 오라클

- 스캔 대상은 `CODEX_HOME/archived_sessions` **직하위**의 정규 `.jsonl` / `.jsonl.zst`
  파일뿐이다. 활성 `sessions/`는 절대 순회하지 않는다(`cleanup.ts:275`).
- 평문과 압축 형제는 **하나의 논리 롤아웃**이며, 가장 이른 물리 mtime → 논리 경로 순으로
  오래된 것부터 정렬한다.
- 후보는 논리 경로, 합계 바이트, 최소 mtime, 모든 물리 경로와 각 물리 파일의 바이트/mtime을
  포함한다. 다이제스트 입력은 정렬된 논리 후보 + 정렬된 물리 멤버이며, 퍼센트 프리뷰는
  `"<clamped-percent>\n<lines>"`, 정확 선택은 `"exact\n<lines>"`를 해싱한다(`cleanup.ts:246`).
- 퍼센트는 유한값 → floor → `0..100` 클램프. `1..99`는
  `max(1, floor(total*pct/100))`개의 가장 오래된 후보를 고른다.

### 다이제스트가 하는 일

프리뷰와 적용 사이에 데이터가 바뀌면 **적용을 거부**한다. 적용 시 즉시 재스캔하고 정확
다이제스트를 재계산한다. 후보 소실, 바이트/mtime 변경, 압축 형제 추가/제거, 선택 집합 변경 중
어느 하나라도 있으면 **어떤 변경도 하기 전에** `stale_preview`를 반환한다(`cleanup.ts:1728`).

복원 대기(pending restore) 목적지는 제외·백필된다. 낡은 다이제스트가 필터되지 않은 집합과
정확히 일치하지만 그 경로들이 지금 복원 대기 중이라면, 일반 stale이 아니라
`restore_pending_overlap`을 반환한다(`cleanup.ts:1763`). 이 구분은 사용자에게 "왜 실패했는지"를
다르게 말해준다.

### 변경

- `go/internal/storage/cleanup.go` 신규: `ArchivedCandidate`, `CleanupPreview`, `CleanupMode`,
  `CleanupResult`, 타입 오류 상수, `ListArchivedCandidates`, `PreviewArchivedCleanup`,
  `PreviewExactArchivedCleanup`, `ComputePreviewDigest`, `ResolveExactArchivedCandidates`,
  경로 봉쇄/평면 파일 검증 헬퍼.
- `go/internal/management/storage.go` 신규: `POST /api/storage/cleanup/preview` 등록.
  응답은 `percent`, `count`, `bytes`, `digest`와 **절대 경로 없는** 최대 50개 후보만
  (`src/server/management/logs-usage-routes.ts:256`).
- `scanner.go:110`에서 `.trash` 제외.

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 오래된/새 아카이브 + 활성 `sessions/` 시드 | 오래된 것 선택, 활성 파일 부재, 다이제스트가 64자 소문자 hex |
| 2 | `a.jsonl` + `a.jsonl.zst` | 후보 1개, 두 물리 파일이 다이제스트에 결속 |
| 3 | 빈 디렉터리 또는 퍼센트 0 | 후보 0 성공, 결정적 다이제스트 |
| 4 | 퍼센트 누락/비수치/음수/100 초과/비유한 | HTTP 400 `invalid_percent`, 파일 쓰기 없음 |
| 5 | 프리뷰 후 선택 파일 수정/터치/삭제, 또는 `.zst` 추가·제거 | 409 `stale_preview`, 잔여 파일·DB 행 불변 |
| 6 | 유효한 `.trash/<epoch>/restore-pending.json` 배치 후 이전 다이제스트로 적용 | `restore_pending_overlap` |

**종료 시점:** 빌드 통과 + 스캐너·프리뷰 테스트 통과. 아직 변경 능력은 없다.

## 080.2 안전한 정리 트랜잭션

### 뮤테이션 조정자

해석된 `CODEX_HOME`마다 **인메모리 슬롯 1개**. 정리·복원·정책이 한 번 획득을 시도하고
실패하면 즉시 `storage_mutation_busy`를 반환한다 — **큐는 없다**
(`src/storage/storage-mutation-coordinator.ts:1`).

Go의 기존 `live_persistence.go:157` 락은 설정 저장 직렬화용이며 대체재가 **아니다**.

### 위성 백업의 원자성

"위성"은 최신 버전의 별도 SQLite 저장소다: `logs_N.sqlite`, `memories_N.sqlite`,
`goals_N.sqlite`. `state_N.sqlite`가 주 스레드 저장소다.

`logs → memories → goals` 순서로 `BEGIN IMMEDIATE` 락을 잡고 영향 행, state 스레드, 동적
도구, spawn 엣지를 스냅샷한다. **어떤 위성 삭제도 커밋되기 전에** 완전한
`satellite-backup.json`을 쓴다. 쓰기 절차는 비공개 임시 파일 → 전체 쓰기 → 파일 fsync →
원자적 rename → 스테이지 디렉터리 fsync(최선 노력). 교체가 중단되어도 **이전 유효 백업을
절대 잘라내지 않는다**(`cleanup.ts:1000`).

이후 실패 시 스냅샷된 행만 conflict-ignore로 복원해, 커밋 이후 동시 삽입/갱신을 보존한다.
memories 백업은 커밋 후 재작성되어 전역 통합 작업의 post-image를 기록한다 — 복구가 정리
소유 변경만 되돌리게 하기 위함이다.

### 실행 순서 (고정)

state 쓰기 가능성·참조 사전점검 → 스테이지 + manifest → state 락 획득 및 ID 동결 →
스냅샷 + 내구성 백업 → 위성 커밋 → state 커밋 → 격리 또는 영구 삭제.

### 변경

`go/internal/storage/mutation.go`, `sqlite_cleanup.go`, `backup.go` 신규.
`management.API`에 `*storage.Coordinator` 추가. `POST /api/storage/cleanup` 등록.

### 수용 기준

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 네 DB에 연관 행 시드 | 로그·메모리·목표·스레드·동적도구·spawn엣지 제거, 격리 시 백업 존재 |
| 2 | 적용 전 SQLite 쓰기 트랜잭션 보유 | `codex_busy`, 파일 이동·DB 변경 없음 |
| 3 | 선택 스레드를 참조하는 라이브 spawn 엣지 시드 | `referenced_history`, 무변경 |
| 4 | 백업 임시쓰기/fsync/rename 실패 주입 | `fs_failed`, 모든 DB·롤아웃 불변 |
| 5 | 내구성 임시파일 후 rename 직전 실패 | 이전 백업이 여전히 파싱 가능 |
| 6 | 로그/메모리/목표/state 커밋 각 직후 실패 주입 | 스테이지 파일보다 **먼저** 위성 복원, 원본 생존 |
| 7 | 정리 위성 커밋 후 무관한 새 행 삽입 → 롤백 강제 | 스냅샷은 복원되고 동시 행은 불변 |

**종료 시점:** 정리·DB 원자성 테스트 통과. 정리는 안전하지만 복원은 아직 노출 안 됨.

## 080.3 격리 복원

### 오라클

격리는 비공개 `CODEX_HOME/.trash/<epoch>`로 스테이징한다. 충돌 시 `<epoch>-1`..`-99`를
배타 생성으로 재시도한다(`cleanup.ts:128`). 첫 rename 전에 모드·타임스탬프·다이제스트·
물리 경로·매칭 스레드 메타데이터를 담은 비공개 `manifest.json`을 쓰고, 스테이징 후 DB
삭제 전에 다시 쓴다.

복원은 ID·manifest·물리 경로를 검증하고, **첫 파일 이동 전에** `restore-pending.json`을
원자적으로 쓴 뒤, hard-link → unlink 방식의 **no-replace** 이동을 쓴다. 메타데이터를 조정한
다음 tombstone 처리하고 스테이지를 최선 노력으로 삭제한다.

**핵심 불변식:** 파일이 이동한 뒤의 실패는 파일도 메타데이터도 되돌리지 않는다. 대신 내구성
pending 마커가 수락된 목적지와 미완료 state/logs/memories/goals 구간을 기록해 재시도가
안전하게 재개된다. 손상된 pending 상태는 **fail closed**(`cleanup.ts:2809`).

### 수용 기준 (일부)

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | 고정 시계 + `.trash/<epoch>` 선점 | 새 스테이지가 `<epoch>-1`, 덮어쓰기 아님 |
| 2 | 격리 후 반환된 ID로 복원 | 파일·스레드·위성 행 복귀, 스테이지 목록에서 사라짐 |
| 3 | 복원 목적지 선점 | 409 `dest_exists`, 스테이지 파일 보존 |
| 4 | 첫 pending 쓰기 실패 | 어떤 파일도 스테이지를 떠나지 않음 |
| 5 | N번째 이동 후 실패 | 기존 목적지 유지, pending 마커 존재, 재시도가 `dest_exists` 없이 성공 |
| 6 | `restore-pending.json` 또는 `satellite-backup.json` 손상 | fail closed, 스테이지 불변 |
| 7 | tombstone rename 실패 | `fs_failed`, 원 스테이지가 계속 목록에 남아 재시도 가능 |

### 경쟁 계약

`tests/storage-mutation-race.test.ts:168`의 정확한 계약:

- 복원/정리 실행 중 정책 시도 → idle로 끝나며 `lastOutcome.error = storage_mutation_busy`
- 정책 중 수동 정리/복원 → 409
- **복원이 이미 파일을 옮기고 pending 상태를 저장한 뒤에도** 격리·영구 정리 모두 409

**종료 시점:** 왕복·크래시 복구·경쟁 테스트 통과.

## 080.4 옵트인 정책 수명주기

### 스키마

`storageCleanupPolicy`(`src/types.ts:470`) 정규화 기본값: 비활성, `5 GiB`, 오래된 것 `25%`
제거, `manual` 일정, `quarantine` 모드.

| 필드 | 규칙 |
| --- | --- |
| `enabled` | 명시적 `true`만 활성화 |
| `trigger.archivedBytesOver` | 음이 아닌 유한 정수 |
| `target` | `reduceToBytes`(음 아닌 정수) 또는 `removeOldestPercent`(유한 `(0,100]`) **정확히 하나** |
| `schedule` | `startup \| daily \| weekly \| manual` |
| `mode` | `quarantine \| permanent`, 기본 격리, 영구는 명시적으로만 |
| `lastRun` | `{at: 양의 정수, freedBytes: 음 아닌, removed: 음 아닌}` |
| `nextRun` | 양의 정수 epoch-ms |

**손상된 영속 `target`은 조용히 삭제로 폴백하지 않고 정책을 비활성화한다**(`policy.ts:87`).
이것이 안전 기본값의 핵심이다.

PUT은 기존 정책과 병합하고, 무효값을 거부하며, `enabled` 생략 시 **암묵적으로 활성화하지
않는다**. 일정이 그대로면 `nextRun`을 보존하고, 새로 시간 기반이 된 경우에만 재계산한다.

### 작업·스케줄러

manual/startup/schedule이 단일 비행(single-flight) 작업을 공유한다. 무거운 작업은 요청
경로 밖에서 돌고, 워커 타임아웃은 10분, 종료는 중단시킨다. 스케줄러는 unref된 매시 티커이며
listen 후 취소 가능한 startup 평가를 예약한다.

Go에서는 `Server.Close()`(`go/internal/server/server.go:538`)가 현재 watchdog/response state만
정지시키므로 정책 종료 소유권을 추가해야 한다.

### 수용 기준 (일부)

| # | 활성화 | 증거 |
| --- | --- | --- |
| 1 | `target`에 두 필드 모두 또는 모두 없음 | 정책 비활성화 |
| 2 | 비활성 정책에 target/schedule만 PUT | 여전히 비활성 |
| 3 | 고정 시계로 manual/startup/daily/weekly 및 `nextRun` 경계 | 정확한 due 판정 |
| 4 | 정책 실행 중 state 쓰기 보유 | `deferred: codex_busy`, `nextRun = now + 15m`, `lastRun` 불변 |
| 5 | 정책을 초기 로드 후 차단하고 target/mode/schedule PUT 후 해제 | 완료는 **실행 메타데이터만** 갱신, PUT 필드 생존 |
| 6 | 첫 작업 보유 중 두 번째 POST | 409 `already_running` |
| 7 | 작업 차단 상태에서 `/healthz`·스트리밍 요청 | 작업 완료 전에 응답 |
| 8 | 차단된 작업·스케줄러 상태에서 `Server.Close()` | 컨텍스트 취소, 티커 정지, 슬롯 해제, 뒤늦은 상태 덮어쓰기 없음 |

**종료 시점:** 정책·API·응답성·취소·동시 설정 편집 테스트 통과.

## 미러링할 TS 테스트

`tests/storage-cleanup.test.ts`, `api-storage-cleanup.test.ts`, `storage-policy.test.ts`,
`api-storage-policy.test.ts`, `storage-policy-job-responsive.test.ts`,
`storage-restore-job-errors.test.ts`, `storage-restore-job-responsive.test.ts`,
`storage-mutation-race.test.ts`, `storage-scanner.test.ts`, `api-storage.test.ts`.

`tests/init-backup-cleanup.test.ts`는 제외 — OpenAI 티어 설정 백업 마이그레이션이며 Codex
스토리지 정리와 무관하다.

## 스코프 경계

IN: `go/internal/storage/**`, `go/internal/management/storage.go`, 설정 필드, 서버 수명주기 배선.
OUT: `src/**`, GUI 스토리지 화면.
