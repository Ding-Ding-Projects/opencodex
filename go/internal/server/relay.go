package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
)

type RelayRetryClass string

const (
	RelayRetryNone            RelayRetryClass = "none"
	RelayRetryTransientHTTP   RelayRetryClass = "transient_http"
	RelayRetryConnectionReset RelayRetryClass = "connection_reset"
)

// ClassifyRelayRetry permits replay only before any response bytes are
// committed and only when the request body can be rebuilt. Mid-stream failures
// receive a synthetic terminal tail instead of a duplicate upstream send.
func ClassifyRelayRetry(status int, err error, committed, replayable bool, elapsed time.Duration) RelayRetryClass {
	if committed || !replayable || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return RelayRetryNone
	}
	if elapsed > 15*time.Second {
		return RelayRetryNone
	}
	if err != nil {
		if ocxlib.IsConnectionResetError(err) {
			return RelayRetryConnectionReset
		}
		return RelayRetryNone
	}
	if ocxlib.IsTransientUpstreamStatus(status) {
		return RelayRetryTransientHTTP
	}
	return RelayRetryNone
}

type RelayOptions struct {
	Heartbeat time.Duration
	QueueSize int
	Inspector *SSEInspector
}

type relayChunk struct {
	data []byte
	err  error
}

// RelaySSE eagerly reads upstream into a bounded queue and forwards it with idle heartbeats.
func RelaySSE(ctx context.Context, w http.ResponseWriter, upstream io.ReadCloser, options RelayOptions) error {
	defer upstream.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if options.Heartbeat <= 0 {
		options.Heartbeat = 15 * time.Second
	}
	if options.QueueSize <= 0 {
		options.QueueSize = 16
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	queue := make(chan relayChunk, options.QueueSize)
	go func() {
		defer close(queue)
		buffer := make([]byte, 32<<10)
		for {
			n, err := upstream.Read(buffer)
			if n > 0 {
				chunk := append([]byte(nil), buffer[:n]...)
				select {
				case queue <- relayChunk{data: chunk}:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					select {
					case queue <- relayChunk{err: err}:
					case <-ctx.Done():
					}
				}
				return
			}
		}
	}()
	ticker := time.NewTicker(options.Heartbeat)
	defer ticker.Stop()
	inspector := options.Inspector
	if inspector == nil {
		inspector = NewSSEInspector(SSEInspectorHandlers{})
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if _, err := io.WriteString(w, ": opencodex keepalive\n\n"); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
		case chunk, ok := <-queue:
			if !ok {
				inspector.Finish()
				if !inspector.TerminalSeen() {
					if err := WriteIncompleteTail(w, "upstream stream ended before a terminal event"); err != nil {
						return err
					}
					if flusher != nil {
						flusher.Flush()
					}
				}
				return nil
			}
			if chunk.err != nil {
				if !inspector.TerminalSeen() {
					_ = WriteFailureTail(w, http.StatusBadGateway, chunk.err.Error())
				}
				if flusher != nil {
					flusher.Flush()
				}
				return chunk.err
			}
			inspector.Consume(chunk.data)
			if _, err := w.Write(chunk.data); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

// WriteIncompleteTail converts a clean but premature EOF into an explicit
// Responses terminal so clients never mistake truncation for completion.
func WriteIncompleteTail(w io.Writer, message string) error {
	payload := map[string]any{"type": "response.incomplete", "response": map[string]any{"status": "incomplete", "incomplete_details": map[string]any{"reason": message}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: response.incomplete\ndata: %s\n\ndata: [DONE]\n\n", encoded)
	return err
}

// WriteFailureTail writes a valid Responses terminal followed by [DONE].
func WriteFailureTail(w io.Writer, status int, message string) error {
	payload := map[string]any{"type": "response.failed", "response": map[string]any{"status": "failed", "error": map[string]any{"type": "server_error", "code": status, "message": message}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: response.failed\ndata: %s\n\ndata: [DONE]\n\n", encoded)
	return err
}
