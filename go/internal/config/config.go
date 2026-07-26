package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DefaultPort = 10100
	DefaultHost = "127.0.0.1"
)

var providerNamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`)
var headerNamePattern = regexp.MustCompile(`^[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+$`)
var responsePathSchemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
var sensitiveProviderHeaders = map[string]bool{
	"authorization": true, "cookie": true, "set-cookie": true,
	"proxy-authorization": true, "x-api-key": true, "x-goog-api-key": true,
	"x-amz-security-token": true,
}

type Config struct {
	Port                        int                        `json:"port"`
	Host                        string                     `json:"hostname,omitempty"`
	AuthToken                   string                     `json:"authToken,omitempty"`
	Providers                   map[string]ProviderConfig  `json:"providers"`
	Combos                      map[string]combos.Combo    `json:"combos,omitempty"`
	DefaultProvider             string                     `json:"defaultProvider"`
	OpenAIProviderTierVersion   int                        `json:"openaiProviderTierVersion,omitempty"`
	ClaudeCode                  *ClaudeCodeConfig          `json:"claudeCode,omitempty"`
	SubagentModels              []string                   `json:"subagentModels,omitempty"`
	SubagentModelFallback       []string                   `json:"subagentModelFallback,omitempty"`
	SubagentModelFallbackPollMS int                        `json:"subagentModelFallbackPollMs,omitempty"`
	InjectionModel              string                     `json:"injectionModel,omitempty"`
	InjectionEffort             string                     `json:"injectionEffort,omitempty"`
	InjectionPrompt             string                     `json:"injectionPrompt,omitempty"`
	FastMode                    *bool                      `json:"fastMode,omitempty"`
	StreamMode                  string                     `json:"streamMode,omitempty"`
	EffortCap                   string                     `json:"effortCap,omitempty"`
	SubagentEffortCap           string                     `json:"subagentEffortCap,omitempty"`
	MultiAgentMode              string                     `json:"multiAgentMode,omitempty"`
	MultiAgentGuidanceEnabled   *bool                      `json:"multiAgentGuidanceEnabled,omitempty"`
	DisabledModels              []string                   `json:"disabledModels,omitempty"`
	CustomModels                []CustomModel              `json:"customModels,omitempty"`
	ShadowCallIntercept         *ShadowCallInterceptConfig `json:"shadowCallIntercept,omitempty"`
	ProviderContextCaps         map[string]int             `json:"providerContextCaps,omitempty"`
	ContextCapValue             int                        `json:"contextCapValue,omitempty"`
	Proxy                       string                     `json:"proxy,omitempty"`
	StallTimeoutSec             int                        `json:"stallTimeoutSec,omitempty"`
	ConnectTimeoutMS            int                        `json:"connectTimeoutMs,omitempty"`
	ShutdownTimeoutMS           int                        `json:"shutdownTimeoutMs,omitempty"`
	WebSockets                  bool                       `json:"websockets,omitempty"`
	WebSocketsSet               bool                       `json:"-"`
	WebSocketsRaw               json.RawMessage            `json:"-"`
	APIKeys                     []ProxyAPIKey              `json:"apiKeys,omitempty"`
	CodexAutoStart              *bool                      `json:"codexAutoStart,omitempty"`
	CodexShimAutoRestore        *bool                      `json:"codexShimAutoRestore,omitempty"`
	SyncResumeHistory           *bool                      `json:"syncResumeHistory,omitempty"`
	ModelCacheTTLMS             int                        `json:"modelCacheTtlMs,omitempty"`
	CacheRetention              string                     `json:"cacheRetention,omitempty"`
	WebSearchSidecar            *WebSearchSidecarConfig    `json:"webSearchSidecar,omitempty"`
	VisionSidecar               *VisionSidecarConfig       `json:"visionSidecar,omitempty"`
	Images                      *SidecarTimeoutConfig      `json:"images,omitempty"`
	Search                      *SidecarTimeoutConfig      `json:"search,omitempty"`
	AutoSwitchThreshold         int                        `json:"autoSwitchThreshold,omitempty"`
	UpstreamFailoverThreshold   int                        `json:"upstreamFailoverThreshold,omitempty"`
	CodexAccounts               []CodexAccount             `json:"codexAccounts,omitempty"`
	ActiveCodexAccountID        string                     `json:"activeCodexAccountId,omitempty"`
	TokenGuardian               *TokenGuardianConfig       `json:"tokenGuardian,omitempty"`
	CORSAllowOrigins            []string                   `json:"corsAllowOrigins,omitempty"`
	Debug                       DebugConfig                `json:"debug,omitempty"`
	Log                         LogConfig                  `json:"log,omitempty"`
	ExtraFields                 map[string]json.RawMessage `json:"-"`
}

type SidecarTimeoutConfig struct {
	TimeoutMS int `json:"timeoutMs,omitempty"`
}

type VisionSidecarConfig struct {
	Enabled                   *bool  `json:"enabled,omitempty"`
	Backend                   string `json:"backend,omitempty"`
	Model                     string `json:"model,omitempty"`
	MaxDescriptionsPerTurn    int    `json:"-"`
	MaxDescriptionsPerTurnSet bool   `json:"-"`
	TimeoutMS                 int    `json:"timeoutMs,omitempty"`
}

func (c *VisionSidecarConfig) UnmarshalJSON(data []byte) error {
	type wireConfig struct {
		Enabled                *bool  `json:"enabled,omitempty"`
		Backend                string `json:"backend,omitempty"`
		Model                  string `json:"model,omitempty"`
		MaxDescriptionsPerTurn *int   `json:"maxDescriptionsPerTurn"`
		TimeoutMS              int    `json:"timeoutMs,omitempty"`
	}
	var wire wireConfig
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	c.Enabled, c.Backend, c.Model, c.TimeoutMS = wire.Enabled, wire.Backend, wire.Model, wire.TimeoutMS
	c.MaxDescriptionsPerTurnSet = wire.MaxDescriptionsPerTurn != nil
	if wire.MaxDescriptionsPerTurn != nil {
		c.MaxDescriptionsPerTurn = *wire.MaxDescriptionsPerTurn
	} else {
		c.MaxDescriptionsPerTurn = 0
	}
	return nil
}

func (c VisionSidecarConfig) MarshalJSON() ([]byte, error) {
	type wireConfig struct {
		Enabled                *bool  `json:"enabled,omitempty"`
		Backend                string `json:"backend,omitempty"`
		Model                  string `json:"model,omitempty"`
		MaxDescriptionsPerTurn *int   `json:"maxDescriptionsPerTurn,omitempty"`
		TimeoutMS              int    `json:"timeoutMs,omitempty"`
	}
	var maxDescriptions *int
	if c.MaxDescriptionsPerTurnSet || c.MaxDescriptionsPerTurn != 0 {
		value := c.MaxDescriptionsPerTurn
		maxDescriptions = &value
	}
	return json.Marshal(wireConfig{
		Enabled: c.Enabled, Backend: c.Backend, Model: c.Model,
		MaxDescriptionsPerTurn: maxDescriptions, TimeoutMS: c.TimeoutMS,
	})
}

type WebSearchSidecarConfig struct {
	Enabled                   *bool  `json:"enabled,omitempty"`
	Backend                   string `json:"backend,omitempty"`
	Model                     string `json:"model,omitempty"`
	Reasoning                 string `json:"reasoning,omitempty"`
	MaxSearchesPerTurn        int    `json:"maxSearchesPerTurn,omitempty"`
	TimeoutMS                 int    `json:"timeoutMs,omitempty"`
	RoutedModelStallTimeoutMS int    `json:"routedModelStallTimeoutMs,omitempty"`
}

type ProviderConfig struct {
	Adapter                         string                                         `json:"adapter"`
	BaseURL                         string                                         `json:"baseUrl"`
	ModelAdapters                   map[string]string                              `json:"modelAdapters,omitempty"`
	ResponsesPath                   string                                         `json:"responsesPath,omitempty"`
	AllowPrivateNetwork             bool                                           `json:"allowPrivateNetwork,omitempty"`
	Disabled                        bool                                           `json:"disabled,omitempty"`
	APIKey                          string                                         `json:"apiKey,omitempty"`
	APIKeyPool                      []APIKeyEntry                                  `json:"apiKeyPool,omitempty"`
	DefaultModel                    string                                         `json:"defaultModel,omitempty"`
	Models                          []string                                       `json:"models,omitempty"`
	Headers                         map[string]string                              `json:"headers,omitempty"`
	AuthMode                        string                                         `json:"authMode,omitempty"`
	CodexAccountMode                string                                         `json:"codexAccountMode,omitempty"`
	GoogleMode                      string                                         `json:"googleMode,omitempty"`
	Project                         string                                         `json:"project,omitempty"`
	Location                        string                                         `json:"location,omitempty"`
	ContextWindow                   int                                            `json:"contextWindow,omitempty"`
	DefaultMaxOutputTokens          int                                            `json:"defaultMaxOutputTokens,omitempty"`
	ParallelToolCalls               *bool                                          `json:"parallelToolCalls,omitempty"`
	EscapeBuiltinToolNames          *bool                                          `json:"escapeBuiltinToolNames,omitempty"`
	KeyOptional                     *bool                                          `json:"keyOptional,omitempty"`
	ModelSuffixBracketStrip         *bool                                          `json:"modelSuffixBracketStrip,omitempty"`
	ReasoningEfforts                []string                                       `json:"reasoningEfforts,omitempty"`
	ModelReasoningEfforts           map[string][]string                            `json:"modelReasoningEfforts,omitempty"`
	ModelDefaultReasoningEfforts    map[string]string                              `json:"modelDefaultReasoningEfforts,omitempty"`
	ReasoningEffortMap              map[string]string                              `json:"reasoningEffortMap,omitempty"`
	ModelReasoningEffortMap         map[string]map[string]string                   `json:"modelReasoningEffortMap,omitempty"`
	ModelContextWindows             map[string]int                                 `json:"modelContextWindows,omitempty"`
	ModelInputModalities            map[string][]string                            `json:"modelInputModalities,omitempty"`
	ModelMaxInputTokens             map[string]int                                 `json:"modelMaxInputTokens,omitempty"`
	ModelMaxOutputTokens            map[string]int                                 `json:"modelMaxOutputTokens,omitempty"`
	NoVisionModels                  []string                                       `json:"noVisionModels,omitempty"`
	NoReasoningModels               []string                                       `json:"noReasoningModels,omitempty"`
	NoTemperatureModels             []string                                       `json:"noTemperatureModels,omitempty"`
	NoTopPModels                    []string                                       `json:"noTopPModels,omitempty"`
	NoPenaltyModels                 []string                                       `json:"noPenaltyModels,omitempty"`
	AutoToolChoiceOnlyModels        []string                                       `json:"autoToolChoiceOnlyModels,omitempty"`
	PreserveReasoningContentModels  []string                                       `json:"preserveReasoningContentModels,omitempty"`
	ReasoningSplitModels            []string                                       `json:"reasoningSplitModels,omitempty"`
	ThinkingToggleModels            []string                                       `json:"thinkingToggleModels,omitempty"`
	ThinkingBudgetModels            []string                                       `json:"thinkingBudgetModels,omitempty"`
	SelectedModels                  []string                                       `json:"selectedModels,omitempty"`
	LiveModels                      *bool                                          `json:"liveModels,omitempty"`
	ModelSupportsReasoningSummaries map[string]bool                                `json:"modelSupportsReasoningSummaries,omitempty"`
	PromptCacheKey                  bool                                           `json:"promptCacheKey,omitempty"`
	ResponsesItemIDRepair           *ResponsesItemIDRepairConfig                   `json:"responsesItemIdRepair,omitempty"`
	OpenRouterRouting               *providers.OpenRouterProviderRouting           `json:"openRouterRouting,omitempty"`
	ModelOpenRouterRouting          map[string]providers.OpenRouterProviderRouting `json:"modelOpenRouterRouting,omitempty"`
	RefreshPolicy                   string                                         `json:"refreshPolicy,omitempty"`
	FreeTier                        bool                                           `json:"freeTier,omitempty"`
	Note                            string                                         `json:"note,omitempty"`
	UnsafeAllowNativeLocalExec      bool                                           `json:"unsafeAllowNativeLocalExec,omitempty"`
	NativeLocalExec                 string                                         `json:"nativeLocalExec,omitempty"`
	MCPServers                      map[string]CursorMCPServerConfig               `json:"mcpServers,omitempty"`
	DesktopExecutor                 *CursorDesktopExecutorConfig                   `json:"desktopExecutor,omitempty"`
	ExtraFields                     map[string]json.RawMessage                     `json:"-"`
}

// UnmarshalJSON mirrors the TypeScript schema's passthrough treatment of the
// legacy websockets field. A non-boolean value is preserved for round trips and
// management diagnostics, while runtime feature checks remain safely disabled.
func (c *Config) UnmarshalJSON(data []byte) error {
	type wireConfig Config
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	websockets, present := fields["websockets"]
	if !present {
		decoded := wireConfig(*c)
		if err := json.Unmarshal(data, &decoded); err != nil {
			return err
		}
		*c = Config(decoded)
		c.ExtraFields = unknownJSONFields(fields, reflect.TypeOf(decoded))
		return nil
	}
	var enabled bool
	if err := json.Unmarshal(websockets, &enabled); err == nil {
		decoded := wireConfig(*c)
		if err := json.Unmarshal(data, &decoded); err != nil {
			return err
		}
		*c = Config(decoded)
		c.WebSocketsSet = true
		c.ExtraFields = unknownJSONFields(fields, reflect.TypeOf(decoded))
		return nil
	}
	delete(fields, "websockets")
	withoutWebSockets, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	decoded := wireConfig(*c)
	if err := json.Unmarshal(withoutWebSockets, &decoded); err != nil {
		return err
	}
	*c = Config(decoded)
	c.WebSocketsSet = true
	c.WebSocketsRaw = append(json.RawMessage(nil), websockets...)
	c.ExtraFields = unknownJSONFields(fields, reflect.TypeOf(decoded))
	return nil
}

// MarshalJSON keeps an invalid passthrough value byte-for-byte equivalent at
// the JSON value level, matching TypeScript saveConfig instead of rewriting it.
func (c Config) MarshalJSON() ([]byte, error) {
	type wireConfig Config
	encoded, err := json.Marshal(wireConfig(c))
	if err != nil || len(c.WebSocketsRaw) == 0 && len(c.ExtraFields) == 0 {
		return encoded, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	mergeUnknownJSONFields(fields, c.ExtraFields, reflect.TypeOf(wireConfig(c)))
	fields["websockets"] = append(json.RawMessage(nil), c.WebSocketsRaw...)
	if len(c.WebSocketsRaw) == 0 {
		delete(fields, "websockets")
		if c.WebSocketsSet || c.WebSockets {
			value, _ := json.Marshal(c.WebSockets)
			fields["websockets"] = value
		}
	}
	return json.Marshal(fields)
}

func (p *ProviderConfig) UnmarshalJSON(data []byte) error {
	type wireProvider ProviderConfig
	decoded := wireProvider(*p)
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*p = ProviderConfig(decoded)
	p.ExtraFields = unknownJSONFields(fields, reflect.TypeOf(decoded))
	return nil
}

func (p ProviderConfig) MarshalJSON() ([]byte, error) {
	type wireProvider ProviderConfig
	encoded, err := json.Marshal(wireProvider(p))
	if err != nil || len(p.ExtraFields) == 0 {
		return encoded, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	mergeUnknownJSONFields(fields, p.ExtraFields, reflect.TypeOf(wireProvider(p)))
	return json.Marshal(fields)
}

func unknownJSONFields(fields map[string]json.RawMessage, typ reflect.Type) map[string]json.RawMessage {
	known := make(map[string]bool, typ.NumField())
	for index := 0; index < typ.NumField(); index++ {
		name := strings.Split(typ.Field(index).Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			known[name] = true
		}
	}
	var extras map[string]json.RawMessage
	for name, value := range fields {
		if known[name] {
			continue
		}
		if extras == nil {
			extras = make(map[string]json.RawMessage)
		}
		extras[name] = append(json.RawMessage(nil), value...)
	}
	return extras
}

func mergeUnknownJSONFields(destination, extras map[string]json.RawMessage, typ reflect.Type) {
	known := make(map[string]bool, typ.NumField())
	for index := 0; index < typ.NumField(); index++ {
		name := strings.Split(typ.Field(index).Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			known[name] = true
		}
	}
	for name, value := range extras {
		if !known[name] {
			destination[name] = append(json.RawMessage(nil), value...)
		}
	}
}

// PublicWebSocketsValue returns the passthrough value exposed by the TS
// management API. Runtime callers must continue using WebSockets.
func (c Config) PublicWebSocketsValue() any {
	if len(c.WebSocketsRaw) == 0 {
		return c.WebSockets
	}
	var value any
	if json.Unmarshal(c.WebSocketsRaw, &value) == nil {
		return value
	}
	return c.WebSockets
}

type CursorMCPServerConfig struct {
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	WorkingDirectory string            `json:"cwd,omitempty"`
	URL              string            `json:"url,omitempty"`
	Headers          map[string]string `json:"headers,omitempty"`
	Enabled          *bool             `json:"enabled,omitempty"`
	ToolPrefix       string            `json:"toolPrefix,omitempty"`
}

type CursorDesktopExecutorConfig struct {
	ComputerUseCommand  string            `json:"computerUseCommand,omitempty"`
	RecordScreenCommand string            `json:"recordScreenCommand,omitempty"`
	WorkingDirectory    string            `json:"cwd,omitempty"`
	Env                 map[string]string `json:"env,omitempty"`
	TimeoutMS           int               `json:"timeoutMs,omitempty"`
}

type CustomModel struct {
	ID              string   `json:"id"`
	Provider        string   `json:"provider"`
	ModelID         string   `json:"modelId"`
	DisplayName     string   `json:"displayName,omitempty"`
	ContextWindow   int      `json:"contextWindow,omitempty"`
	InputModalities []string `json:"inputModalities,omitempty"`
	AddedAt         string   `json:"addedAt"`
}

type APIKeyEntry struct {
	ID      string `json:"id"`
	Key     string `json:"key"`
	Label   string `json:"label,omitempty"`
	AddedAt int64  `json:"addedAt,omitempty"`
}

type DebugConfig struct {
	Enabled      bool `json:"enabled,omitempty"`
	IncludeStack bool `json:"includeStack,omitempty"`
}

type LogConfig struct {
	Level      string `json:"level,omitempty"`
	File       string `json:"file,omitempty"`
	MaxSizeMB  int    `json:"maxSizeMB,omitempty"`
	MaxBackups int    `json:"maxBackups,omitempty"`
}

func Default() Config {
	return Config{
		Port: DefaultPort, Host: DefaultHost,
		Providers: make(map[string]ProviderConfig), Combos: make(map[string]combos.Combo),
		DefaultProvider: "openai", StreamMode: "auto",
	}
}

// FreshInstall is the user-visible TypeScript-compatible configuration written
// for a new installation. Default remains the minimal construction baseline
// used by internal callers that assemble providers explicitly.
func FreshInstall() Config {
	multiAgentGuidanceEnabled := true
	codexAutoStart := true
	codexShimAutoRestore := true
	return Config{
		Port: DefaultPort, Host: DefaultHost, OpenAIProviderTierVersion: providers.OpenAIProviderTierVersion,
		Providers: map[string]ProviderConfig{"openai": {Adapter: "openai-responses", BaseURL: "https://chatgpt.com/backend-api/codex", AuthMode: "forward", CodexAccountMode: "pool"}},
		Combos:    make(map[string]combos.Combo), DefaultProvider: "openai",
		SubagentModels:            []string{"gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"},
		MultiAgentGuidanceEnabled: &multiAgentGuidanceEnabled,
		CodexAutoStart:            &codexAutoStart,
		CodexShimAutoRestore:      &codexShimAutoRestore,
	}
}

func loadBaseline() Config {
	return Config{
		Port: DefaultPort, Host: DefaultHost,
		Providers: make(map[string]ProviderConfig), Combos: make(map[string]combos.Combo),
		DefaultProvider: "openai",
	}
}

// Load reads one complete file image, applies compatible defaults, and validates
// it. Environment references stay intact so a later Save never persists secrets.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})

	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	cfg := loadBaseline()
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, configDecodeError(err)
	}
	if object, ok := raw.(map[string]any); ok {
		_, cfg.WebSocketsSet = object["websockets"]
		if _, present := object["openaiProviderTierVersion"]; !present {
			cfg.OpenAIProviderTierVersion = 0
		}
	}
	if cfg.Providers == nil {
		cfg.Providers = make(map[string]ProviderConfig)
	}
	if cfg.Combos == nil {
		cfg.Combos = make(map[string]combos.Combo)
	}
	if cfg.StreamMode != "" && cfg.StreamMode != "auto" && cfg.StreamMode != "legacy-tee" && cfg.StreamMode != "eager-relay" {
		cfg.StreamMode = ""
	}
	validationErr := cfg.Validate()
	if validationErr == nil {
		validationErr = validateDefaultProvider(cfg)
	}
	if validationErr != nil {
		repaired := FreshInstall()
		if decodeErr := json.Unmarshal(data, &repaired); decodeErr != nil {
			return nil, fmt.Errorf("decode repaired config: %w", decodeErr)
		}
		if repaired.Providers == nil {
			repaired.Providers = make(map[string]ProviderConfig)
		}
		if repaired.Combos == nil {
			repaired.Combos = make(map[string]combos.Combo)
		}
		if repaired.StreamMode != "" && repaired.StreamMode != "auto" && repaired.StreamMode != "legacy-tee" && repaired.StreamMode != "eager-relay" {
			repaired.StreamMode = ""
		}
		if object, ok := raw.(map[string]any); ok {
			if _, present := object["openaiProviderTierVersion"]; !present {
				repaired.OpenAIProviderTierVersion = 0
			}
		}
		repairErr := repaired.Validate()
		if repairErr == nil {
			repairErr = validateDefaultProvider(repaired)
		}
		if repairErr != nil {
			return nil, validationErr
		}
		cfg = repaired
	}
	return &cfg, nil
}

// configDecodeError mirrors Zod's persisted-config diagnostics closely enough
// that CLI fallback warnings identify the user-facing JSON field and both the
// expected and received types. Keep syntax errors on the separate parse path.
func configDecodeError(err error) error {
	var typeErr *json.UnmarshalTypeError
	if !errors.As(err, &typeErr) {
		return fmt.Errorf("decode config: %w", err)
	}
	field := strings.TrimSpace(typeErr.Field)
	if field == "" {
		field = "config"
	}
	expected := typeErr.Type.Kind().String()
	switch expected {
	case "bool":
		expected = "boolean"
	case "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64":
		expected = "number"
	case "slice", "array":
		expected = "array"
	case "map", "struct":
		expected = "object"
	}
	received := typeErr.Value
	if strings.HasPrefix(received, "number ") {
		received = "number"
	}
	return fmt.Errorf("%s: Invalid input: expected %s, received %s", field, expected, received)
}

// Save writes JSON to a same-directory temporary file and atomically renames it
// over the destination. Configuration files are owner-readable and writable only.
func Save(path string, cfg *Config) error {
	if cfg == nil {
		return &ConfigError{Field: "config", Message: "must not be nil"}
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	data = append(data, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("protect temporary config: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync temporary config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	committed = true
	return nil
}

func (c Config) Validate() error {
	if c.Port < 0 || c.Port > 65535 {
		return &ConfigError{Field: "port", Message: "must be between 0 and 65535"}
	}
	if strings.TrimSpace(c.Host) == "" {
		return &ConfigError{Field: "hostname", Message: "must not be blank"}
	}
	if strings.TrimSpace(c.DefaultProvider) == "" {
		return &ConfigError{Field: "defaultProvider", Message: "must not be blank"}
	}
	switch c.StreamMode {
	case "", "auto", "legacy-tee", "eager-relay":
	default:
		return &ConfigError{Field: "streamMode", Message: "must be auto, legacy-tee, or eager-relay"}
	}
	if c.OpenAIProviderTierVersion != 0 && c.OpenAIProviderTierVersion != 1 && c.OpenAIProviderTierVersion != 2 {
		return &ConfigError{Field: "openaiProviderTierVersion", Message: "must be 1 or 2"}
	}
	if len(c.SubagentModels) > 5 {
		return &ConfigError{Field: "subagentModels", Message: "must contain at most 5 models"}
	}
	seenCustomIDs := make(map[string]bool, len(c.CustomModels))
	seenCustomSlugs := make(map[string]bool, len(c.CustomModels))
	for index, model := range c.CustomModels {
		field := fmt.Sprintf("customModels.%d", index)
		if strings.TrimSpace(model.ID) == "" || seenCustomIDs[model.ID] {
			return &ConfigError{Field: field + ".id", Message: "must be nonblank and unique"}
		}
		seenCustomIDs[model.ID] = true
		if !providerNamePattern.MatchString(model.Provider) {
			return &ConfigError{Field: field + ".provider", Message: "must be a valid provider name"}
		}
		if strings.TrimSpace(model.ModelID) == "" || strings.Contains(model.ModelID, "/") {
			return &ConfigError{Field: field + ".modelId", Message: "must be nonblank and must not contain /"}
		}
		slug := model.Provider + "/" + model.ModelID
		if seenCustomSlugs[slug] {
			return &ConfigError{Field: field + ".modelId", Message: "provider/modelId must be unique"}
		}
		seenCustomSlugs[slug] = true
		if strings.Contains(model.DisplayName, "/") {
			return &ConfigError{Field: field + ".displayName", Message: "must not contain /"}
		}
		if model.ContextWindow < 0 {
			return &ConfigError{Field: field + ".contextWindow", Message: "must be a positive integer"}
		}
		for _, modality := range model.InputModalities {
			if modality != "text" && modality != "image" && modality != "audio" {
				return &ConfigError{Field: field + ".inputModalities", Message: "values must be text, image, or audio"}
			}
		}
	}
	for index, model := range c.SubagentModels {
		if strings.TrimSpace(model) == "" {
			return &ConfigError{Field: fmt.Sprintf("subagentModels.%d", index), Message: "must not be blank"}
		}
	}
	for index, model := range c.SubagentModelFallback {
		if strings.TrimSpace(model) == "" {
			return &ConfigError{Field: fmt.Sprintf("subagentModelFallback.%d", index), Message: "must not be blank"}
		}
	}
	if c.SubagentModelFallbackPollMS < 0 {
		return &ConfigError{Field: "subagentModelFallbackPollMs", Message: "must not be negative"}
	}
	for field, effort := range map[string]string{"effortCap": c.EffortCap, "subagentEffortCap": c.SubagentEffortCap, "injectionEffort": c.InjectionEffort} {
		if effort != "" && !IsCodexReasoningEffort(effort) {
			return &ConfigError{Field: field, Message: "must be a supported Codex reasoning effort"}
		}
	}
	switch c.MultiAgentMode {
	case "", "default", "v1", "v2":
	default:
		return &ConfigError{Field: "multiAgentMode", Message: "must be default, v1, or v2"}
	}
	for provider, value := range c.ProviderContextCaps {
		if strings.TrimSpace(provider) == "" || value <= 0 {
			return &ConfigError{Field: "providerContextCaps." + provider, Message: "must be a positive integer"}
		}
	}
	for field, value := range map[string]int{
		"contextCapValue": c.ContextCapValue, "stallTimeoutSec": c.StallTimeoutSec,
		"connectTimeoutMs": c.ConnectTimeoutMS, "shutdownTimeoutMs": c.ShutdownTimeoutMS,
		"modelCacheTtlMs": c.ModelCacheTTLMS,
	} {
		if value < 0 {
			return &ConfigError{Field: field, Message: "must be a positive integer"}
		}
	}
	if c.AutoSwitchThreshold < 0 || c.AutoSwitchThreshold > 100 {
		return &ConfigError{Field: "autoSwitchThreshold", Message: "must be between 0 and 100"}
	}
	if c.UpstreamFailoverThreshold < 0 {
		return &ConfigError{Field: "upstreamFailoverThreshold", Message: "must not be negative"}
	}
	switch c.CacheRetention {
	case "", "none", "short", "long":
	default:
		return &ConfigError{Field: "cacheRetention", Message: "must be none, short, or long"}
	}
	if err := validateSidecars(c); err != nil {
		return err
	}
	if err := validateExtendedConfig(c); err != nil {
		return err
	}
	for name, provider := range c.Providers {
		reservedName := strings.ToLower(name)
		if !providerNamePattern.MatchString(name) || reservedName == "constructor" || reservedName == "prototype" || reservedName == "__proto__" {
			return &ConfigError{Field: "providers." + name, Message: "invalid provider name"}
		}
		if strings.TrimSpace(provider.Adapter) == "" {
			return &ConfigError{Field: "providers." + name + ".adapter", Message: "must not be blank"}
		}
		parsed, err := url.ParseRequestURI(strings.TrimSpace(provider.BaseURL))
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return &ConfigError{Field: "providers." + name + ".baseUrl", Message: "must be an http(s) URL"}
		}
		if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return &ConfigError{Field: "providers." + name + ".baseUrl", Message: "must not contain credentials, query, or fragment"}
		}
		if path := provider.ResponsesPath; path != "" {
			if responsePathSchemePattern.MatchString(path) || strings.Contains(path, "://") {
				return &ConfigError{Field: "providers." + name + ".responsesPath", Message: "must be a relative path without a URL scheme"}
			}
			if !strings.HasPrefix(path, "/") {
				return &ConfigError{Field: "providers." + name + ".responsesPath", Message: "must start with /"}
			}
			if strings.ContainsAny(path, "?#") {
				return &ConfigError{Field: "providers." + name + ".responsesPath", Message: "must not include query strings or fragments"}
			}
		}
		for header, value := range provider.Headers {
			normalized := strings.ToLower(strings.TrimSpace(header))
			if normalized == "" || !headerNamePattern.MatchString(header) {
				return &ConfigError{Field: "providers." + name + ".headers", Message: "must use valid HTTP header names"}
			}
			if sensitiveProviderHeaders[normalized] {
				return &ConfigError{Field: "providers." + name + ".headers." + header, Message: "sensitive authentication headers must use apiKey/authMode instead"}
			}
			if strings.ContainsAny(value, "\r\n") {
				return &ConfigError{Field: "providers." + name + ".headers." + header, Message: "value must not include line breaks"}
			}
		}
		if provider.DefaultMaxOutputTokens < 0 {
			return &ConfigError{Field: "providers." + name + ".defaultMaxOutputTokens", Message: "must be a positive integer"}
		}
		for model := range provider.ModelSupportsReasoningSummaries {
			if strings.TrimSpace(model) == "" {
				return &ConfigError{Field: "providers." + name + ".modelSupportsReasoningSummaries", Message: "keys must be nonblank model ids"}
			}
		}
		if repair := provider.ResponsesItemIDRepair; repair != nil {
			for field, values := range map[string][]string{"message": repair.Message, "reasoning": repair.Reasoning} {
				for _, value := range values {
					if strings.TrimSpace(value) == "" {
						return &ConfigError{Field: "providers." + name + ".responsesItemIdRepair." + field, Message: "values must not be blank"}
					}
				}
			}
		}
		if err := providers.OpenRouterRoutingConfigError(providers.ProviderConfig{
			Adapter: provider.Adapter, BaseURL: provider.BaseURL,
			OpenRouterRouting: provider.OpenRouterRouting, ModelOpenRouterRouting: provider.ModelOpenRouterRouting,
		}); err != nil {
			return &ConfigError{Field: "providers." + name + ".openRouterRouting", Message: err.Error()}
		}
		seenKeyIDs := make(map[string]bool, len(provider.APIKeyPool))
		for index, entry := range provider.APIKeyPool {
			field := fmt.Sprintf("providers.%s.apiKeyPool.%d", name, index)
			if strings.TrimSpace(entry.ID) == "" || seenKeyIDs[entry.ID] {
				return &ConfigError{Field: field + ".id", Message: "must be nonblank and unique"}
			}
			seenKeyIDs[entry.ID] = true
			if strings.TrimSpace(entry.Key) == "" || strings.ContainsAny(entry.Key, "\r\n") {
				return &ConfigError{Field: field + ".key", Message: "must be nonblank and contain no line breaks"}
			}
		}
		for field, values := range map[string]map[string]int{
			"modelContextWindows":  provider.ModelContextWindows,
			"modelMaxInputTokens":  provider.ModelMaxInputTokens,
			"modelMaxOutputTokens": provider.ModelMaxOutputTokens,
		} {
			for model, value := range values {
				if strings.TrimSpace(model) == "" {
					return &ConfigError{Field: "providers." + name + "." + field, Message: "keys must be nonblank model ids"}
				}
				if value <= 0 {
					return &ConfigError{Field: "providers." + name + "." + field + "." + model, Message: "must be a positive integer"}
				}
			}
		}
		if provider.CodexAccountMode != "" {
			canonical := name == providers.OpenAICodexProviderID && provider.Adapter == "openai-responses" && provider.AuthMode == "forward" && strings.TrimRight(provider.BaseURL, "/") == "https://chatgpt.com/backend-api/codex"
			if (provider.CodexAccountMode != "pool" && provider.CodexAccountMode != "direct") || !canonical {
				return &ConfigError{Field: "providers." + name + ".codexAccountMode", Message: "is valid only on the canonical built-in openai provider"}
			}
		}
		switch provider.RefreshPolicy {
		case "", "proactive", "lazy-only", "disabled":
		default:
			return &ConfigError{Field: "providers." + name + ".refreshPolicy", Message: "must be proactive, lazy-only, or disabled"}
		}
		switch provider.NativeLocalExec {
		case "", "off", "codex-sandbox", "on":
		default:
			return &ConfigError{Field: "providers." + name + ".nativeLocalExec", Message: "must be off, codex-sandbox, or on"}
		}
		for serverName, mcp := range provider.MCPServers {
			field := "providers." + name + ".mcpServers." + serverName
			if strings.TrimSpace(serverName) == "" {
				return &ConfigError{Field: "providers." + name + ".mcpServers", Message: "server names must not be blank"}
			}
			if mcp.Enabled != nil && !*mcp.Enabled {
				continue
			}
			if (strings.TrimSpace(mcp.Command) == "") == (strings.TrimSpace(mcp.URL) == "") {
				return &ConfigError{Field: field, Message: "must configure exactly one of command or url"}
			}
			if mcp.URL != "" {
				parsed, err := url.ParseRequestURI(mcp.URL)
				if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
					return &ConfigError{Field: field + ".url", Message: "must be an http(s) URL"}
				}
			}
			for key, value := range mcp.Env {
				if strings.TrimSpace(key) == "" || strings.ContainsAny(key+value, "\x00\r\n") {
					return &ConfigError{Field: field + ".env", Message: "must not contain blank names, NUL, or line breaks"}
				}
			}
		}
		if provider.DesktopExecutor != nil && provider.DesktopExecutor.TimeoutMS < 0 {
			return &ConfigError{Field: "providers." + name + ".desktopExecutor.timeoutMs", Message: "must not be negative"}
		}
		if desktop := provider.DesktopExecutor; desktop != nil {
			for key, value := range desktop.Env {
				if strings.TrimSpace(key) == "" || strings.ContainsAny(key+value, "\x00\r\n") {
					return &ConfigError{Field: "providers." + name + ".desktopExecutor.env", Message: "must not contain blank names, NUL, or line breaks"}
				}
			}
		}
		if err := ValidateModelAdapters(name, provider); err != nil {
			return err
		}
	}
	for id, combo := range c.Combos {
		if err := combos.ValidateBasic(id, combo); err != nil {
			return &ConfigError{Field: "combos." + id, Message: err.Error()}
		}
	}
	return nil
}

func validateDefaultProvider(c Config) error {
	if _, exists := c.Providers[c.DefaultProvider]; !exists {
		return &ConfigError{Field: "defaultProvider", Message: "must name a configured provider"}
	}
	return nil
}

func validateExtendedConfig(c Config) error {
	seenAPIKeys := make(map[string]bool, len(c.APIKeys))
	for index, key := range c.APIKeys {
		field := fmt.Sprintf("apiKeys.%d", index)
		if strings.TrimSpace(key.ID) == "" || seenAPIKeys[key.ID] {
			return &ConfigError{Field: field + ".id", Message: "must be nonblank and unique"}
		}
		seenAPIKeys[key.ID] = true
		if strings.TrimSpace(key.Name) == "" {
			return &ConfigError{Field: field + ".name", Message: "must not be blank"}
		}
		if strings.TrimSpace(key.Key) == "" || strings.ContainsAny(key.Key, "\r\n") {
			return &ConfigError{Field: field + ".key", Message: "must be nonblank and contain no line breaks"}
		}
	}
	seenAccounts := make(map[string]bool, len(c.CodexAccounts))
	for index, account := range c.CodexAccounts {
		field := fmt.Sprintf("codexAccounts.%d", index)
		if strings.TrimSpace(account.ID) == "" || seenAccounts[account.ID] {
			return &ConfigError{Field: field + ".id", Message: "must be nonblank and unique"}
		}
		seenAccounts[account.ID] = true
		if strings.TrimSpace(account.Email) == "" {
			return &ConfigError{Field: field + ".email", Message: "must not be blank"}
		}
	}
	if c.ActiveCodexAccountID != "" && !seenAccounts[c.ActiveCodexAccountID] {
		return &ConfigError{Field: "activeCodexAccountId", Message: "must name a configured Codex account"}
	}
	if guardian := c.TokenGuardian; guardian != nil {
		if guardian.TickSeconds != 0 && guardian.TickSeconds < 60 {
			return &ConfigError{Field: "tokenGuardian.tickSeconds", Message: "must be at least 60"}
		}
		for field, value := range map[string]int{
			"jitterSeconds": guardian.JitterSeconds, "leadSeconds": guardian.LeadSeconds,
			"failureBackoffBaseSeconds": guardian.FailureBackoffBaseSeconds,
			"failureBackoffMaxSeconds":  guardian.FailureBackoffMaxSeconds,
			"codexWarmupMaxAgeSeconds":  guardian.CodexWarmupMaxAgeSeconds,
		} {
			if value < 0 {
				return &ConfigError{Field: "tokenGuardian." + field, Message: "must not be negative"}
			}
		}
		if guardian.Concurrency < 0 {
			return &ConfigError{Field: "tokenGuardian.concurrency", Message: "must be positive"}
		}
	}
	return nil
}

func validateSidecars(c Config) error {
	if c.Images != nil && c.Images.TimeoutMS < 0 {
		return &ConfigError{Field: "images.timeoutMs", Message: "must be a positive integer"}
	}
	if c.Search != nil && c.Search.TimeoutMS < 0 {
		return &ConfigError{Field: "search.timeoutMs", Message: "must be a positive integer"}
	}
	if sidecar := c.VisionSidecar; sidecar != nil {
		if sidecar.Backend != "" && sidecar.Backend != "openai" && sidecar.Backend != "anthropic" {
			return &ConfigError{Field: "visionSidecar.backend", Message: "must be openai or anthropic"}
		}
		if sidecar.MaxDescriptionsPerTurn < 0 || sidecar.TimeoutMS < 0 {
			return &ConfigError{Field: "visionSidecar", Message: "numeric limits must not be negative"}
		}
	}
	if sidecar := c.WebSearchSidecar; sidecar != nil {
		if sidecar.Backend != "" && sidecar.Backend != "openai" && sidecar.Backend != "anthropic" {
			return &ConfigError{Field: "webSearchSidecar.backend", Message: "must be openai or anthropic"}
		}
		if sidecar.MaxSearchesPerTurn < 0 || sidecar.TimeoutMS < 0 || sidecar.RoutedModelStallTimeoutMS < 0 {
			return &ConfigError{Field: "webSearchSidecar", Message: "numeric limits must not be negative"}
		}
	}
	return nil
}

func expandValue(value any) any {
	switch v := value.(type) {
	case string:
		return os.ExpandEnv(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = expandValue(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = expandValue(item)
		}
		return out
	default:
		return value
	}
}

type ConfigError struct {
	Field   string
	Message string
}

func (e *ConfigError) Error() string {
	if e == nil {
		return "invalid configuration"
	}
	return fmt.Sprintf("invalid configuration %s: %s", e.Field, e.Message)
}

func IsConfigError(err error) bool {
	var target *ConfigError
	return errors.As(err, &target)
}

// ValidateModelAdapters validates a provider's per-model wire override map (#404).
// It rejects configurations the resolver would refuse: a value outside the allowed
// wires, a model the upstream pins to one wire, and any override on a canonical
// forward provider (where switching wires would drop the caller's forwarded credential).
func ValidateModelAdapters(providerName string, provider ProviderConfig) error {
	if len(provider.ModelAdapters) == 0 {
		return nil
	}
	if providers.IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL) {
		return &ConfigError{
			Field:   "providers." + providerName + ".modelAdapters",
			Message: "modelAdapters is not supported on the canonical ChatGPT forward provider",
		}
	}
	for modelID, wire := range provider.ModelAdapters {
		if strings.TrimSpace(modelID) == "" {
			return &ConfigError{
				Field:   "providers." + providerName + ".modelAdapters",
				Message: "modelAdapters keys must be nonblank model ids",
			}
		}
		if !types.ModelAdapterOverrideAllowed[wire] {
			return &ConfigError{
				Field:   "providers." + providerName + ".modelAdapters." + modelID,
				Message: fmt.Sprintf("must be one of: openai-chat, openai-responses; got %q", wire),
			}
		}
		if types.IsWirePinnedModel(providerName, strings.TrimSpace(modelID)) {
			return &ConfigError{
				Field:   "providers." + providerName + ".modelAdapters." + modelID,
				Message: "cannot be overridden: the upstream only speaks one wire for this model",
			}
		}
	}
	return nil
}
