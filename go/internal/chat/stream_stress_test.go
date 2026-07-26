package chat

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestConcurrentChatAndAnthropicStreams(t *testing.T) {
	const workers = 32
	const deltas = 128
	errors := make(chan error, workers)
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		worker := worker
		group.Add(1)
		go func() {
			defer group.Done()
			events := make(chan types.AdapterEvent, deltas+1)
			for index := 0; index < deltas; index++ {
				events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "x"}
			}
			events <- types.AdapterEvent{Type: types.EventDone}
			close(events)
			writer := httptest.NewRecorder()
			var err error
			if worker%2 == 0 {
				err = WriteChatStream(context.Background(), writer, "m", events)
				if err == nil && (!strings.Contains(writer.Body.String(), "data: [DONE]") || strings.Count(writer.Body.String(), `"content":"x"`) != deltas) {
					err = fmt.Errorf("chat stream %d lost frames", worker)
				}
			} else {
				err = writeAnthropicStream(context.Background(), writer, "m", events)
				if err == nil && (!strings.Contains(writer.Body.String(), "event: message_stop") || strings.Count(writer.Body.String(), `"text":"x"`) != deltas) {
					err = fmt.Errorf("Anthropic stream %d lost frames", worker)
				}
			}
			if err != nil {
				errors <- err
			}
		}()
	}
	group.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}

func TestLongAnthropicStreamPreservesEveryDelta(t *testing.T) {
	const deltas = 10_000
	events := make(chan types.AdapterEvent, 64)
	go func() {
		defer close(events)
		for index := 0; index < deltas; index++ {
			events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "0123456789abcdef"}
		}
		events <- types.AdapterEvent{Type: types.EventDone}
	}()
	writer := httptest.NewRecorder()
	if err := writeAnthropicStream(context.Background(), writer, "long-model", events); err != nil {
		t.Fatal(err)
	}
	body := writer.Body.String()
	if strings.Count(body, `"text":"0123456789abcdef"`) != deltas || !strings.Contains(body, "event: message_stop") {
		t.Fatalf("long stream lost output: bytes=%d deltas=%d", len(body), strings.Count(body, `"text":"0123456789abcdef"`))
	}
}
