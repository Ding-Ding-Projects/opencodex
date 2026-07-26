package chat

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestDoWithHeaderDeadlineClassifiesTimeoutAndClosesLateBody(t *testing.T) {
	late := make(chan struct{})
	body := &trackingReadCloser{Reader: strings.NewReader("late"), closed: make(chan struct{})}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		<-late
		return &http.Response{StatusCode: 200, Body: body, Header: make(http.Header), Request: request}, nil
	})}
	request, err := http.NewRequest(http.MethodPost, "https://example.invalid/v1/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	result := DoWithHeaderDeadline(context.Background(), client, request, 5*time.Millisecond)
	if !result.TimedOut || result.Response != nil || result.Err != nil {
		t.Fatalf("result = %#v", result)
	}
	close(late)
	select {
	case <-body.closed:
	case <-time.After(time.Second):
		t.Fatal("late response body was not closed")
	}
}

type trackingReadCloser struct {
	io.Reader
	once   sync.Once
	closed chan struct{}
}

func (body *trackingReadCloser) Close() error {
	body.once.Do(func() {
		if body.closed == nil {
			body.closed = make(chan struct{})
		}
		close(body.closed)
	})
	return nil
}

func TestReadBoundedPassthroughBodyOverflowNeverReturnsPartialBody(t *testing.T) {
	result := ReadBoundedPassthroughBody(context.Background(), io.NopCloser(strings.NewReader("sensitive response body")), 0, 8)
	if result.CloseReason != "body_overflow" || result.Err == nil || len(result.Data) != 0 {
		t.Fatalf("result = %#v", result)
	}
}

func TestAnthropicSSEObserverAssemblesUsageWithoutRetainingDeltas(t *testing.T) {
	observer := &AnthropicSSEObserver{}
	stream := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":3}}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"private output\"}}\n\n" +
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	for _, chunk := range []string{stream[:31], stream[31:117], stream[117:]} {
		observer.Consume([]byte(chunk))
	}
	observer.Finish()
	usage := observer.Usage()
	if usage == nil || usage.InputTokens != 12 || usage.OutputTokens != 4 || usage.CacheReadInputTokens != 3 || !observer.TerminalSeen() {
		t.Fatalf("usage=%#v terminal=%v", usage, observer.TerminalSeen())
	}
	if strings.Contains(observer.buffer, "private output") {
		t.Fatal("observer retained model output")
	}
}

func TestWriteAnthropicPassthroughStreamAppendsOverflowError(t *testing.T) {
	recorder := httptest.NewRecorder()
	err := WriteAnthropicPassthroughStream(context.Background(), recorder, io.NopCloser(strings.NewReader("data: 123456789\n\n")), 0, 8, nil)
	if err != nil {
		t.Fatal(err)
	}
	body := recorder.Body.String()
	if strings.Contains(body, "123456789") || !strings.Contains(body, "event: error") || !strings.Contains(body, "body exceeded 8 bytes") {
		t.Fatalf("stream = %q", body)
	}
}
