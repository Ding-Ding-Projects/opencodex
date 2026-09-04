package search

import (
	"fmt"
	"strings"
	"testing"
)

func BenchmarkParseOpenAISSEChunkedText(b *testing.B) {
	// Apple M5 Pro: concatenation baseline 74,124,867 B/op and 36,923
	// allocs/op; strings.Builder 2,206,770 B/op and 34,881 allocs/op.
	const chunks = 2_048
	const text = "abcdefghijklmnopqrstuvwxyz012345"
	var stream strings.Builder
	for index := 0; index < chunks; index++ {
		fmt.Fprintf(&stream, "data: {\"type\":\"response.output_text.delta\",\"delta\":%q}\n\n", text)
	}
	stream.WriteString("data: [DONE]\n\n")
	payload := stream.String()
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		result, err := ParseOpenAISSE(strings.NewReader(payload))
		if err != nil {
			b.Fatal(err)
		}
		if len(result.Text) != chunks*len(text) {
			b.Fatalf("text bytes = %d", len(result.Text))
		}
	}
}
