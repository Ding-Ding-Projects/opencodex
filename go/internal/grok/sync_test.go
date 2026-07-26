package grok

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncCatalogFailureDoesNotTouchConfig(t *testing.T) {
	home := tempGrokHome(t)
	result := SyncGrokConfig(context.Background(), 10100, Options{GrokHome: home}, SyncDeps{
		FetchModels: func(context.Context) ([]InjectModel, error) { return nil, errors.New("proxy down") },
	})
	if result.OK || result.Changed || !strings.Contains(result.Message, "proxy down") {
		t.Fatalf("SyncGrokConfig() = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(home, "config.toml")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config exists after catalog failure: %v", err)
	}
}

func TestFenceEnsureAndRestartAreDeterministicAndHeartbeatSafe(t *testing.T) {
	home := tempGrokHome(t)
	models := []InjectModel{{ID: "old"}}
	fence := Fence{
		Port: 10190, Hostname: "127.0.0.1", GrokHome: home,
		FetchModels: func(context.Context) ([]InjectModel, error) { return append([]InjectModel(nil), models...), nil },
	}
	if result := fence.Ensure(context.Background()); !result.OK || !result.Changed {
		t.Fatalf("Ensure() = %#v", result)
	}
	models = []InjectModel{{ID: "new"}}
	if result := fence.Restart(context.Background()); !result.OK || !result.Changed {
		t.Fatalf("Restart() = %#v", result)
	}

	content := mustRead(t, filepath.Join(home, "config.toml"))
	if strings.Count(content, BeginMarker) != 1 || strings.Contains(content, "ocx-old") || !strings.Contains(content, "[model.ocx-new]") {
		t.Fatalf("restart did not deterministically replace fence:\n%s", content)
	}
	if !strings.Contains(content, `api_backend = "chat_completions"`) {
		t.Fatalf("strict Grok path is not pinned away from raw Responses heartbeats:\n%s", content)
	}
	if result := fence.Teardown(); !result.OK || !result.Changed {
		t.Fatalf("Teardown() = %#v", result)
	}
}
