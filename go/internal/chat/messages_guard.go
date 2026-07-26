package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type HeaderDeadlineResult struct {
	Response *http.Response
	TimedOut bool
	Err      error
}

type headerReadResult struct {
	response *http.Response
	err      error
}

// DoWithHeaderDeadline bounds only the wait for response headers. The timeout
// is stopped once Client.Do returns, so a healthy long-lived SSE body is not
// constrained by the connect deadline.
func DoWithHeaderDeadline(parent context.Context, client *http.Client, request *http.Request, timeout time.Duration) HeaderDeadlineResult {
	if client == nil {
		client = http.DefaultClient
	}
	if timeout <= 0 {
		response, err := client.Do(request)
		return HeaderDeadlineResult{Response: response, Err: err}
	}
	request = request.Clone(parent)
	cancelRequest := make(chan struct{})
	request.Cancel = cancelRequest
	done := make(chan headerReadResult, 1)
	go func() {
		response, err := client.Do(request)
		done <- headerReadResult{response: response, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case completed := <-done:
		// Do not close cancelRequest: net/http treats it as a lifetime signal for
		// the response body. Parent cancellation still propagates via Context.
		return HeaderDeadlineResult{Response: completed.response, Err: completed.err}
	case <-timer.C:
		close(cancelRequest)
		go closeLateHeaderResponse(done)
		return HeaderDeadlineResult{TimedOut: true}
	case <-parent.Done():
		close(cancelRequest)
		go closeLateHeaderResponse(done)
		return HeaderDeadlineResult{Err: parent.Err()}
	}
}

func closeLateHeaderResponse(done <-chan headerReadResult) {
	completed := <-done
	if completed.response != nil && completed.response.Body != nil {
		_ = completed.response.Body.Close()
	}
}

type PassthroughBodyResult struct {
	Data        []byte
	CloseReason string
	Err         error
}

type bodyReadResult struct {
	data []byte
	err  error
}

// ReadBoundedPassthroughBody enforces a silence-only deadline while each read
// is pending and a cumulative byte cap. Downstream processing time never counts
// as upstream inactivity.
func ReadBoundedPassthroughBody(ctx context.Context, body io.ReadCloser, stall time.Duration, maxBytes int64) PassthroughBodyResult {
	if body == nil {
		return PassthroughBodyResult{Data: []byte{}}
	}
	defer body.Close()
	buffer := make([]byte, 32<<10)
	data := make([]byte, 0, minInt64(maxBytes, 32<<10))
	for {
		result := make(chan bodyReadResult, 1)
		go func() {
			n, err := body.Read(buffer)
			result <- bodyReadResult{data: append([]byte(nil), buffer[:n]...), err: err}
		}()
		var timer <-chan time.Time
		var deadline *time.Timer
		if stall > 0 {
			deadline = time.NewTimer(stall)
			timer = deadline.C
		}
		select {
		case <-ctx.Done():
			if deadline != nil {
				deadline.Stop()
			}
			_ = body.Close()
			return PassthroughBodyResult{CloseReason: "client_cancel", Err: ctx.Err()}
		case <-timer:
			_ = body.Close()
			return PassthroughBodyResult{CloseReason: "body_stall", Err: fmt.Errorf("anthropic passthrough body stalled: no upstream bytes for %s", stall)}
		case read := <-result:
			if deadline != nil {
				deadline.Stop()
			}
			if len(read.data) > 0 {
				if maxBytes > 0 && int64(len(data)+len(read.data)) > maxBytes {
					_ = body.Close()
					return PassthroughBodyResult{CloseReason: "body_overflow", Err: fmt.Errorf("anthropic passthrough body exceeded %d bytes", maxBytes)}
				}
				data = append(data, read.data...)
			}
			if read.err != nil {
				if errors.Is(read.err, io.EOF) {
					return PassthroughBodyResult{Data: data, CloseReason: "terminal"}
				}
				return PassthroughBodyResult{Data: data, CloseReason: "terminal", Err: read.err}
			}
		}
	}
}

func minInt64(value int64, fallback int) int {
	if value <= 0 || value > int64(fallback) {
		return fallback
	}
	return int(value)
}

// AnthropicSSEObserver keeps only protocol metadata: usage and terminal state.
// Text deltas and tool input are parsed frame-by-frame and immediately discarded.
type AnthropicSSEObserver struct {
	buffer   string
	usage    types.Usage
	hasUsage bool
	terminal bool
}

func (observer *AnthropicSSEObserver) Consume(chunk []byte) {
	if observer == nil || len(chunk) == 0 {
		return
	}
	observer.buffer += string(chunk)
	for {
		index, width := anthropicFrameBoundary(observer.buffer)
		if index < 0 {
			return
		}
		frame := observer.buffer[:index]
		observer.buffer = observer.buffer[index+width:]
		observer.inspect(frame)
	}
}

func (observer *AnthropicSSEObserver) Finish() {
	if observer == nil || strings.TrimSpace(observer.buffer) == "" {
		return
	}
	observer.inspect(observer.buffer)
	observer.buffer = ""
}

func (observer *AnthropicSSEObserver) Usage() *types.Usage {
	if observer == nil || !observer.hasUsage {
		return nil
	}
	usage := observer.usage
	return &usage
}

func (observer *AnthropicSSEObserver) TerminalSeen() bool {
	return observer != nil && observer.terminal
}

func anthropicFrameBoundary(value string) (int, int) {
	lf, crlf := strings.Index(value, "\n\n"), strings.Index(value, "\r\n\r\n")
	if crlf >= 0 && (lf < 0 || crlf < lf) {
		return crlf, 4
	}
	return lf, 2
}

func (observer *AnthropicSSEObserver) inspect(frame string) {
	data := make([]string, 0, 1)
	scanner := bufio.NewScanner(strings.NewReader(strings.ReplaceAll(frame, "\r\n", "\n")))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if len(data) == 0 {
		return
	}
	var event map[string]any
	if json.Unmarshal([]byte(strings.Join(data, "")), &event) != nil {
		return
	}
	switch event["type"] {
	case "message_start":
		message, _ := event["message"].(map[string]any)
		observer.mergeUsage(message["usage"])
	case "message_delta":
		observer.mergeUsage(event["usage"])
	case "message_stop", "error":
		observer.terminal = true
	}
}

func (observer *AnthropicSSEObserver) mergeUsage(value any) {
	usage, ok := value.(map[string]any)
	if !ok {
		return
	}
	if input, ok := numericInt(usage["input_tokens"]); ok {
		observer.usage.InputTokens = input
		observer.hasUsage = true
	}
	if output, ok := numericInt(usage["output_tokens"]); ok {
		observer.usage.OutputTokens = output
		observer.hasUsage = true
	}
	if cached, ok := numericInt(usage["cache_read_input_tokens"]); ok {
		observer.usage.CachedInputTokens = cached
		observer.usage.CacheReadInputTokens = cached
		observer.hasUsage = true
	}
	if created, ok := numericInt(usage["cache_creation_input_tokens"]); ok {
		observer.usage.CacheCreationInputTokens = created
		observer.hasUsage = true
	}
	observer.usage.TotalTokens = observer.usage.InputTokens + observer.usage.OutputTokens
}

func numericInt(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		integer := int(number)
		return integer, number == float64(integer) && integer >= 0
	case int:
		return number, number >= 0
	default:
		return 0, false
	}
}

