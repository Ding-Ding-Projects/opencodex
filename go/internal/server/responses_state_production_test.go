package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestResponsesProductionStreamStoresAndReplaysPreviousResponse(t *testing.T) {
	state := NewResponseStateStore("")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	var builds atomic.Int32
	var replayed map[string]any
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, ResponseState: state,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL, onBuild: func(request *types.NormalizedRequest) {
				if builds.Add(1) == 2 {
					_ = json.Unmarshal(request.RawBody, &replayed)
				}
			}}, nil
		},
	})
	first := httptest.NewRecorder()
	firstRequest := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":true,"input":"first"}`))
	core.ServeHTTP(first, firstRequest)
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), "response.completed") {
		t.Fatalf("first response=%d %s", first.Code, first.Body.String())
	}
	var responseID string
	for _, line := range strings.Split(first.Body.String(), "\n") {
		if !strings.HasPrefix(line, "data: {") || !strings.Contains(line, `"response"`) {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) == nil {
			if response, _ := event["response"].(map[string]any); response["status"] == "completed" {
				responseID, _ = response["id"].(string)
			}
		}
	}
	if responseID == "" {
		t.Fatalf("completed response id missing: %s", first.Body.String())
	}
	second := httptest.NewRecorder()
	secondBody := `{"model":"public","stream":false,"previous_response_id":"` + responseID + `","input":"second"}`
	core.ServeHTTP(second, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(secondBody)))
	items, _ := replayed["input"].([]any)
	if second.Code != http.StatusOK || len(items) != 3 {
		t.Fatalf("second=%d replay=%#v body=%s", second.Code, replayed, second.Body.String())
	}
	firstInput, _ := items[0].(map[string]any)
	priorOutput, _ := items[1].(map[string]any)
	secondInput, _ := items[2].(map[string]any)
	if firstInput["content"] != "first" || priorOutput["type"] != "message" || secondInput["content"] != "second" {
		t.Fatalf("replay item order=%#v", items)
	}
	metrics := state.Metrics()
	if metrics.Count != 2 || metrics.TotalBytes == 0 || metrics.LargestBytes == 0 {
		t.Fatalf("state metrics=%+v", metrics)
	}
}

func TestResponseStateSnapshotSurvivesRestartWithPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "responses-state.json")
	store := NewResponseStateStore(path)
	store.Remember([]byte(`{"input":"hello"}`), bridge.Response{ID: "resp_saved", Status: "completed", Output: []map[string]any{{"type": "message", "content": []any{}}}}, nil, false)
	store.Flush()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("snapshot permissions=%o", info.Mode().Perm())
	}
	reloaded := NewResponseStateStore(path)
	expanded, prefix, _, hit := reloaded.Expand(map[string]any{"previous_response_id": "resp_saved", "input": "next"})
	if !hit || prefix != 2 || len(expanded["input"].([]any)) != 3 {
		t.Fatalf("restart replay hit=%v prefix=%d body=%#v", hit, prefix, expanded)
	}
}

func TestResponseStateHonorsStoreFalseTTLAndByteCap(t *testing.T) {
	store := NewResponseStateStore("")
	now := time.Unix(1000, 0)
	store.now = func() time.Time { return now }
	store.byteCap = 200
	response := func(id, text string) bridge.Response {
		return bridge.Response{ID: id, Status: "completed", Output: []map[string]any{{"type": "message", "text": text}}}
	}
	store.Remember([]byte(`{"input":"private","store":false}`), response("skip", "not retained"), nil, false)
	if metrics := store.Metrics(); metrics.Count != 0 {
		t.Fatalf("store:false retained without force: %+v", metrics)
	}
	store.Remember([]byte(`{"input":"one"}`), response("one", strings.Repeat("a", 80)), nil, false)
	store.Remember([]byte(`{"input":"two"}`), response("two", strings.Repeat("b", 80)), nil, false)
	if metrics := store.Metrics(); metrics.Count != 1 || metrics.TotalBytes > store.byteCap {
		t.Fatalf("byte cap did not evict oldest: %+v", metrics)
	}
	now = now.Add(responseStateTTL + time.Millisecond)
	_, _, _, hit := store.Expand(map[string]any{"previous_response_id": "two", "input": "next"})
	if hit || store.Metrics().Count != 0 {
		t.Fatalf("expired response state survived TTL")
	}
}

func TestResponsesSubagentFallbackPrimesReroutesAndLearns429(t *testing.T) {
	primaryCalls := atomic.Int32{}
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		primaryCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":"quota exhausted"}`)
	}))
	defer primary.Close()
	backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer backup.Close()
	reg := registry.New(
		registry.Provider{ID: "primary", Adapter: "openai-chat", BaseURL: primary.URL, DefaultModel: "main", Models: []registry.ModelDefinition{{ID: "main"}}},
		registry.Provider{ID: "backup", Adapter: "openai-chat", BaseURL: backup.URL, DefaultModel: "alt", Models: []registry.ModelDefinition{{ID: "alt"}}},
	)
	cfg := appconfig.Default()
	cfg.DefaultProvider = "primary"
	cfg.Providers = map[string]appconfig.ProviderConfig{
		"primary": {Adapter: "openai-chat", BaseURL: primary.URL},
		"backup":  {Adapter: "openai-chat", BaseURL: backup.URL},
	}
	cfg.SubagentModelFallback = []string{"backup/alt"}
	state := codex.NewSubagentFallbackState()
	var primes atomic.Int32
	proxy := New(Config{
		Registry: reg, ManagementConfig: &cfg, SubagentFallbackState: state,
		PrimeSubagentQuota: func(context.Context, string) error { primes.Add(1); return nil },
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
	})
	headers := http.Header{"X-OpenAI-Subagent": []string{"collab_spawn"}}
	first := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"primary/main","stream":false}`, headers)
	if first.Code != http.StatusTooManyRequests || primaryCalls.Load() != 1 {
		t.Fatalf("first=%d %s primaryCalls=%d", first.Code, first.Body.String(), primaryCalls.Load())
	}
	second := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"primary/main","stream":false}`, headers)
	if second.Code != http.StatusOK || primaryCalls.Load() != 1 || !strings.Contains(second.Body.String(), `"status":"completed"`) || !strings.Contains(second.Body.String(), `"model":"alt"`) {
		t.Fatalf("second=%d %s primaryCalls=%d", second.Code, second.Body.String(), primaryCalls.Load())
	}
	if primes.Load() != 1 {
		t.Fatalf("quota prime calls=%d, want one shared TTL call", primes.Load())
	}
}

func TestManagementMemoryIncludesResponseStateMetrics(t *testing.T) {
	state := NewResponseStateStore("")
	state.Remember([]byte(`{"input":"hello"}`), bridge.Response{ID: "resp_metric", Status: "completed", Output: []map[string]any{}}, nil, false)
	cfg := appconfig.Default()
	proxy := New(Config{ManagementConfig: &cfg, ResponseState: state})
	response := serveRequest(proxy.Handler(), http.MethodGet, "/api/system/memory", "", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"responseState":{"count":1`) || !strings.Contains(response.Body.String(), `"totalBytes":`) {
		t.Fatalf("memory response=%d %s", response.Code, response.Body.String())
	}
	proxy.Close()
}
