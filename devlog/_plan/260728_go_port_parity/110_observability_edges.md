# 110 — wp11: 관측성 + 어댑터 엣지 케이스

work-phase: `wp11` · 선행: `100` · 후속: 120

이 단계는 P2 잔여를 모은다. 개별로는 작지만 대시보드 귀속과 어댑터 신뢰성에 영향을 준다.

## 110.1 대화 상관관계 (`conversationId`)

`030`에서 이월된 항목이다. TS `filterRequestLogs`(`src/server/request-log.ts:741`)는
`conversationId`(별칭 `conversation`) 쿼리를 지원하고 `matchesLogConversationId`로 비교한다.
Go `FilterRequestLogs`(`go/internal/server/request_log_port.go:721`)는 `provider`/`status`/`tail`만
읽는다.

필터만 추가할 수 없다 — **로그 엔트리에 `conversationId` 필드 자체가 없다.** 따라서
순서는: 엔트리 필드 추가 → 기록 경로 배선 → DTO 노출 → 필터 추가.

수용: 같은 대화의 두 요청이 같은 ID를 갖고, 필터가 그 둘만 반환하며, 별칭 `conversation`도
동작할 것.

## 110.2 실효 reasoning effort

Go는 요청 로그에 **요청된** effort를 갖고 있다(`request_log_port.go:33`). 오라클은 **실효**
effort도 기록한다 — 캡·프로바이더 제약·모델 지원 여부로 요청값이 강등될 수 있기 때문이다.
두 값이 다를 때가 정확히 사용자가 알고 싶은 순간이다.

수용: effort 캡이 걸린 요청에서 요청값과 실효값이 모두 기록되고 서로 다를 것.

## 110.3 요청 출력 한도 분류

오라클은 출력이 한도로 잘렸는지 분류한다. 수용: 한도 도달 응답과 자연 종료 응답이 로그에서
구분될 것.

## 110.4 카탈로그 누락 사유

Go에는 로스터 제외 사유가 있다(`go/internal/codex/catalog_roster.go:50`). 오라클은 추가로
동기화·GUI 경로에서 **호환 불가/불완전 모델이 왜 빠졌는지** 표면화하고 카탈로그/캐시 쓰기를
알린다. 없으면 "내 모델이 왜 안 보이지"가 불투명해진다.

수용: 호환 불가 모델을 포함한 동기화가 사유를 포함한 결과를 반환할 것.

## 110.5 Kiro 브라우저 다계정

Go는 Kiro SQLite 자격증명 임포트와 모호한 토큰 선택 보호를 갖고 있다
(`go/internal/oauth/kiro_sqlite.go:139`)만, 업스트림의 **브라우저 다계정 로그인 계약**과
재시도/완료/스로틀 회복 회귀는 없다.

**보안 인접**(OAuth). 자격증명 저장·선택 경로를 건드리므로 리뷰 대상이다.

## 110.6 Claude Desktop 타깃 플랫폼 경로

Go에 트랜잭션 방식 Desktop 3P 적용은 있다(`go/internal/claude/desktop3p_delta_test.go:14`).
없는 것은 **타깃 플랫폼 3P 설정 경로 해석**이다. 호스트 OS와 타깃 OS가 다를 때 잘못된
경로에 쓰게 된다.

수용: 각 타깃 플랫폼에 대해 기대 경로가 산출되고, 호스트 OS와 무관할 것.

## 110.7 업데이트 낡은 잡 정리 · 콤보 쿼터 폴백

`origin/dev`의 가장 최신 커밋(`7710185c0`)이 낡은 업데이트 잡과 콤보 쿼터 폴백을 다룬다.
Go에는 업데이트 잡 수명주기/복구는 있으나(`go/internal/update/job.go:368`) 정확한 대응이
확인되지 않았다. 이 단계에서 오라클과 1:1 대조한다.

## 110.8 OAuth 로그인 시 저장된 API 키 보존

오라클은 OAuth 로그인이 저장된 API 키를 지우지 않도록 보존한다. Go는 프로바이더 키 인증과
OAuth를 분리하고는 있으나(`go/internal/config/api_keys.go:17`) 마이그레이션 대응이
확인되지 않았다.

수용: API 키가 있는 상태에서 OAuth 로그인 후 키가 그대로 남을 것.

## 우선순위 원칙

이 단계의 항목들은 서로 독립적이다. 하나가 막혀도 나머지를 진행한다. 각 항목은 자체 커밋과
자체 테스트를 갖는다. 오라클과 대조해 **이미 일치하는 것으로 판명되면 그 사실을 기록하고
넘어간다** — 없는 차이를 만들어내지 않는다.

## 스코프 경계

IN: `request_log_port.go`, `usage/log.go`, `codex/catalog_roster.go` 및 동기화 경로,
`adapter/kiro/**`, `claude/desktop3p*`, `update/job.go`, `config/api_keys.go`.
OUT: `src/**`.
