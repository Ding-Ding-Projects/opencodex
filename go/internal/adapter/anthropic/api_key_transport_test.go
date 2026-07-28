package anthropic

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func transportRequest(t *testing.T, provider config.ProviderConfig, key string) map[string][]string {
	t.Helper()
	request := &types.NormalizedRequest{
		ModelID: "claude-opus-4-7",
		Context: types.RequestContext{
			Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hi"`)}},
		},
	}
	httpRequest, err := NewAdapter(provider, key, nil, "short").BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	return httpRequest.Header
}

// apiKeyTransport chooses WHICH header carries the key, and exactly one is ever
// set. Sending both would put the same credential in two places, and some
// gateways read the presence of Authorization as a different auth scheme.
func TestAPIKeyTransportSetsExactlyOneCredentialHeader(t *testing.T) {
	for _, test := range []struct {
		name      string
		transport string
		wantKey   string
		wantAuth  string
	}{
		{name: "omitted defaults to x-api-key", transport: "", wantKey: "secret", wantAuth: ""},
		{name: "explicit x-api-key", transport: "x-api-key", wantKey: "secret", wantAuth: ""},
		{name: "bearer moves it to Authorization", transport: "bearer", wantKey: "", wantAuth: "Bearer secret"},
	} {
		t.Run(test.name, func(t *testing.T) {
			headers := transportRequest(t, config.ProviderConfig{
				Adapter:         "anthropic",
				BaseURL:         "https://api.anthropic.com",
				AuthMode:        "key",
				APIKeyTransport: test.transport,
			}, "secret")
			if got := headerValue(headers, "X-Api-Key"); got != test.wantKey {
				t.Fatalf("x-api-key = %q, want %q", got, test.wantKey)
			}
			if got := headerValue(headers, "Authorization"); got != test.wantAuth {
				t.Fatalf("Authorization = %q, want %q", got, test.wantAuth)
			}
			// The load-bearing half: never both.
			if headerValue(headers, "X-Api-Key") != "" && headerValue(headers, "Authorization") != "" {
				t.Fatalf("both credential headers were sent: %#v", headers)
			}
		})
	}
}

// OAuth is a separate path and keeps its bearer plus the beta header,
// regardless of the setting -- which config validation refuses anyway.
func TestAPIKeyTransportDoesNotDisturbOAuth(t *testing.T) {
	headers := transportRequest(t, config.ProviderConfig{
		Adapter: "anthropic", BaseURL: "https://api.anthropic.com", AuthMode: "oauth",
	}, "oauth-token")
	if headerValue(headers, "Authorization") != "Bearer oauth-token" {
		t.Fatalf("Authorization = %q", headerValue(headers, "Authorization"))
	}
	if headerValue(headers, "Anthropic-Beta") != AnthropicOAuthBeta {
		t.Fatalf("anthropic-beta = %q", headerValue(headers, "Anthropic-Beta"))
	}
	if headerValue(headers, "X-Api-Key") != "" {
		t.Fatalf("OAuth must not also send x-api-key: %#v", headers)
	}
}

func headerValue(headers map[string][]string, name string) string {
	if values := headers[name]; len(values) > 0 {
		return values[0]
	}
	return ""
}
