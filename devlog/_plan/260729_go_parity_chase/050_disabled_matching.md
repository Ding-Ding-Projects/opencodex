# 050 — WP5: 비활성 매칭의 관대한 비교와 이중 접두 수정

선행: WP1 (이 결함은 WP1의 대조 테스트와 라이브 검증에서 발견됐다).
상태: 구현 완료. 남은 divergence는 아래 §남기는 것.

## 어떻게 발견됐나

WP1에서 형제 라우트를 "바이트 안정"으로 못박는 대조 테스트를 썼는데, 첫 실행에
실패하면서 예상 못 한 값을 뱉었다:

```
[openai/gpt-5.6 p/p/m p/p/hidden]
```

`p/m`이 `p/p/m`이 돼 있었다. 그리고 라이브 프록시에서 비활성화를 검증할 때,
`openai/gpt-5.6-luna`(namespaced)로는 안 먹고 `gpt-5.6-luna`(bare)로만 먹는 것도 나왔다.

둘 다 WP1의 범위 밖이라 그때는 테스트로 현재 동작을 **고정**해두고 넘어갔다. 이 문서가
그 후속이다.

## 결함 1 — 이중 접두

`availableModels()`(`runtime_settings.go:56`)가 provider를 무조건 앞에 붙였다. ID가 이미
`p/hidden`처럼 provider를 담고 있으면 `p/p/hidden`이 된다. 그런 셀렉터에 해당하는 모델은
어디에도 없다.

`FilterVisibleRuntimeModels`은 같은 자리에서 이미 `strings.Contains(model.ID, "/")`로
걸러내고 있었다. 같은 가드를 적용했다.

## 결함 2 — 완고한 비활성 비교

`FilterVisibleRuntimeModels`의 비활성 판정이 정확한 문자열 두 개(`model.ID`, `publicID`)만
봤다. 오라클은 `slugEquals`(`src/providers/slug-codec.ts:55`)로 비교하는데, 이건 raw 형태와
alias 인코딩 형태를 **둘 다** 받아준다:

```ts
stored === `${provider}/${id}` || stored === routedSlug(provider, id)
```

go에는 `registry.SlugEquals`(`registry/slug.go:33`)가 이미 동일하게 있었고,
`/api/models`(`management/models.go:51`)는 이미 그걸 쓰고 있었다. 카탈로그 가시성 필터만
안 쓰고 있었다. import 순환도 없었다(`codex`↔`registry` 양방향 무참조 확인).

## 변경

- `go/internal/codex/catalog_visibility.go` — `disabledBySlug` 헬퍼 추가,
  라우팅 모델 비활성 판정에 `registry.SlugEquals` 적용.
- `go/internal/management/runtime_settings.go` — `availableModels()`의 접두 조건에
  `!strings.Contains(model.ID, "/")` 가드 추가.
- `go/internal/management/agents_available_test.go` — WP1이 결함을 못박아둔 테스트를
  **의도적으로** 갱신(이름도 `...IsUnfilteredButWellFormed`로 변경): 여전히 비필터이되
  `p/p/` 접두는 금지. 두 슬러그 형태를 각각 비활성화하는 회귀 테스트 추가.

## 검증

`go build` / `go vet` 클린, Go 스위트 전체 통과.
`TestDisabledMatchingToleratesBothSlugForms`가 `p/m`·`p/hidden` 두 형태 모두에서
비활성 모델이 사라지는 것을 확인한다.

## 남기는 것 — 라이브 검증에서 드러난 별개 divergence

라이브 프록시에서 `openai/gpt-5.6-luna`로 비활성화하면 **여전히** 목록에 남는다.
이건 이 유닛의 버그가 아니라 **네이티브 슬러그 형태 자체의 발산**이다:

| | 네이티브 모델을 `available`에 담는 형태 |
| --- | --- |
| 오라클 (`agent-settings-routes.ts:332`) | `listCatalogNativeSlugs()` → **bare** (`gpt-5.6-luna`) |
| go (`availableModelsExcludingDisabled`) | **namespaced** (`openai/gpt-5.6-luna`) |

`filterSupportedNativeSlugs`(`catalog/parsing.ts:390`)가 `/`를 포함한 슬러그를 아예
걸러내므로, 오라클의 네이티브 슬러그에는 provider 접두가 없다. 즉 오라클에서도
`openai/gpt-5.6-luna`로 비활성화하면 네이티브 목록에서 안 걸러진다 — go만의 결함이
아니다. 하지만 **응답 형태가 다르다**는 것 자체가 파리티 gap이고, GUI가 어느 형태를
저장하느냐에 따라 사용자 경험이 갈린다.

고치려면 `available`의 네이티브 부분을 bare로 바꿔야 하는데, 그러면 이 라우트의 응답
바이트가 바뀌고 `/api/claude-code`·`/api/subagent-model-fallback`의 형태와도 어긋난다.
세 라우트와 GUI 저장 형태를 함께 봐야 하는 별개 유닛이다.
