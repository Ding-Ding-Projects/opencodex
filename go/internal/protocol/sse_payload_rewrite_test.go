package protocol

// Differential against src/server/sse-payload-rewrite.ts. Every expectation was
// captured by RUNNING the oracle through a throwaway bun harness.

import (
	"io"
	"strings"
	"testing"
)

func TestNextSSEBlockMatchesTheOracle(t *testing.T) {
	block, ok := NextSSEBlock("data: a\n\ndata: b\n\n")
	if !ok || block.Block != "data: a" || block.Delimiter != "\n\n" || block.Rest != "data: b\n\n" {
		t.Fatalf("plain split = %#v ok=%v", block, ok)
	}
	// The delimiter is carried through verbatim, so a CRLF stream stays CRLF.
	crlf, ok := NextSSEBlock("data: a\r\n\r\nrest")
	if !ok || crlf.Block != "data: a" || crlf.Delimiter != "\r\n\r\n" || crlf.Rest != "rest" {
		t.Fatalf("crlf split = %#v ok=%v", crlf, ok)
	}
	if _, ok := NextSSEBlock("data: a\n"); ok {
		t.Fatal("an unterminated buffer reported a complete block")
	}
}

func TestSSEDataPayloadMatchesTheOracle(t *testing.T) {
	if got, ok := SSEDataPayload("event: x\ndata: one\ndata: two\nid: 5"); !ok || got != "one\ntwo" {
		t.Fatalf("multi-line = %q ok=%v, oracle joins with a newline", got, ok)
	}
	// Exactly one leading space is stripped.
	if got, ok := SSEDataPayload("data:tight"); !ok || got != "tight" {
		t.Fatalf("no-space = %q ok=%v", got, ok)
	}
	if got, ok := SSEDataPayload("data:  wide"); !ok || got != " wide" {
		t.Fatalf("double-space = %q ok=%v, only ONE space is stripped", got, ok)
	}
	// No data field at all is different from an empty data field: the first
	// must pass through untouched, the second is a real empty message.
	if _, ok := SSEDataPayload("event: ping\nid: 3"); ok {
		t.Fatal("a block with no data field reported a payload")
	}
	if got, ok := SSEDataPayload("data:"); !ok || got != "" {
		t.Fatalf("bare data = %q ok=%v, oracle returns an empty payload", got, ok)
	}
}

func TestReplaceSSEDataPayloadMatchesTheOracle(t *testing.T) {
	// Multiple data lines collapse into one; the payload the rewrite saw was
	// their join, so re-splitting it would be guesswork.
	if got := ReplaceSSEDataPayload("event: x\ndata: one\ndata: two\nid: 5", "NEW"); got != "event: x\ndata: NEW\nid: 5" {
		t.Fatalf("multi-line replace = %q", got)
	}
	if got := ReplaceSSEDataPayload("event: x\r\ndata: one\r\nid: 5", "NEW"); got != "event: x\r\ndata: NEW\r\nid: 5" {
		t.Fatalf("crlf replace = %q, oracle keeps CRLF", got)
	}
	if got := ReplaceSSEDataPayload("event: ping", "NEW"); got != "event: ping" {
		t.Fatalf("no-data replace = %q, oracle returns the block unchanged", got)
	}
}

func TestComposeSSEPayloadRewritesMatchesTheOracle(t *testing.T) {
	if got := ComposeSSEPayloadRewrites()("keep"); got != "keep" {
		t.Fatalf("empty compose = %q, oracle is the identity", got)
	}
	composed := ComposeSSEPayloadRewrites(
		func(payload string) string { return payload + "-a" },
		func(payload string) string { return payload + "-b" },
	)
	if got := composed("x"); got != "x-a-b" {
		t.Fatalf("compose order = %q, oracle applies left to right", got)
	}
}

