package grok

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoHomeMissingConfigAndInvalidPortResults(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	if result := InjectGrokConfig(10100, nil, Options{GrokHome: missing}); !result.OK || result.SkippedReason != SkipNoGrokHome {
		t.Fatalf("missing-home inject = %#v", result)
	}
	if result := StripGrokConfig(Options{GrokHome: missing}); !result.OK || result.SkippedReason != SkipNoGrokHome {
		t.Fatalf("missing-home strip = %#v", result)
	}
	home := tempGrokHome(t)
	if result := StripGrokConfig(Options{GrokHome: home}); !result.OK || result.Changed {
		t.Fatalf("missing-config strip = %#v", result)
	}
	if result := InjectGrokConfig(0, nil, Options{GrokHome: home}); result.OK || !strings.Contains(result.Message, "invalid proxy port") {
		t.Fatalf("invalid-port inject = %#v", result)
	}
}

func TestDefaultHomeResolutionAndIdempotentInjection(t *testing.T) {
	home := tempGrokHome(t)
	t.Setenv("GROK_HOME", home)
	first := InjectGrokConfig(10100, []InjectModel{{ID: "quoted", Name: `Quoted "name"`}}, Options{})
	if !first.OK || !first.Changed {
		t.Fatalf("first inject = %#v", first)
	}
	second := InjectGrokConfig(10100, []InjectModel{{ID: "quoted", Name: `Quoted "name"`}}, Options{})
	if !second.OK || second.Changed {
		t.Fatalf("idempotent inject = %#v", second)
	}
	content := mustRead(t, filepath.Join(home, "config.toml"))
	if !strings.Contains(content, `name = "Quoted \"name\""`) {
		t.Fatalf("TOML name was not escaped: %s", content)
	}
}

func TestLoopbackVariantsAndNilSyncDependency(t *testing.T) {
	for _, hostname := range []string{"", "localhost", "127.0.0.1", "::1", "[::1]"} {
		home := tempGrokHome(t)
		result := InjectGrokConfig(10100, nil, Options{GrokHome: home, Hostname: hostname})
		if !result.OK || !result.Changed {
			t.Fatalf("loopback %q inject = %#v", hostname, result)
		}
	}
	result := SyncGrokConfig(context.Background(), 10100, Options{GrokHome: tempGrokHome(t)}, SyncDeps{})
	if result.OK || result.Changed || !strings.Contains(result.Message, "FetchModels is nil") {
		t.Fatalf("nil sync dependency = %#v", result)
	}
}

func TestNonLoopbackRemovesStaleFenceButPreservesUserBytes(t *testing.T) {
	home := tempGrokHome(t)
	path := filepath.Join(home, "config.toml")
	original := []byte("[model.mine]\nmodel = \"mine\"\napi_key = \"real-admission-token\"\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if result := InjectGrokConfig(10100, []InjectModel{{ID: "old"}}, Options{GrokHome: home}); !result.OK {
		t.Fatal(result.Message)
	}
	result := InjectGrokConfig(10100, []InjectModel{{ID: "new"}}, Options{GrokHome: home, Hostname: "0.0.0.0"})
	if !result.OK || !result.Changed || result.SkippedReason != SkipNonLoopback {
		t.Fatalf("non-loopback cleanup = %#v", result)
	}
	assertFileBytes(t, path, original)
}
