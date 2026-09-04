# 071 — wp7f: 전략 엔진을 선택 경로에 배선

work-phase: `wp7f` · 선행: `wp7a`(설정 정규화), `wp7b`(RR 엔진), `wp7c`(쿼터 캐시) · 순서 정본: `006`

**보안 리뷰 경계.** 계정 선택 경로를 바꾼다. 자격증명 자체는 건드리지 않지만 어떤 계정의
토큰이 나가는지를 결정하므로, 자격 필터(재인증 대기·쿨다운·soft-avoid)가 어느 분기에서도
우회되지 않는지가 리뷰 대상이다.

## 왜 이 페이즈가 존재하는가

wp7c 감사에서 리뷰어가 `git grep`으로 증명했다: `RotationRegistry.PickRoundRobinAccount`,
`NewAnthropicQuotaCache`, `Lookup`, `UsageScore`가 자기 파일과 자기 테스트에만 나온다.
`go/internal/codex/routing_selection.go`의 실제 선택 경로는 전략 값을 아예 읽지 않고
언제나 `pickLowestUsageLocked`로 간다. `go/internal/oauth/accountpool.go:69`는 여전히
`usable[p.next%len(usable)]`이다.

즉 wp7b와 wp7c는 도달 불가능한 코드다. 사용자가 `accountPoolStrategy: "round-robin"`을
설정해도 Go 런타임은 quota처럼 동작한다. 이건 미구현보다 나쁘다 — 설정이 받아들여지고
정규화까지 되면서 아무 효과가 없기 때문이다.

## 오라클 계약 (읽은 곳)

`src/codex/routing.ts:588` `pickUnboundStrategyAccount`가 유일한 진입점이고 호출자는 둘이다:
`resolveCodexAccountForThreadDetailed:886`가 `commit: true`,
`previewCodexAccountForRequest:798`이 `commit: false`.

호출 위치가 계약의 절반이다. 둘 다 스레드 어피니티 재사용 분기가 끝난 뒤, 그리고
`getEffectiveActiveCodexAccountId` 폴백 앞에서 호출된다. 어피니티가 살아 있으면 전략은
아예 실행되지 않는다 — 이것이 rotation은 새 세션에만이라는 affinity policy A다.

어피니티 분기 안에서도 갈린다(`routing.ts:779`, `routing.ts:855`): 쿼터 재평가로 인한
스레드 재바인딩은 `strategy === "quota"`일 때만 일어난다. RR/fill-first에서 진행 중인
스레드는 임계를 넘겨도 붙어 있는다.

`commit: false`는 `peekRoundRobinAccount`를 쓴다 — 링 가중치·activeKey·sticky 카운터를
전혀 건드리지 않는다. 이미 Go에 `PeekRoundRobinAccount`로 존재한다.

`commit: true`의 RR 경로는 네 가지를 한다(`routing.ts:603-607`): 픽, 런타임 active 기억,
스레드 바인딩, `notePoolRotationSuccess`. fill-first는 `notePoolRotationSuccess`를
호출하지 않는다 — sticky는 RR 전용 개념이다.

`rememberActiveCodexAccount`(`routing.ts:689`)는 `config.activeCodexAccountId`를 쓰지
않는다. 프로세스 로컬 커서만 옮긴다. 이유가 주석에 있다: 무관한 `saveConfig`가 일시적
rotation을 오퍼레이터 선택으로 디스크에 굳혀버리면 안 된다.

fill-first(`routing.ts:517`)는 최소 사용률 페일오버가 아니다. 활성 계정이 임계 미만이면
유지하고 사용률 미상도 유지, 아니면 안정 사전순 전체 계정 목록에서 활성 다음부터 감싸며
순회한다. 임계 미만 후속자를 우선하되 없으면 첫 자격 후속자로 폴백한다.

`pickAlternateCodexAccount`(`routing.ts:663`)는 429 대체 선택이고 전략별로 갈린다. wp7e가
이걸 쓴다. 이 페이즈는 함수를 제공만 하고 429 경로 자체는 건드리지 않는다.

## 측정으로 확정할 것 (B 시작 전 실행)

`bun -e`로 오라클을 실행해서 다음 시퀀스를 캡처한다. 읽어서 추정하지 않는다.

1. RR 전략, 계정 a/b/c, sticky 1 — 연속 5회 resolve의 계정 순서
2. RR 전략, sticky 3 — 같은 조건에서 연속 7회
3. RR 전략에서 preview 3회가 이후 resolve 결과를 바꾸지 않음
4. fill-first, a가 임계 초과 — 다음 픽이 b인지, b도 초과면 c인지
5. fill-first, 전부 미상 — 활성 유지되는지
6. RR 전략에서 어피니티 바인딩된 스레드가 임계 초과 시 재바인딩되지 않음
7. RR 픽 이후 `config.activeCodexAccountId`가 디스크에 안 써짐

