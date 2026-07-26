package cursor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const cursorModelsPath = "/agent.v1.AgentService/GetUsableModels"

const CursorDefaultContextWindow = 128_000

var canonicalCursorEffortSuffixes = map[string]struct{}{
	"minimal": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
}

type CursorModelInfo struct {
	ID                      string
	ContextWindow           int
	SupportsReasoningEffort bool
	InputModalities         []string
}

var staticModelIDs = []string{
	"auto", "auto-cost", "auto-balance", "auto-intelligence",
	"claude-sonnet-5", "claude-4-sonnet", "claude-4-sonnet-1m", "claude-4.5-haiku", "claude-4.5-sonnet", "claude-4.5-opus", "claude-4.6-opus", "claude-4.6-sonnet", "claude-opus-4-7", "claude-opus-4-7-fast", "claude-opus-4-8", "claude-opus-5", "claude-fable-5",
	"composer-1", "composer-2.5", "composer-2.5-fast", "gemini-2.5-flash", "gemini-3-flash", "gemini-3-pro", "gemini-3-pro-image-preview", "gemini-3.1-pro", "gemini-3.5-flash",
	"gpt-5-codex", "gpt-5-fast", "gpt-5-mini", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.5-extra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "glm-5.2", "kimi-k2.7-code", "grok-4.5", "grok-4.5-fast",
}

func StaticModels() []types.ModelEntry {
	models := make([]types.ModelEntry, 0, len(staticModelIDs))
	for _, id := range staticModelIDs {
		models = append(models, types.ModelEntry{ID: id, Provider: "cursor", DisplayName: id, ContextWindow: inferContextWindow(id), ReasoningEfforts: effortLadder(id)})
	}
	return models
}

