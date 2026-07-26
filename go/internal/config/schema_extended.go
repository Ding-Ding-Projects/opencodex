package config

type ClaudeCodeConfig struct {
	Enabled            *bool                  `json:"enabled,omitempty"`
	NativePassthrough  *bool                  `json:"nativePassthrough,omitempty"`
	AnthropicBaseURL   string                 `json:"anthropicBaseUrl,omitempty"`
	BodyStallSec       int                    `json:"bodyStallSec,omitempty"`
	BodyMaxBytes       int64                  `json:"bodyMaxBytes,omitempty"`
	Model              string                 `json:"model,omitempty"`
	SmallFastModel     string                 `json:"smallFastModel,omitempty"`
	ModelMap           map[string]string      `json:"modelMap,omitempty"`
	SystemEnv          bool                   `json:"systemEnv,omitempty"`
	AuthMode           string                 `json:"authMode,omitempty"`
	MaxContextTokens   int                    `json:"maxContextTokens,omitempty"`
	AlwaysEnableEffort bool                   `json:"alwaysEnableEffort,omitempty"`
	TierModels         *ClaudeTierModels      `json:"tierModels,omitempty"`
	AutoContext        *bool                  `json:"autoContext,omitempty"`
	AutoCompactWindow  int                    `json:"autoCompactWindow,omitempty"`
	BlockedSkills      []string               `json:"blockedSkills,omitempty"`
	InjectAgents       *bool                  `json:"injectAgents,omitempty"`
	WebSearchSidecar   *ClaudeSidecarOverride `json:"webSearchSidecar,omitempty"`
	VisionSidecar      *ClaudeSidecarOverride `json:"visionSidecar,omitempty"`
}

type ClaudeTierModels struct {
	Opus   string `json:"opus,omitempty"`
	Sonnet string `json:"sonnet,omitempty"`
	Haiku  string `json:"haiku,omitempty"`
	Fable  string `json:"fable,omitempty"`
}

type ClaudeSidecarOverride struct {
	Backend string `json:"backend,omitempty"`
	Model   string `json:"model,omitempty"`
}

type ShadowCallInterceptConfig struct {
	Enabled      bool     `json:"enabled,omitempty"`
	Model        string   `json:"model,omitempty"`
	SourceModels []string `json:"sourceModels,omitempty"`
}

type ProxyAPIKey struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Key       string `json:"key"`
	CreatedAt string `json:"createdAt"`
}

type CodexAccount struct {
	ID               string `json:"id"`
	Email            string `json:"email"`
	Alias            string `json:"alias,omitempty"`
	Plan             string `json:"plan,omitempty"`
	ChatGPTAccountID string `json:"chatgptAccountId,omitempty"`
	LogLabel         string `json:"logLabel,omitempty"`
	IsMain           bool   `json:"isMain"`
}

type TokenGuardianConfig struct {
	Enabled                   bool   `json:"enabled,omitempty"`
	TickSeconds               int    `json:"tickSeconds,omitempty"`
	JitterSeconds             int    `json:"jitterSeconds,omitempty"`
	Concurrency               int    `json:"concurrency,omitempty"`
	LeadSeconds               int    `json:"leadSeconds,omitempty"`
	FailureBackoffBaseSeconds int    `json:"failureBackoffBaseSeconds,omitempty"`
	FailureBackoffMaxSeconds  int    `json:"failureBackoffMaxSeconds,omitempty"`
	CodexWarmupEnabled        bool   `json:"codexWarmupEnabled,omitempty"`
	CodexWarmupMaxAgeSeconds  int    `json:"codexWarmupMaxAgeSeconds,omitempty"`
	CodexWarmupModel          string `json:"codexWarmupModel,omitempty"`
}

type ResponsesItemIDRepairConfig struct {
	Message                  []string `json:"message,omitempty"`
	Reasoning                []string `json:"reasoning,omitempty"`
	RepairMissingTerminalIDs bool     `json:"repairMissingTerminalIds,omitempty"`
}
