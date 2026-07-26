package protocol_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/adapter/kiro"
	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProductionKiroRouteActivatesSmithySuccessAndCorruption(t *testing.T) {
	valid := smithyEvent(t, "assistantResponseEvent", map[string]any{"content": "routed Smithy response"})
	corrupt := append([]byte(nil), valid...)
	corrupt[8] ^= 0xff

	for _, test := range []struct {
		name       string
		body       []byte
		wantStatus int
		wantBody   string
		wantFailed bool
	}{
		{name: "valid", body: valid, wantStatus: http.StatusOK, wantBody: "routed Smithy response"},
		{name: "corrupt prelude", body: corrupt, wantStatus: http.StatusOK, wantBody: "prelude CRC mismatch", wantFailed: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
				_, _ = w.Write(test.body)
			}))
			defer upstream.Close()

			reg := registry.New(registry.Provider{ID: "kiro", BaseURL: upstream.URL, DefaultModel: "probe", Models: []registry.ModelDefinition{{ID: "probe"}}})
			proxy := server.New(server.Config{
				Registry: reg,
				ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
					return kiro.NewAdapter(transport.BaseURL, "production-token"), nil
				},
			})
			defer proxy.Close()

			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"kiro/probe","input":"hello","stream":false}`))
			proxy.Handler().ServeHTTP(response, request)
			body := response.Body.String()
			if response.Code != test.wantStatus || !strings.Contains(body, test.wantBody) || test.wantFailed && !strings.Contains(body, `"status":"failed"`) {
				t.Fatalf("production Kiro response=%d %s", response.Code, response.Body.String())
			}
		})
	}
}

func smithyEvent(t *testing.T, eventType string, payload any) []byte {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	err = protocol.EncodeSmithyFrame(&output, &protocol.SmithyFrame{
		Headers: map[string]protocol.SmithyHeaderValue{
			":message-type": {Type: protocol.SmithyHeaderString, Value: "event"},
			":event-type":   {Type: protocol.SmithyHeaderString, Value: eventType},
		},
		Payload: encoded,
	})
	if err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