func WriteAnthropicPassthroughStream(ctx context.Context, writer http.ResponseWriter, body io.ReadCloser, stall time.Duration, maxBytes int64, observer *AnthropicSSEObserver) error {
	if observer == nil {
		observer = &AnthropicSSEObserver{}
	}
	flusher, _ := writer.(http.Flusher)
	var total int64
	buffer := make([]byte, 32<<10)
	defer body.Close()
	for {
		result := make(chan bodyReadResult, 1)
		go func() {
			n, err := body.Read(buffer)
			result <- bodyReadResult{data: append([]byte(nil), buffer[:n]...), err: err}
		}()
		var timer <-chan time.Time
		var deadline *time.Timer
		if stall > 0 {
			deadline = time.NewTimer(stall)
			timer = deadline.C
		}
		select {
		case <-ctx.Done():
			if deadline != nil {
				deadline.Stop()
			}
			_ = body.Close()
			return ctx.Err()
		case <-timer:
			_ = body.Close()
			return writeAnthropicStreamTail(writer, "timeout_error", fmt.Sprintf("anthropic passthrough body stalled: no upstream bytes for %s", stall), flusher)
		case read := <-result:
			if deadline != nil {
				deadline.Stop()
			}
			if len(read.data) > 0 {
				total += int64(len(read.data))
				if maxBytes > 0 && total > maxBytes {
					_ = body.Close()
					return writeAnthropicStreamTail(writer, "api_error", fmt.Sprintf("anthropic passthrough body exceeded %d bytes", maxBytes), flusher)
				}
				observer.Consume(read.data)
				if _, err := writer.Write(read.data); err != nil {
					return err
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if read.err != nil {
				observer.Finish()
				if errors.Is(read.err, io.EOF) {
					return nil
				}
				return read.err
			}
		}
	}
}

func writeAnthropicStreamTail(writer io.Writer, kind, message string, flusher http.Flusher) error {
	payload, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": kind, "message": message}})
	_, err := fmt.Fprintf(writer, "\n\nevent: error\ndata: %s\n\n", payload)
	if flusher != nil {
		flusher.Flush()
	}
	return err
}