func drainRelay(t *testing.T, input string, rewrite SSEPayloadRewrite) string {
	t.Helper()
	out, err := io.ReadAll(RelaySSEWithPayloadRewrite(strings.NewReader(input), rewrite))
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// Oracle R1: framing survives a mixed LF/CRLF stream and an unterminated tail
// is flushed rather than dropped, which would silently truncate the last event.
func TestRelayPreservesFramingAndFlushesTheTail(t *testing.T) {
	var seen []string
	got := drainRelay(t,
		"event: a\ndata: {\"v\":1}\n\nevent: b\r\ndata: {\"v\":2}\r\n\r\ndata: tail",
		func(payload string) string {
			seen = append(seen, payload)
			return strings.Replace(payload, "\"v\"", "\"w\"", 1)
		})
	want := "event: a\ndata: {\"w\":1}\n\nevent: b\r\ndata: {\"w\":2}\r\n\r\ndata: tail"
	if got != want {
		t.Fatalf("relay = %q, oracle returns %q", got, want)
	}
	if len(seen) != 3 || seen[0] != "{\"v\":1}" || seen[1] != "{\"v\":2}" || seen[2] != "tail" {
		t.Fatalf("payloads = %#v, oracle sees three including the tail", seen)
	}
}

// Oracle R2: an identity rewrite is byte-for-byte transparent.
func TestRelayIsTransparentUnderAnIdentityRewrite(t *testing.T) {
	input := "id: 7\nevent: ping\ndata: keep\n\n"
	if got := drainRelay(t, input, func(payload string) string { return payload }); got != input {
		t.Fatalf("identity relay = %q, want the input unchanged", got)
	}
}

// Oracle R3, the double-framing regression. Two composed rewrites over three
// events must be called six times and emit exactly one delimiter per event. A
// second stream wrapper would re-frame and this is what catches it.
func TestRelayFramesEachEventExactlyOnce(t *testing.T) {
	calls := 0
	composed := ComposeSSEPayloadRewrites(
		func(payload string) string { calls++; return payload },
		func(payload string) string { calls++; return payload },
	)
	input := "data: 1\n\ndata: 2\n\ndata: 3\n\n"
	got := drainRelay(t, input, composed)
	if got != input {
		t.Fatalf("relay = %q, oracle returns %q", got, input)
	}
	if calls != 6 {
		t.Fatalf("rewrite calls = %d, oracle calls two rewrites over three events", calls)
	}
	if strings.Count(got, "\n\n") != 3 {
		t.Fatalf("delimiters = %d, oracle emits exactly one per event", strings.Count(got, "\n\n"))
	}
}

// A payload the rewrite leaves alone is emitted as the ORIGINAL bytes, so an
// unchanged event cannot be reshaped merely by passing through the relay.
func TestRelayLeavesAnUnchangedBlockByteIdentical(t *testing.T) {
	input := "event: x\ndata: one\ndata: two\n\n"
	if got := drainRelay(t, input, func(payload string) string { return payload }); got != input {
		t.Fatalf("relay = %q, want the multi-line data preserved", got)
	}
	// The same block DOES collapse once the rewrite actually changes it.
	changed := drainRelay(t, input, func(payload string) string { return "NEW" })
	if changed != "event: x\ndata: NEW\n\n" {
		t.Fatalf("changed relay = %q", changed)
	}
}

// Chunk boundaries must not affect the output: an event split across reads is
// buffered until it is complete.
func TestRelayIsIndifferentToChunkBoundaries(t *testing.T) {
	full := "event: a\ndata: one\n\nevent: b\ndata: two\n\n"
	for split := 1; split < len(full); split++ {
		reader := io.MultiReader(strings.NewReader(full[:split]), strings.NewReader(full[split:]))
		out, err := io.ReadAll(RelaySSEWithPayloadRewrite(reader, func(payload string) string { return payload }))
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != full {
			t.Fatalf("split at %d produced %q", split, string(out))
		}
	}
}

// A bare `data:` keep-alive is left alone. The oracle gates the rewrite on a
// truthy payload, so an empty one is skipped; rewriting it would put content
// into an event the upstream deliberately sent empty.
func TestRelaySkipsAnEmptyDataPayload(t *testing.T) {
	got := drainRelay(t, "data:\n\n", func(string) string { return "changed" })
	if got != "data:\n\n" {
		t.Fatalf("bare data relay = %q, oracle leaves it unchanged", got)
	}
	// A non-empty payload in the same shape IS rewritten.
	if got := drainRelay(t, "data: x\n\n", func(string) string { return "changed" }); got != "data: changed\n\n" {
		t.Fatalf("non-empty relay = %q", got)
	}
}

// Closing the returned reader must close the upstream body, or a cancelled
// client would leave the provider connection open.
func TestRelayCloservePropagatesToTheUpstreamBody(t *testing.T) {
	source := &closeTrackingReader{Reader: strings.NewReader("data: a\n\n")}
	relay := RelaySSEWithPayloadRewrite(source, nil)
	if err := relay.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if !source.closed {
		t.Fatal("closing the relay did not close the upstream body")
	}
}

type closeTrackingReader struct {
	io.Reader
	closed bool
}

func (r *closeTrackingReader) Close() error {
	r.closed = true
	return nil
}
