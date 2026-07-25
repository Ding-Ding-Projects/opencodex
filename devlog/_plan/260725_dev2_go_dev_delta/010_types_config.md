# 010_types_config — Types/config + OpenAI tiers (#404)

## Objective

Port per-model wire override types, config validation, and OpenAI tier predicates
from TS `src/types.ts`, `src/config.ts`, `src/providers/openai-tiers.ts` to Go.

## Files

### NEW

| Path | Role |
|---|---|
| `go/internal/providers/openai_tiers.go` | `IsCanonicalOpenAiForwardProvider`, `SupportsNativeResponsesCompactEndpoint`, provider ID constants |
| `go/internal/providers/openai_tiers_test.go` | Tier predicate activation tests |

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/types/types.go` | `Tool` struct lacks freeform; no `ModelAdapters`; no wire-pinned models; AdapterEvent lacks `assistant_boundary` | Add `ModelAdapters map[string]string` to provider config type; add `AssistantBoundary` event type; add `IsWirePinnedModel`, `PinnedWireAdapter`, `ModelAdapterOverrideAllowed` |
| `go/internal/types/interfaces.go` | ProviderConfig may lack ModelAdapters | Add `ModelAdapters` field if provider config is here |
| `go/internal/config/config.go` | No modelAdapter validation | Add `ValidateModelAdapters(provider, modelAdapters)` rejecting invalid wires, pinned models, canonical forward providers |
| `go/internal/config/config_test.go` | No modelAdapter tests | Add validation activation tests |

### DELETE

None.

## Before/after contracts

1. `ModelAdapterOverrideAllowed` = {"openai-chat", "openai-responses"} — only OpenAI-shaped wires
2. `IsWirePinnedModel("opencode-go", "minimax-m2.5")` → true (Anthropic wire only)
3. `PinnedWireAdapter("opencode-go", "minimax-m2.5")` → "anthropic"
4. `IsCanonicalOpenAiForwardProvider(provider)` → true iff adapter=openai-responses, authMode=forward, baseUrl=chatgpt.com/backend-api/codex
5. `SupportsNativeResponsesCompactEndpoint(name, provider)` → true for canonical forward OR openai-apikey with api.openai.com/v1
6. Config validation rejects: non-allowed wire, pinned model override, override on canonical forward provider
7. `EventAssistantBoundary` adapter event type exists

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| T1 | Wire override allowed | modelAdapters {"gpt-4o": "openai-chat"} | validation passes | config_test.go |
| T2 | Wire override rejected (bad wire) | modelAdapters {"gpt-4o": "cursor"} | validation error | config_test.go |
| T3 | Pinned model override rejected | modelAdapters {"minimax-m2.5": "openai-chat"} on opencode-go | validation error | config_test.go |
| T4 | Canonical forward override rejected | modelAdapters on canonical forward provider | validation error | config_test.go |
| T5 | Canonical forward detection | adapter=openai-responses, authMode=forward, baseUrl=chatgpt codex | true | openai_tiers_test.go |
| T6 | Non-canonical detection | different baseUrl | false | openai_tiers_test.go |
| T7 | Native compact endpoint | canonical forward | true | openai_tiers_test.go |
| T8 | Native compact endpoint | openai-apikey + api.openai.com | true | openai_tiers_test.go |
| T9 | Native compact endpoint | arbitrary gateway | false | openai_tiers_test.go |

## Verification

```bash
cd go
go test ./internal/types ./internal/config ./internal/providers -count=1
go build ./... && go vet ./...
```
