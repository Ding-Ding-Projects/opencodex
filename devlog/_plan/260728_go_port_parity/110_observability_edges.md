# 110 — wp11: 관측성 + 어댑터 엣지 케이스

선행: 없음 (런타임 계열, 세 슬라이스 서로 독립) · 순서 정본: `006`

**감사 B4 정정:** 처음 이 문서는 개요였다. Kiro는 수용 기준이 아예 없었고 업데이트 항목은
"나중에 대조"에 그쳤으며, 스코프에서 `go/internal/oauth/**`를 제외하면서 Kiro 구현이 거기
있다고 지목하는 자기모순이 있었다. 아래처럼 세 개의 독립 슬라이스로 분할하고 스코프 모순을
바로잡는다.

| 슬라이스 | work-phase | 내용 |
| --- | --- | --- |
| 110.A | `wp11a` | 요청 로그·사용량 관측성 (110.1~110.4) |
| 110.B | `wp11b` | Kiro OAuth 다계정 (110.5) |
| 110.C | `wp11c` | Desktop 경로·업데이트·키 보존 (110.6~110.8) |

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

## 슬라이스별 변경 지도와 활성화 시나리오

### 110.A — 요청 로그·사용량 (`wp11a`)

| 파일 | 동작 |
| --- | --- |
| `go/internal/server/request_log_port.go` | `RequestLogEntry`에 `ConversationID` 필드, DTO 노출, `FilterRequestLogs`에 `conversationId`/`conversation` 필터 |
| `go/internal/server/responses_core_port.go` | 요청 처리에서 대화 ID 기록 배선 |
| `go/internal/usage/log.go` | 실효 effort, 출력 한도 분류 |
| `go/internal/codex/catalog_roster.go` + 동기화 경로 | 누락 사유 표면화 |

| # | 활성화 | 관측 가능한 증거 |
| --- | --- | --- |
| 1 | 같은 대화의 요청 2건 + 다른 대화 1건, `?conversationId=X` 조회 | 앞 2건만 반환 |
| 2 | `?conversation=X` 별칭 | 동일 결과 |
| 3 | effort 캡이 걸린 요청 | 요청 effort와 실효 effort가 **모두** 기록되고 서로 다름 |
| 4 | 출력 한도로 잘린 응답 vs 자연 종료 | 로그에서 두 경우가 구분됨 |
| 5 | 호환 불가 모델 포함 동기화 | 결과가 제외 사유를 포함 |

테스트: `go/internal/server/request_log_conversation_test.go`, `usage/log_effort_test.go`.

### 110.B — Kiro OAuth 다계정 (`wp11b`)

**보안 경계 (OAuth).** 자격증명 저장·선택 경로를 바꾼다.

감사 2라운드 정정: 초안은 이 슬라이스를 개요로 남기고 "오라클 대조는 P에서"라고 미뤘다.
그것은 DIFFLEVEL-ROADMAP-01 위반이며, 더 나쁘게는 스로틀 회복을 **잘못된 Go 소유자**에
배정했다.

| 파일 | 동작 | 오라클 |
| --- | --- | --- |
| `go/internal/oauth/kiro.go` | 브라우저 계정 전환의 **트랜잭션 스냅샷/복원** | `src/oauth/kiro.ts:196-227,271-318` |
| `go/internal/oauth/kiro_sqlite.go` | 안정적 계정 신원 바인딩, 모호한 토큰 거부 | 동일 |
| `go/internal/adapter/kiro/retry.go` | **경계 있는 공유 스로틀 회복** | `src/adapters/kiro-retry.ts:268-307` |

**고정된 수치 계약 (감사 3라운드).** "상한을 정한다"는 계약이 아니다. 오라클은
`THROTTLE_ATTEMPTS = 3`(`src/adapters/kiro-retry.ts:19`)이고 루프는
`attempt < THROTTLE_ATTEMPTS`(`:277`), 마지막 시도 판정은 `attempt === THROTTLE_ATTEMPTS - 1`
(`:299`)이다. 따라서 다음이 **불변식**이며 구현 재량이 아니다:

- 상류 시도는 **총 3회**를 넘지 않는다
- 쿨다운/프로브는 **프로세스 전역 공유** 의미론을 갖는다 (호출자마다 중복 재시도 금지)
- 회복 소유자는 **단 하나**로 명명된다

Go `retry.go:68`이 "일반 HTTP 상태 재시도는 호출자 정책에 맡긴다"고 명시하므로 회복 코드를
`retry.go`에 둘지 호출자에 둘지는 내부 배치 선택으로 남는다 — **위 세 불변식이 고정된
이후에만** 그렇다.

