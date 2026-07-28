# 072 — wp7g: Anthropic 옵트인 풀 배선

work-phase: `wp7g` · 선행: `wp7a`(설정 정규화), `wp7b`(RR 엔진), `wp7c`(쿼터 캐시), `wp7f`(Codex 배선)

**보안 리뷰 경계.** Anthropic OAuth는 ToS 민감이다. 계정 선택, 토큰 취급, `local-cli`
슬롯의 자격 판정이 리뷰 대상이다. 특히 `isPoolCredentialUsable`은 **정체성 도용 방지**
장치이므로 완화하면 안 된다.

## 현재 상태 (측정)

`rg AnthropicAccountPool go/internal/ --glob '!*_test.go'`가 `config/account_pool.go`와
`config/config.go`만 반환한다. 즉 설정 스키마만 있고 **선택 로직 전체가 없다**.
`AnthropicQuotaCache`(wp7c)는 여전히 자기 파일과 자기 테스트에서만 참조된다.

`go/internal/oauth/accountpool.go:69`의 `AccountPool.Select`는 프로바이더 무관 순차
선택이고, `authcontext.go:308`의 리졸버는 단일 풀만 소유하며 프로바이더 불일치를 거부한다.
`serve.go:318`은 `openai` 풀 하나만 만든다.

## 오라클 계약 (`src/oauth/anthropic-routing.ts`)

### 자격 판정 (`:148`)

`needsReauth !== true` && `!isCooled` && `isPoolCredentialUsable`. 세 번째가 중요하다
(`:137`): `source === "local-cli"`인 자격증명은 갱신 가능하거나 **60초 스큐를 넘겨 아직
살아 있을 때만** 자격이 있다. 배경 슬롯의 만료 토큰으로 다른 사람 세션을 잇는 것을 막는
장치이므로, Go에서 이 조건을 빼면 보안 완화다.

### 선택 순서 (`resolveAnthropicAccountForSession:334`)

1. 만료 어피니티 정리 → 계정 없음이면 `none`
2. 풀 비활성이면 저장된 active를 그대로 (`pool-disabled`) — 다른 판정을 일절 하지 않는다
3. 세션 키 어피니티: 24시간 유휴 이내 + 계정이 여전히 자격이면 `affinity`
4. **세션 키가 없고** 전략이 RR/fill-first면, active가 자격일 때 그것을 유지 (`active`).
   Desktop처럼 sticky 키가 없는 턴을 매번 새 세션으로 취급하지 않기 위한 장치다.
5. 전략 픽 (`round-robin` / `fill-first`) → **여기서 active를 승격하지 않는다.**
   토큰 검증이 실패할 수 있어서, 승격은 호출자가 토큰 획득에 성공한 뒤에 한다.
6. quota 경로: 임계 > 0이면 active가 자격이고 (사용률 미상이거나 임계 미만)일 때 유지,
   아니면 최저 사용률. 임계 0이면 active 우선, 그것도 안 되면 `only-eligible`.
7. 아무것도 못 고르면 쿨다운된 계정이 하나라도 있으면 `all-cooled`, 아니면 `none`

`reason` 값은 9개이고 관리 응답과 로그에 나가므로 문자열까지 계약이다.

### 쿨다운 (`parseRetryAfterMs:140`)

숫자 초는 **올림 후 1ms~15분으로 클램프**, 날짜 문자열은 `Date.parse` 후 남은 시간을 15분
상한. 음수/0/파싱 불가는 부재. 기본 쿨다운 60초.

### 사용률

`usageScore`는 캐시된 `fiveHourPercent`를 0..100으로 클램프, 미상은 100.
wp7c의 `AnthropicQuotaCache.UsageScore`가 이미 같은 계약이다 — **이 페이즈가 그것을
처음으로 호출한다.**

## 구현

### 1. `go/internal/oauth/anthropic_pool.go` 신규

`AnthropicPool` 타입: 스토어 + `AnthropicQuotaCache` + `RotationRegistry`(풀 키
`anthropic`) + 세션 어피니티(24시간 / 최대 2000, LRU) + 계정별 쿨다운.

`Resolve(sessionKey string, pool config.NormalizedAnthropicPool, now) (AnthropicSelection)`
로 위 7단계를 그대로 구현한다. `AnthropicSelection{AccountID string, Reason string}`.

**선택 경로는 HTTP를 호출하지 않는다** — 쿼터는 `Lookup`으로 동기 조회만 한다.

### 2. 자격 판정

`isPoolCredentialUsable` 대응이 필요하다. `CredentialStore`에 `source`와 `expires`가
있는지 먼저 **측정**하고, 없으면 그 사실을 기록한 뒤 이 조건을 별도 항목으로 남긴다.
없는 필드를 있는 것처럼 구현하면 안 된다.

### 3. 쿨다운 파서

`ParseAnthropicRetryAfter`를 오라클과 1:1로. Codex 쪽 `ComputeQuotaCooldown`과 상한이
다르므로(15분 vs 다른 값) 재사용하지 말고 별도로 두되, 차이를 주석으로 남긴다.

### 4. 리졸버 배선

`AuthResolver.Pool`이 단일 풀이라 Anthropic 풀을 붙일 자리가 없다. 프로바이더→풀
레지스트리로 바꾸되, 기존 `openai` 경로의 동작은 한 줄도 바뀌면 안 된다.

## 측정으로 확정할 것 (B 시작 전)

1. 풀 비활성 시 저장된 active가 그대로 나오고 `pool-disabled`인지
2. 세션 키 없이 RR일 때 active가 유지되는지(4단계) — 이게 없으면 매 턴 회전한다
3. 세션 키가 있을 때는 RR이 실제로 회전하는지
4. 전략 픽이 active를 **승격하지 않는지**
5. `reason` 문자열 9종이 각각 어떤 조건에서 나오는지
6. `Retry-After: 3` / `Retry-After: 0` / 날짜 / 쓰레기값의 쿨다운
7. 모든 계정 쿨다운 시 `all-cooled`, 계정 자체가 없을 때 `none`

## 수용 기준

- 위 7개 측정을 Go가 전부 재현한다.
- 선택 경로에서 HTTP 호출 0회 (테스트로 강제).
- `isPoolCredentialUsable` 대응이 존재하거나, 부재 사유가 원장에 기록된다.
- 기존 `openai` 풀 경로의 동작 변화 0.
- `(umask 022; go test ./... -count=1)` non-ok 0줄, 3-OS 크로스빌드 통과.
- `git diff --name-only -- src/` 가 0 파일.
