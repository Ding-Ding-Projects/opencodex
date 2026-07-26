package types

import (
	"encoding/json"
	"time"
)

type NormalizedRequest struct {
	ModelID            string                    `json:"modelId"`
	PreviousResponseID string                    `json:"previousResponseId,omitempty"`
	Context            RequestContext            `json:"context"`
	Stream             bool                      `json:"stream"`
	Options            RequestOptions            `json:"options"`
	RawBody            json.RawMessage           `json:"-"`
	Metadata           map[string]string         `json:"metadata,omitempty"`
	ReplayPrefixLen    int                       `json:"-"`
	PreviousExpanded   bool                      `json:"-"`
	ClientThreadID     string                    `json:"-"`
	CursorConversation string                    `json:"-"`
	CursorIdentity     string                    `json:"-"`
	IsolateCursor      bool                      `json:"-"`
	StructuredOutput   bool                      `json:"-"`
	CompactionRequest  bool                      `json:"-"`
	CompactionBoundary bool                      `json:"-"`
	ProviderState      ProviderContinuationState `json:"-"`
	WebSearch          map[string]any            `json:"-"`
}

type RequestContext struct {
	SystemPrompt []string  `json:"systemPrompt,omitempty"`
	Messages     []Message `json:"messages"`
	Tools        []Tool    `json:"tools,omitempty"`
}

type Message struct {
	Role                     string          `json:"role"`
	Content                  json.RawMessage `json:"content"`
	ToolCallID               string          `json:"toolCallId,omitempty"`
	ToolName                 string          `json:"toolName,omitempty"`
	IsError                  bool            `json:"isError,omitempty"`
	Timestamp                int64           `json:"timestamp,omitempty"`
	Phase                    string          `json:"phase,omitempty"`
	Model                    string          `json:"model,omitempty"`
	ToolNamespace            string          `json:"toolNamespace,omitempty"`
	ContainsEncryptedContent bool            `json:"containsEncryptedContent,omitempty"`
}

type Tool struct {
	Name                 string         `json:"name"`
	Description          string         `json:"description,omitempty"`
	Parameters           map[string]any `json:"parameters,omitempty"`
	Strict               bool           `json:"strict,omitempty"`
	Namespace            string         `json:"namespace,omitempty"`
	Freeform             bool           `json:"freeform,omitempty"`
	ToolSearch           bool           `json:"toolSearch,omitempty"`
	LoadedFromToolSearch bool           `json:"loadedFromToolSearch,omitempty"`
	WebSearch            bool           `json:"webSearch,omitempty"`
}

type RequestOptions struct {
	MaxOutputTokens     int             `json:"maxOutputTokens,omitempty"`
	Temperature         *float64        `json:"temperature,omitempty"`
	TopP                *float64        `json:"topP,omitempty"`
	StopSequences       []string        `json:"stopSequences,omitempty"`
	ToolChoice          json.RawMessage `json:"toolChoice,omitempty"`
	ParallelToolCalls   *bool           `json:"parallelToolCalls,omitempty"`
	Reasoning           string          `json:"reasoning,omitempty"`
	ServiceTier         string          `json:"serviceTier,omitempty"`
	HideThinkingSummary bool            `json:"hideThinkingSummary,omitempty"`
	PresencePenalty     *float64        `json:"presencePenalty,omitempty"`
	FrequencyPenalty    *float64        `json:"frequencyPenalty,omitempty"`
	PromptCacheKey      string          `json:"promptCacheKey,omitempty"`
	User                string          `json:"user,omitempty"`
	ResponseText        json.RawMessage `json:"responseText,omitempty"`
	RequestMetadata     json.RawMessage `json:"requestMetadata,omitempty"`
}

type AdapterEventType string

const (
	EventTextDelta AdapterEventType = "text_delta"
	EventToolCall  AdapterEventType = "tool_call"
	EventReasoning AdapterEventType = "reasoning"
	EventUsage     AdapterEventType = "usage"
	EventError     AdapterEventType = "error"
	EventDone      AdapterEventType = "done"
	// EventHeartbeat is a liveness signal with no payload (TS src/types.ts:237).
	// Consumers must treat it as activity only and never emit it downstream.
	EventHeartbeat AdapterEventType = "heartbeat"
	// EventIncomplete ends a turn early for a structured reason
	// (TS src/types.ts:264). Terminal like done/error.
	EventIncomplete AdapterEventType = "incomplete"
	// EventAssistantBoundary is an internal boundary between a guarded first
	// pass and its one-shot continuation (TS src/types.ts:249). Emitted by
	// the terminal guard when it withholds a suspicious no-tool terminal and
	// starts a continuation request.
	EventAssistantBoundary  AdapterEventType = "assistant_boundary"
	EventThinkingDelta      AdapterEventType = "thinking_delta"
	EventThinkingSignature  AdapterEventType = "thinking_signature"
	EventRedactedThinking   AdapterEventType = "redacted_thinking"
	EventReasoningRawDelta  AdapterEventType = "reasoning_raw_delta"
	EventToolCallStart      AdapterEventType = "tool_call_start"
	EventToolCallDelta      AdapterEventType = "tool_call_delta"
	EventToolCallEnd        AdapterEventType = "tool_call_end"
	EventWebSearchCallBegin AdapterEventType = "web_search_call_begin"
	EventWebSearchCallEnd   AdapterEventType = "web_search_call_end"
)

