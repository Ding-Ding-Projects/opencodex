# 000 — go 런타임 parity chase: 오라클 미이식분과 cli-proxy-api 대조

브랜치 `dev2-go`, 기준 커밋 `52cc29be2`, 작성 2026-07-29.
세션 goalplan: `.codexclaw/goalplans/make-the-opencodex-go-native-runtime-on-dev2-go/`.

## 이 유닛이 답하는 질문

"go가 오라클을 다 따라잡았는가"는 지금까지 세 번 물었고, 세 번 다 답이 바뀌었다.
`260728_go_port_parity`는 CLI/스토리지/OAuth 축을 세웠고, `260729_go_port_blindspot_sweep`은
"파리티 테스트가 보지 않는 경로에 결함이 산다"를 실측으로 보였다. 그 사이 오늘 하루에만
startup health, codexRuntime, account pause, pause-exhausted, storage 라우트 등록이 랜딩했다.

그래서 이번 유닛은 **남은 것만** 다룬다. 문서를 믿지 않고 트리를 다시 측정했고, 이미
고쳐진 항목은 이 로드맵에서 뺐다. 그리고 처음으로 축을 하나 더 붙인다 — 사용자의 요구는
"cli-proxy-api보다 더 안정적으로 우리 기능을 수행"이므로, 기능 개수뿐 아니라 **실패 처리
깊이**를 외부 Go 구현과 대조한다.

## 측정 결과 (이 문서의 근거)

### 라우트 표면

```
오라클 /api/* 경로: 69
go 핸들러가 등록한 경로: 80 (메서드별 분리 포함)
go에 핸들러가 없는 오라클 경로: 4
```

`260729_go_port_blindspot_sweep`이 센 9개에서 4개로 줄었다. 줄어든 5개는 storage 읽기
클러스터와 startup-health로, 오늘 랜딩했다. `/api/system/restart`와
`/api/oauth/accounts/clear-cooldown`은 초기 diff에서 미이식으로 잡혔으나 오탐이었다 —
전자는 `go/internal/management/system.go:15`, 후자는 쿨다운 해제 로직이
`go/internal/codex/routing_health.go:325`에 산다. 남은 진짜 4개:

| 경로 | 오라클 | go | 성격 |
| --- | --- | --- | --- |
| `POST /api/storage/cleanup` | `storage-routes.ts:273` | ABSENT | 실행기 미이식 |
| `POST /api/storage/trash/restore` | `storage-routes.ts:374` | ABSENT | 실행기 미이식 |
| `POST /api/storage/cleanup-policy/run` | `storage-routes.ts:468` | ABSENT | 실행기 미이식 |

세 경로 모두 같은 뿌리를 공유한다: 파괴적 파일 이동을 수행하는 실행기가 go에 없다.
`go/internal/storage/`에는 계약 타입과 원시요소가 대량으로 있지만,
`cleanup_execute_types.go:5` 주석이 직접 밝힌다 — "the execution port lands later".
오라클 `src/storage/cleanup.ts`는 3,014줄이다.

### 조용히 잘린 응답

`260729_go_port_blindspot_sweep` §2가 지목한 두 건은 아직 살아 있다.

| 경로 | 오라클이 담는 키 | go 응답 | 사용자 증상 |
| --- | --- | --- | --- |
| `GET /api/subagent-models` | `available` (`agent-settings-routes.ts:335`) | `chosen`만 (`agents.go:18`) | 서브에이전트 모델 선택기가 영구히 빈 목록 |
| `GET /api/injection-model` | `available` (`agent-settings-routes.ts:367`) | `efforts`까지만 (`agents.go:59`) | 주입 모델 드롭다운이 빈 목록 |

중요한 사실: go에 이미 `(*API).availableModels()`가 있고
(`runtime_settings.go:56`), 형제 라우트 두 곳(`runtime_settings.go:85`, `:203`)이 이미
그것을 쓴다. 즉 이 둘은 이식이 아니라 **호출 누락**이다.

### 배선되지 않은 모듈

업데이트 알림 클러스터가 통째로 죽어 있다. `go/internal/update/notify.go`의 5개 export
(`ReadVersionCache`, `WriteVersionCache`, `CacheStale`, `UpgradeVersion`, `DismissVersion`)는
전 트리에서 자기 선언과 테스트 말고 호출자가 없다. 오라클은
`src/cli/index.ts:183`에서 `maybeShowUpdatePrompt()`를 서버 바인드 **전에** 부른다
(`src/update/notify.ts:225` 주석이 그 순서를 요구한다 — 업데이트가 전역 설치 후 종료하므로).

더 큰 광맥이 트리 안에 이미 문서화돼 있다: `go/internal/claude/DEAD_EXPORT_AUDIT.md`가
adapter 20 / codex 34 / providers 24개 후보를 오라클 대조와 함께 판정해뒀다. 그중 이 유닛이
다루는 것은 "TS production-live인데 go 루트가 죽은" 항목이며, 특히 audit이 **Real**로
판정한 세 건이다.

### 그 audit의 Real 판정 세 건은 감사에서 재측정했다

문서를 믿지 않고 트리를 다시 봤고, 셋 중 둘은 **이미 고쳐져 있었다**:

