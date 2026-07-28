# 001 — 리베이스 직후 실측 상태

측정: 2026-07-28, 워크트리 `/Users/jun/.codex/worktrees/bb7c/opencodex`

## 리베이스

`dev2-go`(당시 `2bdb748e1`)를 `origin/dev`(`7710185c0`) 위로 리베이스했다. 새 브랜치는
`codex/260728-go-port-rebase`.

- 재생된 커밋: 335건 중 334건 적용, 1건(`2bdb748e1`, tracked `.DS_Store` 제거)은 업스트림에
  이미 반영되어 자동 드롭
- `git merge-base --is-ancestor origin/dev HEAD` → 성공

### 해결한 충돌 4건

| 파일 | 충돌 성격 | 해결 |
| --- | --- | --- |
| `src/update/job.ts` | 업스트림이 `isProcessAlive` import 추가, 우리 커밋이 `runtime-entry` import 추가 | 양쪽 import 모두 유지 |
| `docs-site/.../troubleshooting/windows-memory.md` | 우리 커밋의 문서 재작성이 업스트림의 메모리 관측성 문단을 삭제하는 형태 | Go 컷오버 서술을 채택하되 문서 하단의 업스트림 보고 지침 유지. 삭제된 관측성 문단은 `120` 단계에서 재점검 대상 |
| `tests/ci-workflows.test.ts` | 업스트림의 `enforce-pr-target` 특성화 테스트 vs 우리의 릴리스 아카이브 계약 테스트 | 두 테스트 블록 모두 유지 |
| `.github/workflows/release.yml` | 업스트림이 `release-notes.ts previous-release-tag` 헬퍼 도입, 우리 커밋이 인라인 태그 가드를 `reconcile-release-assets.ts`로 이관 | 업스트림 헬퍼 채택 + 인라인 가드 제거(가드는 스크립트가 소유) |

## 게이트 실측

| 명령 | 결과 |
| --- | --- |
| `cd go && go build ./...` | PASS |
| `cd go && go vet ./...` | PASS (exit 0) |
| `bun run typecheck` | PASS |
| `cd go && go test ./... -count=1` | **FAIL** — 아래 두 갈래 |

### 실패 1: `internal/platform` — 코드 결함 아님

`TestReplaceFromReaderPreservesMode`, `TestReplaceFromReaderRejectsDestinationRaces/mode_*`가
실패했다. 원인은 실행 셸의 `umask 077`이다. 테스트는 `0o751`/`0o755` 모드를 기대하는데
umask가 그룹·기타 비트를 깎아 스냅샷 비교가 어긋난다.

```
umask                     # 077
(umask 022; go test ./internal/platform/ -count=1)   # ok  0.473s
```

**판정: 환경 아티팩트.** 코드를 고치지 않는다. 이후 모든 Go 테스트 실행은 `umask 022`
아래에서 수행하고, 그 사실을 증거에 명시한다.

### 실패 2: `test/parity` — 진짜 격차

`TestTypeScriptAndGoUnknownCommandContract`가 `cli/unknown-command-stdout` 아티팩트
차이로 실패한다. Go의 알 수 없는 명령 도움말 출력이 TS와 다르다. 근본 원인은 도움말
텍스트 표기가 아니라 **Go CLI에 명령 자체가 없다는 것**이다. 상세는 `002`.

## 이 유닛이 건드리지 않는 것

`gpt-artifacts/`는 워크트리에 추적되지 않은 상태로 존재한다(다른 워크트리 `6cce` 소유).
이 유닛은 그것을 만들거나 지우지 않는다.
