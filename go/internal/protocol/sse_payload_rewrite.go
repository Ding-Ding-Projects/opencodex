package protocol

// Shared client-facing SSE payload rewrite shell, ported from
// src/server/sse-payload-rewrite.ts.
//
// Several opt-in transforms (image-gen namespace restore, item-id repair) have
// to share ONE parse and serialize pass. Wrapping the stream once per transform
// would re-frame every event as many times as there are transforms, which is
// what this file exists to prevent.

import (
	"bufio"
	"io"
	"strings"
)

// SSEPayloadRewrite transforms one event's joined data payload.
type SSEPayloadRewrite func(payload string) string

// SSEBlock is one complete event with the delimiter that terminated it.
type SSEBlock struct {
	Block     string
	Delimiter string
	Rest      string
}

// NextSSEBlock splits one complete event, RETAINING its original blank-line
// delimiter so a CRLF stream stays CRLF on the way out.
func NextSSEBlock(buffer string) (SSEBlock, bool) {
	index, delimiter := sseDelimiterIndex(buffer)
	if index < 0 {
		return SSEBlock{}, false
	}
	return SSEBlock{
		Block:     buffer[:index],
		Delimiter: delimiter,
		Rest:      buffer[index+len(delimiter):],
	}, true
}

// sseDelimiterIndex finds the earliest blank-line delimiter, matching the
// oracle's /\r?\n\r?\n/ which accepts mixed newline styles within one break.
func sseDelimiterIndex(buffer string) (int, string) {
	best, bestDelimiter := -1, ""
	for _, candidate := range []string{"\r\n\r\n", "\r\n\n", "\n\r\n", "\n\n"} {
		if at := strings.Index(buffer, candidate); at >= 0 {
			// Earliest wins; on a tie the LONGER delimiter wins, because a
			// shorter one would be a prefix that leaves stray newlines in the
			// next block.
			if best < 0 || at < best || (at == best && len(candidate) > len(bestDelimiter)) {
				best, bestDelimiter = at, candidate
			}
		}
	}
	return best, bestDelimiter
}

// SSEDataPayload joins every data line per the event-stream field rules.
//
// Returns ok=false when the block carries no data field at all, which is
// different from a bare "data:" yielding an empty payload: the first must be
// left alone, the second is a real empty message.
func SSEDataPayload(block string) (string, bool) {
	var data []string
	for _, line := range splitSSELines(block) {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		value := line[len("data:"):]
		// Exactly one leading space is stripped, so "data:  x" keeps a space.
		value = strings.TrimPrefix(value, " ")
		data = append(data, value)
	}
	if len(data) == 0 {
		return "", false
	}
	return strings.Join(data, "\n"), true
}

// ReplaceSSEDataPayload rewrites the data field while preserving every other
// field and the block's newline style.
//
// Multiple data lines collapse into ONE, because the payload the rewrite saw
// was their join and re-splitting it would guess at the original boundaries.
func ReplaceSSEDataPayload(block, payload string) string {
	newline := "\n"
	if strings.Contains(block, "\r\n") {
		newline = "\r\n"
	}
	lines := splitSSELines(block)
	rewritten := make([]string, 0, len(lines))
	replaced := false
	for _, line := range lines {
		if !strings.HasPrefix(line, "data:") {
			rewritten = append(rewritten, line)
			continue
		}
		if !replaced {
			rewritten = append(rewritten, "data: "+payload)
			replaced = true
		}
	}
	if !replaced {
		return block
	}
	return strings.Join(rewritten, newline)
}

func splitSSELines(block string) []string {
	normalized := strings.ReplaceAll(block, "\r\n", "\n")
	return strings.Split(normalized, "\n")
}

// ComposeSSEPayloadRewrites applies rewrites left to right; an empty list is
// the identity, so a caller with no active transforms costs nothing.
func ComposeSSEPayloadRewrites(rewrites ...SSEPayloadRewrite) SSEPayloadRewrite {
	active := make([]SSEPayloadRewrite, 0, len(rewrites))
	for _, rewrite := range rewrites {
		if rewrite != nil {
			active = append(active, rewrite)
		}
	}
	if len(active) == 0 {
		return func(payload string) string { return payload }
	}
	if len(active) == 1 {
		return active[0]
	}
	return func(payload string) string {
		for _, rewrite := range active {
			payload = rewrite(payload)
		}
		return payload
	}
}

// RelaySSEWithPayloadRewrite streams the body through a single pass, rewriting
// each event's data payload in place.
//
// Framing and non-data fields are preserved, and a payload the rewrite leaves
// untouched is emitted as the ORIGINAL bytes rather than a re-serialized copy,
// so an unchanged event cannot be reshaped by passing through here.
//
// Closing the returned reader closes the upstream body when it is an
// io.ReadCloser, which unblocks the pump. A plain io.Reader that blocks forever
// cannot be interrupted from here, so callers passing one must cancel it
// themselves; every production caller hands over an http.Response.Body.
func RelaySSEWithPayloadRewrite(body io.Reader, rewrite SSEPayloadRewrite) io.ReadCloser {
	if rewrite == nil {
		rewrite = func(payload string) string { return payload }
	}
	reader, writer := io.Pipe()
	go func() {
		defer func() { _ = writer.Close() }()
		var buffer strings.Builder
		source := bufio.NewReader(body)
		chunk := make([]byte, 16*1024)
		emit := func(flushFinal bool) error {
			for {
				next, ok := NextSSEBlock(buffer.String())
				if !ok {
					break
				}
				rest := next.Rest
				buffer.Reset()
				buffer.WriteString(rest)
				if _, err := io.WriteString(writer, rewriteSSEBlock(next.Block, rewrite)+next.Delimiter); err != nil {
					return err
				}
			}
			if flushFinal && buffer.Len() > 0 {
				// The upstream ended without a trailing blank line. Dropping
				// this would silently truncate the last event.
				tail := buffer.String()
				buffer.Reset()
				if _, err := io.WriteString(writer, rewriteSSEBlock(tail, rewrite)); err != nil {
					return err
				}
			}
			return nil
		}
		for {
			read, err := source.Read(chunk)
			if read > 0 {
				buffer.Write(chunk[:read])
				if emitErr := emit(false); emitErr != nil {
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					_ = emit(true)
					return
				}
				_ = emit(true)
				_ = writer.CloseWithError(err)
				return
			}
		}
	}()
	return &rewriteRelay{reader: reader, source: body}
}

func rewriteSSEBlock(block string, rewrite SSEPayloadRewrite) string {
	payload, ok := SSEDataPayload(block)
	// An EMPTY payload is skipped, not rewritten. The oracle gates on
	// `payload ? rewrite(payload) : undefined`, so a bare `data:` keep-alive is
	// left alone; rewriting it would put content into an event the upstream
	// deliberately sent empty.
	if !ok || payload == "" {
		return block
	}
	rewritten := rewrite(payload)
	if rewritten == payload {
		return block
	}
	return ReplaceSSEDataPayload(block, rewritten)
}

// rewriteRelay propagates Close to the upstream body so a cancelled client
// does not leave the provider connection open.
type rewriteRelay struct {
	reader *io.PipeReader
	source io.Reader
}

func (r *rewriteRelay) Read(p []byte) (int, error) { return r.reader.Read(p) }

func (r *rewriteRelay) Close() error {
	err := r.reader.Close()
	if closer, ok := r.source.(io.Closer); ok {
		if closeErr := closer.Close(); err == nil {
			err = closeErr
		}
	}
	return err
}