| audit 판정 | 현재 트리 | 결론 |
| --- | --- | --- |
| cursor `RememberCursorThreadConversation` 미배선 | `adapter/cursor/adapter.go:240`, `:253`에서 호출 중 | 해소됨 |
| openai `AntigravityUserAgent` 지문 드리프트 (`1.0.0` 고착) | `adapter/google/antigravity.go:20`이 `1.0.13` | 해소됨 |
| cursor `FilterCursorConfiguredModelsByLiveDiscovery` 미호출 | 미확인 | **후보로 남김** |

그래서 이 로드맵은 셋 중 어느 것도 work-phase로 잡지 않는다. 남은 하나는 카탈로그
가시성 계열이라 WP1의 "남기는 것"(형제 라우트 비활성 필터)과 함께 후속 사이클에서
한 묶음으로 다루는 편이 낫다.

`DEAD_EXPORT_AUDIT.md` 자체가 `e5ba7b7b` 기준이라 지금 트리보다 오래됐다는 점도
기록해둔다 — 그 문서를 다음에 인용할 때는 다시 재측정해야 한다.

### cli-proxy-api 대조 (HEAD `c9417c8`, 2026-07-28)

`devlog/_chase/20_cli-proxy-api.md`의 baseline은 `00114be`(2026-06-29)였다. 한 달치 delta를
다시 떴다. 규모는 non-test Go 988파일. 우리가 갖지 않은 **안정성 장치**로 확인된 것:

| 패턴 | cca 위치 | opencodex go | 사용자가 겪는 실패 |
| --- | --- | --- | --- |
| 미완결 스트림 종결 분류 | `codex_executor_terminal.go:15` `codexIncompleteStreamError` | 상응 분류 없음 | `response.completed` 없이 끊긴 스트림이 정상 종료로 위장 |
| `output_item.done` 재조립 | 같은 파일 `collectCodexOutputItemDone`/`patchCodexCompletedOutput` | 없음 | `response.output`이 빈 채 완료되어 턴 결과 유실 |
| 자격증명 동시성 수명주기 | `config/credential_concurrency.go` (하트비트/재확보/백오프 튜너블 11종) | 부분 (`credential store` 교차프로세스 승자만) | 다중 프로세스에서 토큰 갱신 경합 |

세 번째는 우리 쪽 선행 작업이 있으므로 이번 로드맵에서 **조사 항목**으로만 남긴다.
반대로 opencodex가 앞서는 축(kiro 풀세트, Claude Desktop 통합)은 그대로 유지된다 —
cca에는 대응물이 없다.

## work-phase 지도 (의존성 순서)

효과 크기가 아니라 **빌드 순서**로 잘랐다. 각 phase는 앞 phase의 검증된 산출물을 소비한다.

```
010 (응답 조립 배선)  ── 독립, 가장 얕은 층
        │
020 (업데이트 알림 배선) ── CLI 진입점 층
        │
030 (스트림 종결 분류) ── 전송 층, cca 대조에서 유래
        │
040 (storage 실행기)  ── 파괴적 IO, 가장 깊은 층. 앞의 셋과 무관하나
                          위험도가 가장 높아 마지막
```

| phase | 문서 | 산출물 | 독립 검증 |
| --- | --- | --- | --- |
| WP1 | `010_available_models_wiring.md` | 두 라우트에 `available` 복원 | 라이브 프록시 curl로 비어있지 않은 배열 |
| WP2 | `020_update_notify_wiring.md` | 업데이트 알림 CLI 배선 | 캐시 픽스처로 프롬프트 경로 발화 |
| WP3 | `030_incomplete_stream_terminal.md` | 미완결 스트림 분류 + 재조립 | 잘린 SSE 픽스처가 오류로 분류됨 |
| WP4 | `040_storage_execute_port.md` | cleanup/restore 실행기 | 임시 CODEX_HOME에서 실제 파일 이동 |

WP4는 단일 사이클로 닫히지 않을 수 있다. 오라클 3,014줄 대 go 425줄이고 파괴적
파일 이동 + digest 바인딩 + 뮤테이션 조정이 얽힌다. 해당 문서가 자체 분할을 제안하면
그때 goalplan에 work-phase를 append한다(LOOP-UNIT-CHAIN-01).

## 범위 밖

- 오라클 아키텍처 재작성. go가 오라클을 따라가지, 반대가 아니다.
- cca 소스 복사. MIT지만 이 유닛은 **동작 대조**만 한다. 위 표의 세 항목은 우리 코드로
  독립 구현하며, 출처는 문서에만 남긴다.
- `main`/`preview` 승격, 릴리스.
- `DEAD_EXPORT_AUDIT.md`의 나머지 70여 후보 전수 처리. 이번엔 audit이 **Real**로 판정한
  것과 사용자 표면에 닿는 것만 본다.

## 브랜치 규약

`dev2-go`는 공유 브랜치다. 오늘만 해도 우리가 `29ba180ba`를 민 뒤 Wibias가 `52cc29be2`를
얹었다(#640 캐리 + go 포팅). 그래서 매 푸시 전 `git fetch` → `origin/dev` 통합을 머지로
수행하고, 히스토리 재작성 강제푸시는 쓰지 않는다. `MAINTAINERS.md`가 요구하는
"dev 머지는 dev2-go가 실을 때까지 끝나지 않는다"는 이 방향과 같다.

현재 상태: `origin/dev2-go` = `52cc29be2`, `origin/dev` 대비 미보유 커밋 0.
