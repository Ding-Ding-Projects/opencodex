package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestTypeScriptConfigSchemaManifestHasNoMissingGoFields(t *testing.T) {
	top := "port,providers,defaultProvider,openaiProviderTierVersion,claudeCode,subagentModels,subagentModelFallback,subagentModelFallbackPollMs,injectionModel,injectionEffort,fastMode,streamMode,injectionPrompt,multiAgentGuidanceEnabled,effortCap,subagentEffortCap,disabledModels,customModels,shadowCallIntercept,multiAgentMode,providerContextCaps,contextCapValue,hostname,proxy,stallTimeoutSec,connectTimeoutMs,shutdownTimeoutMs,websockets,apiKeys,codexAutoStart,codexShimAutoRestore,syncResumeHistory,modelCacheTtlMs,cacheRetention,webSearchSidecar,visionSidecar,images,search,codexAccounts,activeCodexAccountId,autoSwitchThreshold,upstreamFailoverThreshold,combos,tokenGuardian,corsAllowOrigins"
	provider := "adapter,modelAdapters,baseUrl,responsesPath,allowPrivateNetwork,disabled,codexAccountMode,apiKey,apiKeyPool,defaultModel,models,liveModels,selectedModels,contextWindow,modelContextWindows,modelInputModalities,modelMaxInputTokens,defaultMaxOutputTokens,modelMaxOutputTokens,headers,openRouterRouting,modelOpenRouterRouting,authMode,keyOptional,freeTier,note,modelSuffixBracketStrip,refreshPolicy,reasoningEfforts,modelReasoningEfforts,modelDefaultReasoningEfforts,modelSupportsReasoningSummaries,reasoningEffortMap,modelReasoningEffortMap,noReasoningModels,noTemperatureModels,noTopPModels,noPenaltyModels,parallelToolCalls,promptCacheKey,responsesItemIdRepair,autoToolChoiceOnlyModels,preserveReasoningContentModels,reasoningSplitModels,thinkingToggleModels,thinkingBudgetModels,escapeBuiltinToolNames,noVisionModels,googleMode,project,location,mcpServers,desktopExecutor,unsafeAllowNativeLocalExec,nativeLocalExec"
	assertJSONFieldManifest(t, reflect.TypeOf(Config{}), strings.Split(top, ","))
	assertJSONFieldManifest(t, reflect.TypeOf(ProviderConfig{}), strings.Split(provider, ","))
}

func assertJSONFieldManifest(t *testing.T, typ reflect.Type, expected []string) {
	t.Helper()
	actual := make(map[string]bool, typ.NumField())
	for index := 0; index < typ.NumField(); index++ {
		name := strings.Split(typ.Field(index).Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			actual[name] = true
		}
	}
	for _, name := range expected {
		if !actual[name] {
			t.Errorf("%s is missing TypeScript field %q", typ.Name(), name)
		}
	}
}
