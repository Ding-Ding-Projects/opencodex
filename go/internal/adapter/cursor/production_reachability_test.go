package cursor_test

import (
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProductionResponsesRouteConsumesCursorConnectStream(t *testing.T) {
	requests := make(chan *http.Request, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if err := http.NewResponseController(w).EnableFullDuplex(); err != nil {
			t.Errorf("enable Cursor full duplex: %v", err)
			return
		}
		if _, err := cursor.ReadFrame(request.Body, cursor.DefaultMaxFrameSize); err != nil {
			t.Errorf("read Cursor client frame: %v", err)
			return
		}
		requests <- request.Clone(request.Context())
		w.Header().Set("Content-Type", "application/connect+proto")
		for _, frame := range []cursor.ConnectFrame{
			{Payload: cursorServerTextFrame("routed through Cursor")},
			{Payload: cursorServerTerminalFrame()},
			{Flags: cursor.ConnectFlagEndStream, Payload: []byte(`{}`)},
		} {
			encoded, err := cursor.EncodeFrame(frame)
			if err != nil {
				t.Error(err)
				return
			}
			if _, err := w.Write(encoded); err != nil {
				t.Error(err)
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	}))
	defer upstream.Close()

	reg := registry.New(registry.Provider{
		ID: "cursor", BaseURL: upstream.URL, DefaultModel: "gpt-5.6-sol",
		Models: []registry.ModelDefinition{{ID: "gpt-5.6-sol"}},
	})
	proxy := server.New(server.Config{
		Registry: reg,
		Client:   upstream.Client(),
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return cursor.NewAdapter(cursor.AdapterConfig{
				BaseURL: transport.BaseURL, Token: "cursor-production-token", HeartbeatInterval: time.Hour,
			})
		},
	})
	defer proxy.Close()

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(
		`{"model":"cursor/gpt-5.6-sol","input":"hello","stream":false}`,
	))
	proxy.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "routed through Cursor") {
		t.Fatalf("production Cursor response=%d %s", response.Code, response.Body.String())
	}
	select {
	case got := <-requests:
		if got.URL.Path != "/agent.v1.AgentService/Run" || got.Header.Get("X-Cursor-Client-Type") == "" {
			t.Fatalf("Cursor upstream fingerprint path=%q headers=%v", got.URL.Path, got.Header)
		}
	default:
		t.Fatal("production route did not reach the Cursor upstream")
	}
}

func cursorServerTextFrame(text string) []byte {
	textUpdate := cursorAppendMessage(nil, 1, cursorAppendString(nil, 1, text))
	return cursorAppendMessage(nil, 1, textUpdate)
}

func cursorServerTerminalFrame() []byte {
	return cursorAppendMessage(nil, 1, cursorAppendMessage(nil, 14, nil))
}

func cursorAppendString(dst []byte, field int, value string) []byte {
	return cursorAppendMessage(dst, field, []byte(value))
}

func cursorAppendMessage(dst []byte, field int, value []byte) []byte {
	dst = binary.AppendUvarint(dst, uint64(field<<3|2))
	dst = binary.AppendUvarint(dst, uint64(len(value)))
	return append(dst, value...)
}
