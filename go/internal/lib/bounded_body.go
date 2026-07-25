package lib

import (
	"bytes"
	"context"
	"io"
	"time"
)

const BoundedBodyMaxBytes = 65_536
const BoundedBodyTimeout = 5 * time.Second

type BoundedBodyOptions struct {
	TotalTimeout      time.Duration
	InactivityTimeout time.Duration
}

type BoundedBodyResult struct {
	Text               string
	Truncated          bool
	TimedOut           bool
	TotalTimedOut      bool
	InactivityTimedOut bool
	Oversized          bool
	DisplaySafe        bool
}

type bodyChunk struct {
	data []byte
	err  error
}

// ReadBoundedBody consumes an error body with independent wall-clock, silence,
// and memory bounds. Oversized prefixes are discarded and never display-safe.
func ReadBoundedBody(ctx context.Context, body io.ReadCloser, options BoundedBodyOptions) (BoundedBodyResult, error) {
	if err := ctx.Err(); err != nil {
		return BoundedBodyResult{}, err
	}
	if body == nil {
		return BoundedBodyResult{DisplaySafe: true}, nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	totalTimeout := options.TotalTimeout
	if totalTimeout <= 0 {
		totalTimeout = BoundedBodyTimeout
	}
	idleTimeout := options.InactivityTimeout
	if idleTimeout <= 0 {
		idleTimeout = BoundedBodyTimeout
	}
	total := time.NewTimer(totalTimeout)
	idle := time.NewTimer(idleTimeout)
	defer total.Stop()
	defer idle.Stop()
	chunks := make(chan bodyChunk, 1)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := body.Read(buf)
			chunk := bodyChunk{err: err}
			if n > 0 {
				chunk.data = append([]byte(nil), buf[:n]...)
			}
			select {
			case chunks <- chunk:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var retained bytes.Buffer
	closeBody := func() { _ = body.Close() }
	for {
		select {
		case <-ctx.Done():
			closeBody()
			return BoundedBodyResult{}, ctx.Err()
		case <-total.C:
			closeBody()
			return BoundedBodyResult{Text: retained.String(), Truncated: true, TimedOut: true, TotalTimedOut: true}, nil
		case <-idle.C:
			closeBody()
			return BoundedBodyResult{Text: retained.String(), Truncated: true, TimedOut: true, InactivityTimedOut: true}, nil
		case chunk := <-chunks:
			if len(chunk.data) > 0 {
				if retained.Len()+len(chunk.data) > BoundedBodyMaxBytes {
					closeBody()
					return BoundedBodyResult{Truncated: true, Oversized: true}, nil
				}
				_, _ = retained.Write(chunk.data)
				if !idle.Stop() {
					select {
					case <-idle.C:
					default:
					}
				}
				idle.Reset(idleTimeout)
			}
			if chunk.err == io.EOF {
				return BoundedBodyResult{Text: retained.String(), DisplaySafe: true}, nil
			}
			if chunk.err != nil {
				closeBody()
				return BoundedBodyResult{}, chunk.err
			}
		}
	}
}
