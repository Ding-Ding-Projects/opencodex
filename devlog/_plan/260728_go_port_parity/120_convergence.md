# 120 — wp12: 수렴 판정

work-phase: `wp12` · 선행: 모든 구현 단계 · 후속: 없음 (goalplan 종료 판정)

## 목적

"완성했다"를 선언할 수 있는지, 아니면 어떤 정직한 터미널 결과인지 판정한다.
이 단계는 새 기능을 만들지 않는다.

## 1. 신선도 재확인 (먼저)

구현 도중 `origin/dev`가 또 움직였을 수 있다. 이전 라운드가 정확히 이 이유로 세 번 재베이스했다.

```bash
git fetch origin
git rev-parse origin/dev
git merge-base --is-ancestor origin/dev HEAD; echo "ancestor=$?"
git log --oneline <이전 기준선>..origin/dev -- src/ | wc -l
```

`origin/dev`가 움직였다면 이 단계는 **판정이 아니라 재베이스 + 델타 재측정**으로 시작하고,
새 델타가 실질적이면 goalplan에 work-phase를 추가한다(LOOP-UNIT-CHAIN-01). 낡은 기준선
위에서 통과한 게이트는 증거가 아니다.

## 2. 전체 게이트

```bash
cd go && go build ./... && go vet ./...
cd go && (umask 022; go test ./... -count=1 -timeout 600s)
cd go && (umask 022; go test -race ./... -count=1 -timeout 900s)
cd ..
bun run typecheck
bun run test
bun run privacy:scan
bun run lint:gui
```

`umask 022`의 근거는 `001` 실패 1 분석. 이 사실을 증거에 매번 명시한다.

## 3. 파리티 무력화 검사

```bash
grep -c '{body: true}' go/test/parity/differential_matrix_test.go        # 0이어야 함
git diff $(git merge-base origin/dev HEAD)..HEAD -- go/test/parity/      # 면제 추가 없음
git diff $(git merge-base origin/dev HEAD)..HEAD --stat -- src/          # 비어 있어야 함
```

세 번째 검사가 핵심이다: **이 브랜치는 `src/**`를 한 줄도 바꾸지 않아야 한다**
(리베이스 충돌 해소분은 업스트림 커밋의 재적용이므로 merge-base 기준 diff에 나타나지 않는다).

## 4. 스코어카드 정정

`260726_260726-go-port-r8/095_reachability_dashboard.md`와 `100_final_port_verdict.md`는
`origin/dev@1eb7269f` 기준의 "30/30 S3, 파리티 100%"를 담고 있다. 그 수치는 **당시 기준선에
대해서는 참**이지만 현재 기준선에 대해서는 거짓이다.

정정 방식: 기존 문장을 지우지 말고 **측정 기준선을 명시**한다.

- `~~파리티 100%~~` → `origin/dev@1eb7269f 기준 30/30 S3. origin/dev@<현재 SHA> 기준
  재측정 결과는 이 유닛의 120 참조.`

과거 판정을 소급 삭제하면 왜 드리프트가 생겼는지 추적할 수 없게 된다.

## 5. 잔여 항목 명시

판정 시점에 남은 것을 숨기지 않고 나열한다. 최소한 다음은 이 유닛에서 **의도적으로 남긴다**:

| 항목 | 이유 | 처리 |
| --- | --- | --- |
| UAC 승격 프로토콜 | ACL 순서보다 큰 독립 유닛, 설치 트랜잭션까지 변경 | `130`으로 분리 |
| Windows 실기 검증 | macOS에서 계획·플래너만 검증 가능 | 호스팅 CI 매트릭스 필요 → `BLOCKED` 성격 |
| 라이브 프로바이더 경로 | 실자격증명 필요 | 별도 수령증 |

### DONE을 막는 항목 (감사 B3)

아래는 "문서화된 잔여"로 처리할 수 **없다**. 미해결이면 터미널 결과는 `NEEDS_HUMAN`이다.

| 항목 | 해소 조건 |
| --- | --- |
| `/api/models` 서버 응답 형태 차이 (Go `{models, customModels}` vs 오라클 배열) | Go 서버를 오라클 형태로 이식 + 기존 소비자 마이그레이션·회귀 테스트, **또는** 사용자의 명시적 파리티 예외 승인 |

런처가 두 형태를 모두 수용하는 것(`050`)은 이 항목을 해소하지 **않는다**. 근거는
`004`의 계약: Go가 TS와 다르면 Go가 틀렸다.

## 6. 터미널 결과 판정

| 결과 | 조건 |
| --- | --- |
| `DONE` | 2·3 게이트 전부 통과 + 5의 잔여가 모두 "이 유닛 스코프 밖"으로 문서화됨 + **DONE 차단 항목이 전부 해소됨** |
| `BLOCKED` | Windows 실기·라이브 프로바이더처럼 외부 의존이 남은 기준을 막음 |
| `NEEDS_HUMAN` | 파리티 예외 승인이나 오라클 모호성 판단이 필요 (`/api/models` 항목 포함) |

**금지:** 남은 work-phase를 "각각 별도 PABCD가 필요하다"며 목록으로 제시하고 goal을 닫는 것.
그것들은 다음 work-phase이지 종료 사유가 아니다(LOOP-CONTINUE-01).

## 7. 푸시

푸시는 사용자 명시 승인이 있을 때만 한다(DEV-GIT-PUSH-01). 승인이 없으면 로컬 커밋
상태로 보고하고 끝낸다.
