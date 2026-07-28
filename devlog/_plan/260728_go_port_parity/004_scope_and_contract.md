# 004 — 스코프 경계와 완료 계약

## IN

- `go/**` 구현 및 테스트
- `go/test/parity/**` 오라클 대조 테스트 (강화만, 약화 금지)
- `devlog/_plan/260728_go_port_parity/**` 문서

## OUT

- `src/**` 수정. TypeScript는 **읽기 전용 오라클**이다. Go가 TS와 다르면 Go가 틀린 것이다.
  TS 쪽 버그를 발견하면 문서에 기록만 하고 이 유닛에서 고치지 않는다.
- `gui/**`, `docs-site/**` 기능 변경 (리베이스 충돌 해소분 외)
- 원격 push, 릴리스, publish, 태그
- `main`/`dev`/`preview` 브랜치 이동

## 파리티 테스트 무력화 금지 (STRICT)

파리티 실패를 "해결"하는 유일한 정당한 방법은 Go를 오라클에 맞추는 것이다. 다음은 금지:

- `go/test/parity/differential_matrix_test.go`에 `{body: true}` 면제 추가
- `knownRuntimeDiffs`에 항목 추가
- 기대값을 Go의 현재 출력으로 되맞추기(테스트를 구현에 맞추는 역방향 수정)
- `t.Skip`으로 실패 우회

검증: `grep -c '{body: true}' go/test/parity/differential_matrix_test.go`가 `0`이고,
`git diff $(git merge-base origin/dev HEAD)..HEAD -- go/test/parity/`에 면제 추가가 없을 것.

정당한 예외가 필요하다고 판단되면 그것은 코드 변경이 아니라 **사용자 결정 사항**이며,
`NEEDS_HUMAN`으로 보고한다.

## 환경 계약

모든 Go 테스트는 `umask 022` 아래에서 실행한다. 근거는 `001`의 실패 1 분석.

```bash
cd go && (umask 022; go test ./... -count=1 -timeout 600s)
```

## 완료 게이트

`DONE` 선언은 다음을 **이 브랜치에서 새로 실행한 출력**으로 증명할 때만 가능하다.

```bash
cd go && go build ./... && go vet ./...              # exit 0
cd go && (umask 022; go test ./... -count=1 -timeout 600s)   # 전부 PASS
bun run typecheck                                     # exit 0
bun run test                                          # 회귀 없음
bun run privacy:scan                                  # green
git fetch origin && git merge-base --is-ancestor origin/dev HEAD   # exit 0
grep -c '{body: true}' go/test/parity/differential_matrix_test.go  # 0
```

기억에 근거한 "지난번에 통과했다"는 증거가 아니다(FAMILY-PROOF-01).

## 터미널 결과 정의

| 결과 | 조건 |
| --- | --- |
| `DONE` | 위 게이트 전부 통과 |
| `NOOP` | 실측 결과 격차 없음 (해당 없음 — 격차는 이미 측정됨) |
| `BLOCKED` | 외부 CI·자격증명·라이브 프로바이더가 필요 |
| `UNSAFE` | 인증/토큰/릴리스 자동화 경계에 사람 위험 판단 필요 |
| `NEEDS_HUMAN` | 오라클 자체가 모호하거나 파리티 예외 승인이 필요 |
| `BUDGET_EXHAUSTED` | 해당 없음 (사용자가 시간·토큰 무제한 명시) |

## 커밋·푸시 규율

각 work-phase는 자체 커밋을 남긴다(DEV-GIT-COMMIT-01). 푸시는 사용자 명시 승인 없이
하지 않는다(DEV-GIT-PUSH-01). 현재까지 승인된 것은 없다.
