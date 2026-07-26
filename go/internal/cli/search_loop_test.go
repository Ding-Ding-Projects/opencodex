package cli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type searchLoopAuth struct{ credential *types.AuthContext }

func (auth searchLoopAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return auth.credential, nil
}
func (searchLoopAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

func TestConfiguredSearchLoopActivatesProductionExecutor(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer sidecar-token" {
			t.Fatalf("sidecar request path=%s authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_text.done\",\"text\":\"live answer\"}\n\n")
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "openai", BaseURL: upstream.URL, DefaultModel: "gpt-5.6-luna", Models: []registry.ModelDefinition{{ID: "gpt-5.6-luna"}}})
	auth := searchLoopAuth{credential: &types.AuthContext{Headers: map[string]string{"Authorization": "Bearer sidecar-token"}}}
	loop := configuredSearchLoop(config.Default(), reg, auth, upstream.Client())
	if loop == nil || loop.Executor == nil {
		t.Fatal("default web-search sidecar loop is not wired")
	}
	result, err := loop.Executor.Search(context.Background(), "current facts", nil)
	if err != nil || strings.TrimSpace(result.Text) != "live answer" {
		t.Fatalf("search result=%#v err=%v", result, err)
	}
}

func TestConfiguredSearchLoopHonorsDisabledSetting(t *testing.T) {
	disabled := false
	cfg := config.Default()
	cfg.WebSearchSidecar = &config.WebSearchSidecarConfig{Enabled: &disabled}
	if loop := configuredSearchLoop(cfg, nil, nil, nil); loop != nil {
		t.Fatalf("disabled search loop=%#v", loop)
	}
}
