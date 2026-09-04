package cli

import (
	"runtime/debug"
	"testing"
)

func TestResolveBuildVersion(t *testing.T) {
	for _, test := range []struct {
		name, version, want string
	}{
		{"release", "v2.7.40", "2.7.40"},
		{"without prefix", "2.7.40-preview.1", "2.7.40-preview.1"},
		{"development", "(devel)", "fallback"},
		{"missing", "", "fallback"},
	} {
		t.Run(test.name, func(t *testing.T) {
			info := &debug.BuildInfo{Main: debug.Module{Version: test.version}}
			if got := resolveBuildVersion("fallback", info); got != test.want {
				t.Fatalf("resolveBuildVersion() = %q, want %q", got, test.want)
			}
		})
	}
}