| # | 활성화 | 관측 가능한 증거 |
| --- | --- | --- |
| 1 | 자격증명 2개 존재 | 모호한 선택 거부, 명시적 계정 선택 |
| 2 | 브라우저 계정 추가가 외부 신원 전환 **이후** 실패 | 이전 세션이 스냅샷에서 복원됨, 계정 메타데이터 바인딩 유실 없음 |
| 3 | 동시 호출자 2인에게 일시적 429 | 회복이 **공유**되고 호출자당 중복 재시도 없음 |
| 4 | 429 반복 | 상류 시도가 **정확히 3회**에서 멈춤 |
| 5 | 쿨다운 중 요청 | 프로브 없이 쿨다운 준수 |
| 6 | 모든 실패 경로 | stdout·stderr·로그에 토큰 문자열 부재 |

### 110.C — Desktop 경로·업데이트·키 보존 (`wp11c`)

감사 2라운드 정정: 초안은 콤보 쿼터 폴백을 `update/job.go`에 배정했는데 **틀렸다**.
업스트림의 폴백은 Responses 코어에 있다(`src/server/responses/core.ts:295-304`의 reset 유래
쿨다운, `:931-941`의 동일 프로바이더 콤보 핸드오프). Go의 대응 경로는
`go/internal/server/responses_core_port.go:465`이며 초안 스코프에 없었다.

| 파일 | 동작 | 오라클 |
| --- | --- | --- |
| `go/internal/claude/desktop3p*` | 타깃 플랫폼 3P 설정 경로 해석 | Desktop 커밋군 |
| `go/internal/update/job.go` | **낡은 잡 정리만** | `7710185c` 일부 |
| `go/internal/server/responses_core_port.go` | **콤보 쿼터 폴백** (reset 유래 쿨다운, 동일 프로바이더 핸드오프) | `src/server/responses/core.ts:295,931` |
| `go/internal/config/api_keys.go` | OAuth 로그인 시 저장된 API 키 보존 | `131573e3` |

| # | 활성화 | 관측 가능한 증거 |
| --- | --- | --- |
| 1 | 각 타깃 플랫폼 지정 | 기대 경로 산출, 호스트 OS와 무관 |
| 2 | 낡은 업데이트 잡 존재 | 정리됨 |
| 3 | 콤보 타깃이 **reset 유래** 429/402 반환 + 이후 동일 프로바이더 타깃 존재 | 핸드오프 발생, reset 유래 쿨다운 적용 |
| 4 | 콤보 타깃이 **`Retry-After` 있는** 429/402 반환 + 이후 동일 프로바이더 타깃 존재 | **차단형 쿨다운**, 동일 프로바이더 핸드오프 **없음**, 추가 상류 요청 **없음** |
| 5 | 콤보 타깃이 **reset도 Retry-After도 없는** 429/402 반환 + 이후 동일 프로바이더 타깃 존재 | 동일하게 차단, 핸드오프 없음, 추가 상류 요청 없음 |
| 6 | API 키 보유 상태에서 OAuth 로그인 | 키가 그대로 남음 |

4·5번이 없으면 Go가 모든 쿼터 실패에서 핸드오프해도 기준을 통과한다. 오라클 주석이
명시한다: "reset 타임스탬프는 쿼터 창을 서술할 뿐 계정 전체 사용 중단 지시가 아니다.
따라서 콤보는 같은 요청 내에서 나중 모델을 시도할 수 있으나, **Retry-After와 헤더 없는
쿼터 실패는 차단으로 남는다**"(`src/server/responses/core.ts:295-304`).

## 공통 원칙

세 슬라이스는 서로 독립이다. 하나가 막혀도 나머지를 진행한다. 각 항목은 자체 커밋과 자체
테스트를 갖는다. 오라클과 대조해 **이미 일치하는 것으로 판명되면 그 사실을 기록하고
넘어간다** — 없는 차이를 만들어내지 않는다.

## 스코프 경계

IN: `go/internal/server/request_log_port.go`, `go/internal/usage/log.go`,
`go/internal/codex/catalog_roster.go` 및 동기화 경로, **`go/internal/oauth/kiro*`**,
`go/internal/adapter/kiro/**`, `go/internal/claude/desktop3p*`, `go/internal/update/job.go`,
**`go/internal/server/responses_core_port.go`의 콤보 쿼터 폴백 경로**,
`go/internal/config/api_keys.go`.
OUT: `src/**`, 그 외 `go/internal/oauth/**`(계정 풀은 `070` 소관).