type AdapterEvent struct {
	Type       AdapterEventType `json:"type"`
	Text       string           `json:"text,omitempty"`
	Phase      string           `json:"phase,omitempty"`
	Reasoning  string           `json:"reasoning,omitempty"`
	ToolCall   *ToolCall        `json:"toolCall,omitempty"`
	Usage      *Usage           `json:"usage,omitempty"`
	Error      string           `json:"error,omitempty"`
	StatusCode int              `json:"statusCode,omitempty"`
	Retryable  bool             `json:"retryable,omitempty"`
	StopReason string           `json:"stopReason,omitempty"`
	// Reason/Message carry EventIncomplete details
	// (e.g. "max_output_tokens", "content_filter", "adapter_eof",
	// "upstream_stall_timeout").
	Reason          string                    `json:"reason,omitempty"`
	Message         string                    `json:"message,omitempty"`
	Signature       string                    `json:"signature,omitempty"`
	Data            string                    `json:"data,omitempty"`
	ID              string                    `json:"id,omitempty"`
	Name            string                    `json:"name,omitempty"`
	Arguments       string                    `json:"arguments,omitempty"`
	Queries         []string                  `json:"queries,omitempty"`
	Sources         []URLCitation             `json:"sources,omitempty"`
	WebSearchStatus string                    `json:"webSearchStatus,omitempty"`
	ErrorType       string                    `json:"errorType,omitempty"`
	Code            string                    `json:"code,omitempty"`
	EndTurn         bool                      `json:"endTurn,omitempty"`
	ProviderState   ProviderContinuationState `json:"providerState,omitempty"`
}

type ToolCall struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Arguments        json.RawMessage `json:"arguments"`
	CustomWireName   string          `json:"customWireName,omitempty"`
	ThoughtSignature string          `json:"thoughtSignature,omitempty"`
	Namespace        string          `json:"namespace,omitempty"`
}

type URLCitation struct {
	URL   string `json:"url"`
	Title string `json:"title,omitempty"`
}

type ProviderContinuationState map[string]map[string]any

type Usage struct {
	InputTokens              int  `json:"inputTokens"`
	OutputTokens             int  `json:"outputTokens"`
	TotalTokens              int  `json:"totalTokens,omitempty"`
	ContextTotalTokens       int  `json:"contextTotalTokens,omitempty"`
	CachedInputTokens        int  `json:"cachedInputTokens,omitempty"`
	CacheReadInputTokens     int  `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int  `json:"cacheCreationInputTokens,omitempty"`
	ReasoningOutputTokens    int  `json:"reasoningOutputTokens,omitempty"`
	Estimated                bool `json:"estimated,omitempty"`
}

type AuthContext struct {
	Kind             string            `json:"kind"`
	Provider         string            `json:"provider"`
	AccountID        string            `json:"accountId,omitempty"`
	Generation       int64             `json:"generation,omitempty"`
	AccessToken      string            `json:"-"`
	APIKey           string            `json:"-"`
	ChatGPTAccountID string            `json:"chatgptAccountId,omitempty"`
	Headers          map[string]string `json:"-"`
}

type ResolvedModel struct {
	Selector string `json:"selector"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort,omitempty"`
}

type Transport struct {
	BaseURL string            `json:"baseUrl"`
	Headers map[string]string `json:"headers,omitempty"`
}

type UsageRecord struct {
	RequestID string        `json:"requestId"`
	ThreadID  string        `json:"threadId,omitempty"`
	Provider  string        `json:"provider"`
	Model     string        `json:"model"`
	Surface   string        `json:"surface,omitempty"`
	AccountID string        `json:"accountId,omitempty"`
	Usage     Usage         `json:"usage"`
	Status    OutcomeStatus `json:"status"`
	StartedAt time.Time     `json:"startedAt"`
	Duration  time.Duration `json:"duration"`
}

