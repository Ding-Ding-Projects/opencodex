package protocol

import (
	"bytes"
	"encoding/binary"
	"reflect"
	"strings"
	"testing"
)

func FuzzSSEDecoderChunking(f *testing.F) {
	for _, seed := range [][]byte{
		nil,
		[]byte("data: hello\n\n"),
		[]byte(": keepalive\r\nid: 7\nevent: delta\ndata: 안녕 🌍\ndata: second\n\n"),
		[]byte("data: unterminated"),
		[]byte("id: bad\x00id\nretry: 10\ndata:\n\n"),
	} {
		f.Add(seed, uint16(1), true)
	}
	f.Fuzz(func(t *testing.T, data []byte, chunkSize uint16, comments bool) {
		if len(data) > 256<<10 {
			t.Skip()
		}
		whole, wholeErr := decodeSSEForFuzz(data, len(data)+1, comments)
		chunk := int(chunkSize)%257 + 1
		chunked, chunkedErr := decodeSSEForFuzz(data, chunk, comments)
		if (wholeErr == nil) != (chunkedErr == nil) {
			t.Fatalf("close errors differ: whole=%v chunked=%v", wholeErr, chunkedErr)
		}
		if !reflect.DeepEqual(whole, chunked) {
			t.Fatalf("chunking changed events: whole=%#v chunked=%#v", whole, chunked)
		}
	})
}

func decodeSSEForFuzz(data []byte, chunkSize int, comments bool) ([]SSEEvent, error) {
	events := make(chan SSEEvent, len(data)+1)
	var decoder *SSEDecoder
	if comments {
		decoder = NewSSEDecoderWithComments(events)
	} else {
		decoder = NewSSEDecoder(events)
	}
	for offset := 0; offset < len(data); {
		end := min(len(data), offset+chunkSize)
		if _, err := decoder.Write(data[offset:end]); err != nil {
			return nil, err
		}
		offset = end
	}
	err := decoder.Close()
	close(events)
	return slicesFromChannel(events), err
}

func slicesFromChannel(events <-chan SSEEvent) []SSEEvent {
	var result []SSEEvent
	for event := range events {
		result = append(result, event)
	}
	return result
}

func FuzzSmithyDecoder(f *testing.F) {
	var valid bytes.Buffer
	_ = EncodeSmithyFrame(&valid, &SmithyFrame{
		Headers: map[string]SmithyHeaderValue{"kind": {Type: SmithyHeaderString, Value: "이벤트"}},
		Payload: []byte("payload 🌍"),
	})
	f.Add([]byte{})
	f.Add(valid.Bytes())
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 1<<20 {
			t.Skip()
		}
		decoded, err := DecodeSmithyFrame(bytes.NewReader(data))
		if err != nil {
			return
		}
		var encoded bytes.Buffer
		if err := EncodeSmithyFrame(&encoded, decoded); err != nil {
			t.Fatalf("accepted frame cannot be encoded: %v", err)
		}
		roundTrip, err := DecodeSmithyFrame(&encoded)
		if err != nil || !reflect.DeepEqual(decoded, roundTrip) {
			t.Fatalf("round trip changed frame: decoded=%#v roundTrip=%#v err=%v", decoded, roundTrip, err)
		}
	})
}

func TestSmithyDecoderRejectsDeclaredMaximumWithoutAllocating(t *testing.T) {
	prelude := make([]byte, smithyPreludeBlock)
	binary.BigEndian.PutUint32(prelude[:4], smithyMaxFrameLen+1)
	if _, err := DecodeSmithyFrame(bytes.NewReader(prelude)); err == nil || !strings.Contains(err.Error(), "exceeds maximum") {
		t.Fatalf("oversized frame error = %v", err)
	}
}