## 구현

### 1. RoutingConfig에 전략 필드 (`go/internal/codex/routing.go:31`)

`AccountPoolStrategy string`, `AccountPoolStickyLimit *int` 추가. `internal/codex`는 이미
`internal/config`에 의존하므로(`go list -deps`로 확인) 정규화 헬퍼를 그대로 호출할 수 있고
반대 방향 의존은 없다.

`go/internal/cli/codex_routing_runtime.go:106` `routingConfig()`에서 두 필드를 채운다.
지금 `cfg.AccountPoolStrategy`/`AccountPoolStickyLimit`가 존재하는데도 전달되지 않는다 —
설정이 라우터까지 도달하지 못하는 구간이 바로 여기다.

### 2. 런타임 active 커서

Router에 `runtimeActiveAccountID string`를 추가한다. `setActiveLocked`는 지금
`config.ActiveCodexAccountID`를 직접 쓰고 호출자(`codex_routing_runtime.go:139`
`persistActiveTransition`)가 그 변화를 디스크에 반영한다. 따라서 RR/fill-first가
`setActiveLocked`를 쓰면 오라클이 명시적으로 피한 디스크 쓰기가 발생한다.

`rememberActiveLocked`를 별도로 두고 유효 활성 계정 조회를
`effectiveActiveLocked() = runtimeActiveAccountID ?? config.ActiveCodexAccountID`로 바꾼다.
`setActiveLocked`는 오라클처럼 런타임 커서를 지운다.

### 3. pickUnboundStrategyLocked (`routing_selection.go` 신규)

`RotationRegistry` 인스턴스를 Router가 소유한다(풀 키 `codex`). `commit`에 따라 Pick/Peek을
고른다. 자격 목록은 `eligibleAccountsLocked(config, "", now)` — 메인 계정을 앞에 붙이는
기존 순서를 그대로 쓴다. 오라클의 RR 동점 처리가 정렬이 아니라 입력 순서를 따르므로
이 순서가 계약의 일부다.

fill-first는 `pickFillFirstLocked` + `pickNextFillFirstLocked`로 나눠 오라클의 두 함수와
1:1 대응시킨다. 후자는 wp7e가 재사용한다.

### 4. 두 호출 지점 (`routing_selection.go:98`, `:174`)

`PreviewCodexAccountForRequest`: 어피니티 분기의 쿼터 재평가를 `strategy == quota`로
가둔다. 어피니티 분기 종료 직후 `pickUnboundStrategyLocked(config, "", now, false)` 삽입.

`ResolveCodexAccountForThreadDetailed`: 동일한 전략 가드, 그리고 active 폴백 앞에
`pickUnboundStrategyLocked(config, threadID, now, true)` 삽입. RR이면 픽 후
`rememberActiveLocked` + `bindThreadLocked` + `NoteRotationSuccess`, fill-first면
`NoteRotationSuccess` 없이 앞의 둘만.

### 5. PickAlternateCodexAccount

wp7e가 쓸 전략별 대체 선택. 이 페이즈에서는 함수와 테스트만 추가하고 429 경로는 손대지
않는다.

### 6. Anthropic 쿼터 캐시 배선은 이 페이즈가 아니다

`AnthropicQuotaCache`는 `internal/oauth`의 `AccountPool`에 물려야 하는데, 그건 Anthropic
옵트인 풀 전체(전략 + 어피니티 + 429)를 함께 옮기는 일이고 `authcontext.go:17`의
단일-풀 리졸버 제약까지 건드린다. wp7g로 분리한다. 이 페이즈는 Codex 풀만 닫는다.

## 수용 기준

- 위 측정 1-7의 시퀀스를 Go가 전부 재현한다.
- RR/fill-first 픽이 `config.ActiveCodexAccountID`를 변경하지 않는다(런타임 커서만 이동).
- `strategy: quota`에서 기존 동작이 한 줄도 바뀌지 않는다 — 기존 routing 테스트 전부 green.
- 뮤테이션: 어피니티 분기 뒤가 아니라 앞에 전략 픽을 넣으면 6번 케이스가 실패해야 한다.
  실제로 옮겨서 실패를 확인하고 되돌린다.
- `(umask 022; go test ./... -count=1)` non-ok 0줄, `go vet` exit 0, 3-OS 크로스빌드 통과.
- `git diff --name-only -- src/` 가 0 파일.