func NormalizeCursorModels(models []CursorModelInfo) []CursorModelInfo {
	byID := make(map[string]CursorModelInfo, len(models))
	for _, model := range models {
		model.ID = strings.TrimSpace(model.ID)
		if model.ID == "" {
			continue
		}
		if _, exists := byID[model.ID]; exists {
			continue
		}
		if model.ContextWindow <= 0 {
			model.ContextWindow = inferContextWindow(model.ID)
		}
		model.InputModalities = normalizeCursorModalities(model.InputModalities)
		byID[model.ID] = model
	}
	out := make([]CursorModelInfo, 0, len(byID))
	for _, model := range byID {
		out = append(out, model)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func IsCursorModelAvailableForAccount(modelID string, liveIDs []string) bool {
	for _, raw := range liveIDs {
		liveID := strings.TrimPrefix(strings.TrimSpace(raw), "cursor-")
		if liveID == modelID {
			return true
		}
		prefix := modelID + "-"
		if !strings.HasPrefix(liveID, prefix) {
			continue
		}
		if _, canonical := canonicalCursorEffortSuffixes[strings.TrimPrefix(liveID, prefix)]; canonical {
			return true
		}
	}
	return false
}

func FilterCursorConfiguredModelsByLiveDiscovery(configured []CursorModelInfo, liveIDs []string) []CursorModelInfo {
	out := make([]CursorModelInfo, 0, len(configured))
	for _, model := range configured {
		if IsCursorRouterModelID(model.ID) || IsCursorModelAvailableForAccount(model.ID, liveIDs) {
			out = append(out, model)
		}
	}
	return out
}

func IsCursorRouterModelID(modelID string) bool {
	switch strings.TrimPrefix(modelID, "cursor/") {
	case "auto", "auto-cost", "auto-balance", "auto-intelligence":
		return true
	default:
		return false
	}
}

func normalizeCursorModalities(input []string) []string {
	if len(input) == 0 {
		return []string{"text", "image"}
	}
	seen := make(map[string]struct{}, len(input))
	out := make([]string, 0, len(input))
	for _, item := range input {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	if len(out) == 0 {
		return []string{"text", "image"}
	}
	return out
}

func DiscoverModels(ctx context.Context, client *http.Client, baseURL, token string) ([]string, error) {
	delay := 250*time.Millisecond + time.Duration(rand.Int64N(int64(250*time.Millisecond)))
	return discoverModels(ctx, client, baseURL, token, discoveryOptions{
		primaryTimeout: 8 * time.Second,
		retryTimeout:   3 * time.Second,
		retryDelay:     delay,
	})
}

type discoveryOptions struct {
	primaryTimeout time.Duration
	retryTimeout   time.Duration
	retryDelay     time.Duration
}

func discoverModels(ctx context.Context, client *http.Client, baseURL, token string, options discoveryOptions) ([]string, error) {
	if options.primaryTimeout <= 0 {
		options.primaryTimeout = 8 * time.Second
	}
	if options.retryTimeout <= 0 {
		options.retryTimeout = 3 * time.Second
	}
	models, err := discoverModelsOnce(ctx, client, baseURL, token, options.primaryTimeout)
	if err == nil || !retryableDiscoveryError(ctx, err) {
		return models, err
	}
	if options.retryDelay > 0 {
		timer := time.NewTimer(options.retryDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, errors.Join(err, ctx.Err())
		case <-timer.C:
		}
	}
	return discoverModelsOnce(ctx, client, baseURL, token, options.retryTimeout)
}

func discoverModelsOnce(ctx context.Context, client *http.Client, baseURL, token string, timeout time.Duration) ([]string, error) {
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ForceAttemptHTTP2 = true
		client = &http.Client{Transport: transport}
	}
	if baseURL == "" {
		baseURL = "https://api2.cursor.sh"
	}
	if token == "" {
		return nil, fmt.Errorf("Cursor access token is required")
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, strings.TrimRight(baseURL, "/")+cursorModelsPath, bytes.NewReader(MarshalGetUsableModelsRequest(nil)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/proto")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Ghost-Mode", "true")
	req.Header.Set("X-Cursor-Client-Version", cursorClientVersion)
	req.Header.Set("X-Cursor-Client-Type", "cli")
	req.Header.Set("X-Session-Id", newID())
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return nil, &CursorError{Kind: ErrorAuth, StatusCode: response.StatusCode, Err: fmt.Errorf("HTTP %d", response.StatusCode)}
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("Cursor model discovery HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	decoded, err := UnmarshalGetUsableModelsResponse(payload)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor model discovery: %w", err)
	}
	seen := map[string]struct{}{}
	ids := make([]string, 0, len(decoded.Models))
	for _, model := range decoded.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" || len(ids) == 500 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("Cursor model discovery returned no usable models")
	}
	sort.Strings(ids)
	return ids, nil
}

func retryableDiscoveryError(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil {
		return false
	}
	classified := ClassifyError(err)
	return classified != nil && classified.Kind == ErrorTransport && classified.Retryable
}

func inferContextWindow(id string) int {
	id = strings.ToLower(id)
	switch {
	case strings.Contains(id, "1m"), strings.HasPrefix(id, "gemini-"), id == "glm-5.2", strings.HasPrefix(id, "gpt-5.6-"):
		return 1_000_000
	case strings.HasPrefix(id, "grok-4.5"):
		return 500_000
	case strings.HasPrefix(id, "gpt-5"):
		return 272_000
	case strings.HasPrefix(id, "grok-"):
		return 256_000
	case strings.Contains(id, "claude"), strings.HasPrefix(id, "auto"):
		return 200_000
	default:
		return CursorDefaultContextWindow
	}
}
func effortLadder(id string) []string {
	tiers := cursorEffortTiers[id]
	if len(tiers) == 0 {
		return nil
	}
	out := append([]string(nil), tiers...)
	return out
}

func IsCursorNativeWireModel(modelID string) bool {
	wire := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(modelID, "cursor/")))
	for _, suffix := range []string{"minimal", "medium", "xhigh", "high", "max", "low"} {
		wire = strings.TrimSuffix(wire, "-"+suffix)
	}
	return wire == "default" || wire == "auto" || strings.HasPrefix(wire, "composer-")
}

func IsCursorExternalWireModel(modelID string) bool { return !IsCursorNativeWireModel(modelID) }
