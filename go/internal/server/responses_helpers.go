package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

var DefaultShadowSourceModels = []string{"gpt-5.4-mini", "gpt-5.6-luna"}

type ShadowCallIntercept struct {
	Enabled      bool
	Model        string
	SourceModels []string
}

func AdapterNeedsForcedContinuation(name string) bool {
	return name == "kiro" || name == "cursor"
}

func IsShadowSourceModel(modelID string, configured []string) bool {
	if strings.Contains(modelID, "/") {
		return false
	}
	prefixes := configured
	if len(prefixes) == 0 {
		prefixes = DefaultShadowSourceModels
	}
	for _, prefix := range prefixes {
		prefix = strings.TrimSpace(prefix)
		if prefix != "" && strings.HasPrefix(modelID, prefix) {
			return true
		}
	}
	return false
}

// ApplyShadowCallIntercept reroutes Codex helper/shadow requests and isolates
// them from provider continuation state inherited from the parent turn.
func ApplyShadowCallIntercept(request *types.NormalizedRequest, config *ShadowCallIntercept) bool {
	if request == nil || config == nil || !config.Enabled || strings.TrimSpace(config.Model) == "" || !IsShadowSourceModel(request.ModelID, config.SourceModels) {
		return false
	}
	applyResolvedResponsesModel(request, strings.TrimSpace(config.Model))
	request.Options.Reasoning = "low"
	request.IsolateCursor = true
	request.ProviderState = nil
	var body map[string]any
	if json.Unmarshal(request.RawBody, &body) == nil {
		body["reasoning"] = map[string]any{"effort": "low"}
		delete(body, "previous_response_id")
		if updated, err := json.Marshal(body); err == nil {
			request.RawBody = updated
		}
	}
	request.PreviousResponseID = ""
	return true
}

// SanitizedRetryAfter accepts only bounded RFC-compatible values suitable for
// forwarding to clients and combo cooldown classification.
func SanitizedRetryAfter(value string, now time.Time) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > 128 {
		return "", false
	}
	if _, ok := combos.ParseRetryAfter(trimmed, now); !ok {
		return "", false
	}
	return trimmed, true
}

func UsageFromComboFailureText(text string) *types.Usage {
	var payload map[string]any
	if json.Unmarshal([]byte(text), &payload) != nil {
		return nil
	}
	if nested, ok := payload["response"].(map[string]any); ok {
		payload = nested
	}
	return UsageFromResponsesPayload(payload["usage"])
}

func BuildComboChildHeaders(parent http.Header) http.Header {
	child := parent.Clone()
	child.Del("Content-Length")
	child.Del("Content-Encoding")
	return child
}

// ChildPassthroughCallbackGate delays side effects until a speculative combo
// child is committed. A discarded child can no longer publish terminal or
// cancellation callbacks.
type ChildPassthroughCallbackGate struct {
	mu         sync.Mutex
	state      string
	accepted   bool
	pending    func()
	onTerminal func(ResponsesTerminalStatus)
	onCancel   func()
}

func NewChildPassthroughCallbackGate(onTerminal func(ResponsesTerminalStatus), onCancel func()) *ChildPassthroughCallbackGate {
	return &ChildPassthroughCallbackGate{state: "pending", onTerminal: onTerminal, onCancel: onCancel}
}

func (gate *ChildPassthroughCallbackGate) Terminal(status ResponsesTerminalStatus) {
	gate.receive(func() {
		if gate.onTerminal != nil {
			gate.onTerminal(status)
		}
	})
}

func (gate *ChildPassthroughCallbackGate) Cancel() {
	gate.receive(func() {
		if gate.onCancel != nil {
			gate.onCancel()
		}
	})
}

func (gate *ChildPassthroughCallbackGate) receive(callback func()) {
	gate.mu.Lock()
	if gate.state == "discarded" || gate.accepted {
		gate.mu.Unlock()
		return
	}
	gate.accepted = true
	if gate.state == "committed" {
		gate.mu.Unlock()
		callback()
		return
	}
	gate.pending = callback
	gate.mu.Unlock()
}

func (gate *ChildPassthroughCallbackGate) Commit() {
	gate.mu.Lock()
	if gate.state != "pending" {
		gate.mu.Unlock()
		return
	}
	gate.state = "committed"
	pending := gate.pending
	gate.pending = nil
	gate.mu.Unlock()
	if pending != nil {
		pending()
	}
}

func (gate *ChildPassthroughCallbackGate) Discard() {
	gate.mu.Lock()
	defer gate.mu.Unlock()
	gate.state = "discarded"
	gate.pending = nil
}