type OutcomeStatus string

const (
	OutcomeSuccess       OutcomeStatus = "success"
	OutcomeAuthError     OutcomeStatus = "auth_error"
	OutcomeRateLimited   OutcomeStatus = "rate_limited"
	OutcomeProviderError OutcomeStatus = "provider_error"
	OutcomeCancelled     OutcomeStatus = "cancelled"
)

type RetryMeta struct {
	Attempt      int           `json:"attempt"`
	MaxAttempts  int           `json:"maxAttempts,omitempty"`
	RetryAfter   time.Duration `json:"retryAfter,omitempty"`
	StatusCode   int           `json:"statusCode,omitempty"`
	ProviderCode string        `json:"providerCode,omitempty"`
	Message      string        `json:"message,omitempty"`
}

type CompactionRequest struct {
	Model    string            `json:"model"`
	Input    []json.RawMessage `json:"input"`
	ThreadID string            `json:"threadId,omitempty"`
}

type CompactionResult struct {
	Summary          string            `json:"summary"`
	EncryptedContent string            `json:"encryptedContent,omitempty"`
	Output           []json.RawMessage `json:"output,omitempty"`
	Usage            *Usage            `json:"usage,omitempty"`
}

type ChatResponse struct {
	ID      string       `json:"id"`
	Object  string       `json:"object"`
	Created int64        `json:"created"`
	Model   string       `json:"model"`
	Choices []ChatChoice `json:"choices"`
	Usage   *ChatUsage   `json:"usage,omitempty"`
}

type ChatChoice struct {
	Index        int         `json:"index"`
	Message      ChatMessage `json:"message"`
	FinishReason string      `json:"finish_reason,omitempty"`
}

type ChatMessage struct {
	Role      string     `json:"role"`
	Content   string     `json:"content,omitempty"`
	Reasoning string     `json:"reasoning_content,omitempty"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
}

type ChatUsage struct {
	PromptTokens            int                     `json:"prompt_tokens"`
	CompletionTokens        int                     `json:"completion_tokens"`
	TotalTokens             int                     `json:"total_tokens"`
	PromptTokensDetails     PromptTokensDetails     `json:"prompt_tokens_details"`
	CompletionTokensDetails CompletionTokensDetails `json:"completion_tokens_details"`
}

type PromptTokensDetails struct {
	CachedTokens int `json:"cached_tokens"`
}

type CompletionTokensDetails struct {
	ReasoningTokens int `json:"reasoning_tokens"`
}

type ModelEntry struct {
	ID               string   `json:"id"`
	Provider         string   `json:"provider"`
	DisplayName      string   `json:"displayName,omitempty"`
	ReasoningEfforts []string `json:"reasoningEfforts,omitempty"`
	ContextWindow    int      `json:"contextWindow,omitempty"`
}

type ResolvedCombo struct {
	ID            string            `json:"id"`
	Strategy      string            `json:"strategy"`
	Targets       []ResolvedModel   `json:"targets"`
	DefaultEffort string            `json:"defaultEffort,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

// ModelAdapterOverrideAllowed is the set of wires that a per-model modelAdapters
// override may select. Deliberately narrow: provider-specific adapters carry their
// own credential and base-URL semantics (TS src/types.ts MODEL_ADAPTER_OVERRIDE_ALLOWED, #404).
var ModelAdapterOverrideAllowed = map[string]bool{
	"openai-chat":      true,
	"openai-responses": true,
}

// anthropicWireModels lists providers whose model ids must be driven over the
// Anthropic wire regardless of the configured adapter (TS src/types.ts, #404).
var anthropicWireModels = map[string]map[string]bool{
	"opencode-go": {
		"minimax-m2.5": true,
		"minimax-m2.7": true,
		"minimax-m3":   true,
	},
}

// IsWirePinnedModel reports whether the upstream speaks exactly one wire for
// this model, so a configured override must not apply. Deliberately independent
// of the provider's current adapter (TS src/types.ts isWirePinnedModel, #404).
func IsWirePinnedModel(providerName, modelID string) bool {
	models, ok := anthropicWireModels[providerName]
	if !ok {
		return false
	}
	return models[modelID]
}

// PinnedWireAdapter returns the wire a pinned model must use, or empty string
// when the model is not pinned (TS src/types.ts pinnedWireAdapter, #404).
func PinnedWireAdapter(providerName, modelID string) string {
	if IsWirePinnedModel(providerName, modelID) {
		return "anthropic"
	}
	return ""
}
