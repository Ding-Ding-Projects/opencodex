package server

import (
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestShouldAttemptImageTierRetry(t *testing.T) {
	request := &types.NormalizedRequest{Context: types.RequestContext{Messages: []types.Message{{
		Role: "user", Content: json.RawMessage(`[{"type":"input_image","image_url":"data:image/png;base64,AA=="}]`),
	}}}}
	if !ShouldAttemptImageTierRetry(413, "anthropic", request, false) {
		t.Fatal("expected one retry for an Anthropic inline image")
	}
	for _, test := range []struct {
		status int
		name   string
		done   bool
	}{{400, "anthropic", false}, {413, "openai", false}, {413, "anthropic", true}} {
		if ShouldAttemptImageTierRetry(test.status, test.name, request, test.done) {
			t.Fatalf("unexpected retry for %#v", test)
		}
	}
}
