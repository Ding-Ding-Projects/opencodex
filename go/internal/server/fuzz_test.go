package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func FuzzParseResponsesRequest(f *testing.F) {
	for _, seed := range [][]byte{
		[]byte(`{"model":"provider/model","input":"hello","stream":true}`),
		[]byte(`{"model":"","input":null}`),
		[]byte(`{"model":1,"stream":"yes"}`),
		[]byte("{\x00"),
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, payload []byte) {
		if len(payload) > 64<<10 {
			t.Skip()
		}
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(string(payload)))
		_, _ = parseResponsesRequest(httptest.NewRecorder(), request, 64<<10)
	})
}

func FuzzSSEReassembly(f *testing.F) {
	for _, seed := range []struct {
		payload []byte
		split   uint8
	}{
		{[]byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"), 7},
		{[]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"안녕🚀\"}\n\n"), 1},
		{[]byte("data: [DONE]\n\n"), 255},
		{[]byte{0, 0xff, '\n', '\n'}, 2},
	} {
		f.Add(seed.payload, seed.split)
	}
	f.Fuzz(func(t *testing.T, payload []byte, split uint8) {
		if len(payload) > 64<<10 {
			t.Skip()
		}
		inspector := NewSSEInspector(SSEInspectorHandlers{})
		width := int(split)%31 + 1
		for start := 0; start < len(payload); start += width {
			end := start + width
			if end > len(payload) {
				end = len(payload)
			}
			inspector.Consume(payload[start:end])
		}
		inspector.Finish()
		_ = ParseSSEDataPayloads(payload)
	})
}
