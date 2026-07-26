package kiro

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestConvertToolsSchemaRoundTripPreservesPropertyNames(t *testing.T) {
	req := &types.NormalizedRequest{
		ModelID: "claude-sonnet-4",
		Context: types.RequestContext{Tools: []types.Tool{{
			Namespace: "memories",
			Name:      "search",
			Parameters: map[string]any{
				"oneOf": []any{
					map[string]any{"type": "object", "properties": map[string]any{
						"format": map[string]any{"type": "string", "pattern": "^[a-z]+$"},
					}, "required": []any{"format"}},
					map[string]any{"type": "object", "properties": map[string]any{
						"pattern": map[string]any{"type": "string", "minLength": 1},
					}},
				},
				"allOf": []any{map[string]any{"properties": map[string]any{
					"path": map[string]any{"type": "string", "format": "uri"},
				}, "required": []any{"path"}}},
			},
		}}},
	}
	registry := NewToolNameRegistry()
	converted, err := ConvertTools(req, registry)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(converted)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip []map[string]any
	if err := json.Unmarshal(wire, &roundTrip); err != nil {
		t.Fatal(err)
	}
	spec := roundTrip[0]["toolSpecification"].(map[string]any)
	schema := spec["inputSchema"].(map[string]any)["json"].(map[string]any)
	if schema["type"] != "object" {
		t.Fatalf("root type = %#v", schema["type"])
	}
	properties := schema["properties"].(map[string]any)
	for _, name := range []string{"format", "pattern", "path"} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("property %q was removed: %#v", name, properties)
		}
	}
	if _, exists := properties["path"].(map[string]any)["format"]; exists {
		t.Fatalf("nested rejected schema keyword survived: %#v", properties["path"])
	}
	required := schema["required"].([]any)
	if len(required) != 1 || required[0] != "path" {
		t.Fatalf("flattened required = %#v", required)
	}
}

func TestConvertToolsUnicodeDescriptionIsValidAndBounded(t *testing.T) {
	description := strings.Repeat("界", defaultToolDescriptionLimit+10)
	req := &types.NormalizedRequest{Context: types.RequestContext{Tools: []types.Tool{{Name: "echo", Description: description}}}}
	converted, err := ConvertTools(req, nil)
	if err != nil {
		t.Fatal(err)
	}
	desc := converted[0]["toolSpecification"].(map[string]any)["description"].(string)
	if !strings.HasSuffix(desc, "…") || len([]rune(desc)) != defaultToolDescriptionLimit {
		t.Fatalf("description rune length/suffix = %d/%q", len([]rune(desc)), desc[len(desc)-3:])
	}
	if _, err := json.Marshal(converted); err != nil {
		t.Fatalf("truncated description is not JSON-safe: %v", err)
	}
}

type endpointFallbackTransport struct {
	requests []*http.Request
	mode     string
}

func (t *endpointFallbackTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	t.requests = append(t.requests, request.Clone(request.Context()))
	if strings.HasSuffix(request.URL.Hostname(), ".kiro.dev") {
		switch t.mode {
		case "connect":
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
		case "marker":
			return testHTTPResponse(http.StatusForbidden, `{"__type":"InvalidSignatureException"}`), nil
		case "ordinary":
			return testHTTPResponse(http.StatusForbidden, `{"message":"access denied"}`), nil
		}
	}
	return testHTTPResponse(http.StatusOK, `{"ok":true}`), nil
}

func TestDoWithRetryFallsBackToLegacyOnEndpointConnectFailure(t *testing.T) {
	transport := &endpointFallbackTransport{mode: "connect"}
	request, _ := http.NewRequest(http.MethodPost, "https://runtime.eu-central-1.kiro.dev/", strings.NewReader("{}"))
	request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("{}")), nil }
	response, err := DoWithRetry(context.Background(), &http.Client{Transport: transport}, request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || len(transport.requests) != 2 {
		t.Fatalf("status/requests = %d/%d", response.StatusCode, len(transport.requests))
	}
	if got := transport.requests[1].URL.Hostname(); got != "q.eu-central-1.amazonaws.com" {
		t.Fatalf("fallback host = %q", got)
	}
}

func TestDoWithRetryFallsBackOnlyForEndpointHTTPMarkers(t *testing.T) {
	for _, test := range []struct {
		name string
		mode string
		want int
	}{
		{name: "endpoint marker", mode: "marker", want: 2},
		{name: "ordinary auth failure", mode: "ordinary", want: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := &endpointFallbackTransport{mode: test.mode}
			request, _ := http.NewRequest(http.MethodPost, "https://runtime.us-west-2.kiro.dev/", strings.NewReader("{}"))
			request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("{}")), nil }
			response, err := DoWithRetry(context.Background(), &http.Client{Transport: transport}, request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if len(transport.requests) != test.want {
				t.Fatalf("request count = %d, want %d", len(transport.requests), test.want)
			}
			if test.mode == "ordinary" {
				body, _ := io.ReadAll(response.Body)
				if string(body) != `{"message":"access denied"}` {
					t.Fatalf("rebuilt response body = %q", body)
				}
			}
		})
	}
}

func TestKiroQuotaPrefixDistinguishesRateQuota(t *testing.T) {
	failure := ClassifyHTTPError(http.StatusTooManyRequests, nil, `{"message":"Account quota exceeded: 100 requests per minute"}`)
	if !strings.HasPrefix(failure.Message, "Kiro rate limit exceeded") {
		t.Fatalf("classification = %#v", failure)
	}
}

func testHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
