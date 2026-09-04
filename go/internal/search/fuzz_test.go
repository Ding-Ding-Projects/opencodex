package search

import (
	"bytes"
	"testing"
)

func FuzzSearchSSEParsers(f *testing.F) {
	for _, seed := range []string{
		"",
		"data: {broken\n\n",
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"가🌍나\"}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"가🌍나\"}}\n\n",
	} {
		f.Add([]byte(seed), false)
		f.Add([]byte(seed), true)
	}
	f.Fuzz(func(t *testing.T, data []byte, anthropic bool) {
		if len(data) > 512<<10 {
			t.Skip()
		}
		if anthropic {
			_, _ = ParseAnthropicSSE(bytes.NewReader(data))
		} else {
			_, _ = ParseOpenAISSE(bytes.NewReader(data))
		}
	})
}

func TestSearchLinearizationPreservesOrderAndPriority(t *testing.T) {
	stream := []byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"delta-가\"}\n\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"🌍-delta\"}\n\n" +
		"data: {\"type\":\"response.output_text.done\",\"text\":\"done-가\"}\n\n" +
		"data: {\"type\":\"response.output_text.done\",\"text\":\"🌍-done\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"final-가\"},{\"type\":\"output_text\",\"text\":\"🌍-final\"}]}]}}\n\n")
	result, err := ParseOpenAISSE(bytes.NewReader(stream))
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "final-가🌍-final" {
		t.Fatalf("completed output priority/order changed: %q", result.Text)
	}
}
