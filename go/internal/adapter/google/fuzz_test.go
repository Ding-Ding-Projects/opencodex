package google

import (
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func FuzzGoogleSSEChunking(f *testing.F) {
	for _, seed := range []string{
		"",
		"data: {\"text\":\"안녕 🌍\"}\n\n",
		": keepalive\r\ndata: first\ndata: second\n",
		"data: unterminated",
	} {
		f.Add([]byte(seed), uint16(1))
	}
	f.Fuzz(func(t *testing.T, data []byte, chunkSize uint16) {
		if len(data) > 512<<10 {
			t.Skip()
		}
		wholeResult, wholePayloads, wholeErr := scanSSEForFuzz(strings.NewReader(string(data)))
		chunk := int(chunkSize)%257 + 1
		chunkedResult, chunkedPayloads, chunkedErr := scanSSEForFuzz(&fuzzChunkReader{data: data, chunk: chunk})
		if !sameError(wholeErr, chunkedErr) || !reflect.DeepEqual(wholeResult, chunkedResult) || !reflect.DeepEqual(wholePayloads, chunkedPayloads) {
			t.Fatalf("chunking changed scan: whole=%#v/%#v/%v chunked=%#v/%#v/%v", wholeResult, wholePayloads, wholeErr, chunkedResult, chunkedPayloads, chunkedErr)
		}
	})
}

func scanSSEForFuzz(reader io.Reader) (scanSSEResult, []string, error) {
	var payloads []string
	result, err := scanSSE(reader, func(payload string) scanSSEAction {
		payloads = append(payloads, payload)
		return scanSSEContinue
	}, func() bool { return true })
	return result, payloads, err
}

type fuzzChunkReader struct {
	data  []byte
	chunk int
}

func (reader *fuzzChunkReader) Read(target []byte) (int, error) {
	if len(reader.data) == 0 {
		return 0, io.EOF
	}
	count := min(len(target), reader.chunk, len(reader.data))
	copy(target, reader.data[:count])
	reader.data = reader.data[count:]
	return count, nil
}

func sameError(left, right error) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && errors.Is(left, right)) || (left != nil && right != nil && left.Error() == right.Error())
}

func FuzzOwnedGoogleCompilerParity(f *testing.F) {
	for _, seed := range []string{
		`{}`,
		`{"contents":[{"role":"model","parts":[{"functionCall":{"name":"bad.tool","args":{"x":"🌍"}}}]}],"tools":[{"functionDeclarations":[{"name":"bad.tool","parameters":{"type":"object"}}]}]}`,
		`{"contents":[null,42,{"parts":[null,{"functionResponse":{"name":"도구","response":{}}}]}]}`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256<<10 {
			t.Skip()
		}
		var copyingInput, ownedInput map[string]any
		if json.Unmarshal(raw, &copyingInput) != nil || json.Unmarshal(raw, &ownedInput) != nil {
			return
		}
		copying := CompileGoogleWireBody(copyingInput)
		owned := compileOwnedGoogleWireBody(ownedInput)
		copyingJSON, copyingErr := json.Marshal(copying.Body)
		ownedJSON, ownedErr := json.Marshal(owned.Body)
		if copyingErr != nil || ownedErr != nil || string(copyingJSON) != string(ownedJSON) {
			t.Fatalf("owned compiler changed wire body: copying=%s/%v owned=%s/%v", copyingJSON, copyingErr, ownedJSON, ownedErr)
		}
		for _, name := range collectToolNames(copying.Body) {
			if copying.RestoreToolName(name) != owned.RestoreToolName(name) {
				t.Fatalf("restore mapping differs for %q", name)
			}
		}
	})
}

func TestGoogleSSERejectsLineAboveMaximum(t *testing.T) {
	payload := "data: " + strings.Repeat("x", 8<<20) + "\n"
	if _, err := scanSSE(strings.NewReader(payload), func(string) scanSSEAction { return scanSSEContinue }, func() bool { return true }); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized SSE line error = %v", err)
	}
}
