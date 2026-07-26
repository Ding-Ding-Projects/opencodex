package management

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

const maxManagementBody = 2 << 20

type ModelFetcher func(r *http.Request, provider string, providerConfig config.ProviderConfig) ([]types.ModelEntry, error)

type CustomModel = config.CustomModel
type ComboTarget struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort,omitempty"`
}
type Combo struct {
	ID       string        `json:"id"`
	Strategy string        `json:"strategy"`
	Alias    string        `json:"alias,omitempty"`
	Targets  []ComboTarget `json:"targets"`
}
type AgentSettings struct {
	Models            []string `json:"models"`
	InjectionModel    string   `json:"injectionModel,omitempty"`
	InjectionEffort   string   `json:"injectionEffort,omitempty"`
	EffortCap         string   `json:"effortCap,omitempty"`
	SubagentEffortCap string   `json:"subagentEffortCap,omitempty"`
	MaxConcurrency    int      `json:"maxConcurrency"`
	MultiAgentMode    string   `json:"multiAgentMode"`
	InjectionPrompt   string   `json:"injectionPrompt,omitempty"`
	GuidanceEnabled   *bool    `json:"multiAgentGuidanceEnabled,omitempty"`
}

type orderedJSONField struct {
	name  string
	value any
}
type orderedJSONObject []orderedJSONField

func (object orderedJSONObject) MarshalJSON() ([]byte, error) {
	var output bytes.Buffer
	output.WriteByte('{')
	for index, field := range object {
		if index > 0 {
			output.WriteByte(',')
		}
		name, _ := json.Marshal(field.name)
		value, err := json.Marshal(field.value)
		if err != nil {
			return nil, err
		}
		output.Write(name)
		output.WriteByte(':')
		output.Write(value)
	}
	output.WriteByte('}')
	return output.Bytes(), nil
}

func orderedFromMap(source map[string]any, order []string) orderedJSONObject {
	result := make(orderedJSONObject, 0, len(source))
	for _, key := range order {
		if value, ok := source[key]; ok {
			result = append(result, orderedJSONField{name: key, value: value})
		}
	}
	return result
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		payload = []byte(`{"error":"JSON serialization failed"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxManagementBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "request body must contain one JSON value")
		return false
	}
	return true
}

func publicProvider(name string, provider config.ProviderConfig) map[string]any {
	models := append([]string(nil), provider.Models...)
	if models == nil {
		models = []string{}
	}
	row := map[string]any{"name": name, "adapter": provider.Adapter, "baseUrl": publicProviderBaseURL(provider.BaseURL), "defaultModel": provider.DefaultModel, "hasApiKey": provider.APIKey != "", "allowPrivateNetwork": provider.AllowPrivateNetwork, "liveModels": provider.LiveModels == nil || *provider.LiveModels, "models": models, "authMode": provider.AuthMode, "disabled": provider.Disabled}
	if provider.CodexAccountMode != "" {
		row["codexAccountMode"] = provider.CodexAccountMode
	}
	return row
}

func publicProviderBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "(invalid URL)"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	value := parsed.String()
	if !strings.HasSuffix(trimmed, "/") {
		value = strings.TrimSuffix(value, "/")
	}
	return value
}

func safeConfig(value *config.Config) any {
	names := make([]string, 0, len(value.Providers))
	for name := range value.Providers {
		names = append(names, name)
	}
	sort.Strings(names)
	providers := make(orderedJSONObject, 0, len(names))
	for _, name := range names {
		provider := value.Providers[name]
		dto := map[string]any{
			"adapter": provider.Adapter, "baseUrl": publicProviderBaseURL(provider.BaseURL),
			"hasApiKey": provider.APIKey != "", "hasHeaders": len(provider.Headers) > 0,
		}
		copyString := func(key, current string) {
			if current != "" {
				dto[key] = current
			}
		}
		copyString("defaultModel", provider.DefaultModel)
		copyString("authMode", provider.AuthMode)
		copyString("codexAccountMode", provider.CodexAccountMode)
		if provider.Disabled {
			dto["disabled"] = true
		}
		if provider.AllowPrivateNetwork {
			dto["allowPrivateNetwork"] = true
		}
		if provider.KeyOptional != nil {
			dto["keyOptional"] = *provider.KeyOptional
		}
		if provider.LiveModels != nil {
			dto["liveModels"] = *provider.LiveModels
		}
		if provider.Models != nil {
			dto["models"] = append([]string(nil), provider.Models...)
		}
		if provider.ContextWindow != 0 {
			dto["contextWindow"] = provider.ContextWindow
		}
		if provider.DefaultMaxOutputTokens != 0 {
			dto["defaultMaxOutputTokens"] = provider.DefaultMaxOutputTokens
		}
		providers = append(providers, orderedJSONField{name: name, value: orderedFromMap(dto, []string{
			"adapter", "baseUrl", "hasApiKey", "hasHeaders", "defaultModel", "disabled", "allowPrivateNetwork", "authMode", "keyOptional", "freeTier", "liveModels", "models", "contextWindow", "modelContextWindows", "defaultMaxOutputTokens", "modelMaxOutputTokens", "openRouterRouting", "modelOpenRouterRouting", "reasoningEfforts", "modelReasoningEfforts", "noVisionModels", "noReasoningModels", "noTemperatureModels", "noTopPModels", "noPenaltyModels", "autoToolChoiceOnlyModels", "preserveReasoningContentModels", "escapeBuiltinToolNames", "note", "codexAccountMode",
		})})
	}
	result := orderedJSONObject{
		{name: "port", value: value.Port}, {name: "hostname", value: value.Host},
		{name: "defaultProvider", value: value.DefaultProvider}, {name: "codexAutoStart", value: codexAutoStart(value.CodexAutoStart)},
	}
	if value.WebSockets {
		result = append(result, orderedJSONField{name: "websockets", value: true})
	}
	return append(result, orderedJSONField{name: "providers", value: providers})
}

func validateIdentifier(value, field string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "/\\\x00") {
		return fmt.Errorf("%s is invalid", field)
	}
	return nil
}
func queryRequired(values url.Values, key string) (string, error) {
	value := strings.TrimSpace(values.Get(key))
	if err := validateIdentifier(value, key); err != nil {
		return "", err
	}
	return value, nil
}

func metricDTO(entry RequestLogEntry) map[string]any {
	result := map[string]any{"requestId": entry.RequestID, "timestamp": entry.Timestamp, "provider": entry.Provider, "model": entry.Model, "status": entry.Status, "durationMs": entry.DurationMS, "usageStatus": entry.UsageStatus, "usage": entry.Usage}
	metrics := map[string]any{}
	if entry.Usage != nil {
		if speed, ok := usage.TokensPerSecond(entry.Usage.OutputTokens, entry.DurationMS); ok {
			metrics["tokPerSecond"] = map[string]any{"kind": "value", "value": speed, "estimated": entry.Usage.Estimated}
		} else {
			metrics["tokPerSecond"] = map[string]any{"kind": "unavailable", "reason": "output_missing"}
		}
		if estimate, ok := usage.EstimateCost(entry.Provider, entry.Model, *entry.Usage, entry.UsageStatus, nil); ok {
			metrics["cost"] = map[string]any{"kind": "value", "estimate": estimate}
		} else {
			metrics["cost"] = map[string]any{"kind": "unavailable", "reason": "price_unmatched"}
		}
	} else {
		metrics["tokPerSecond"] = map[string]any{"kind": "unavailable", "reason": "usage_missing"}
		metrics["cost"] = map[string]any{"kind": "unavailable", "reason": "usage_missing"}
	}
	result["displayMetrics"] = metrics
	return result
}
