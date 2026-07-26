package server

import (
	"io"
	"strings"
	"testing"
)

func TestRepairResponsesItemIDs(t *testing.T) {
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"bad\",\"delta\":\"x\"}\n\n"
	output, err := io.ReadAll(RepairResponsesItemIDs(strings.NewReader(input)))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), `"item_id":"bad"`) || !strings.Contains(string(output), `"id":"msg_ocx_`) {
		t.Fatalf("output = %s", output)
	}
}

func TestConfiguredResponsesItemIDRepairIsSelective(t *testing.T) {
	input := strings.Join([]string{
		`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"placeholder-message"}}`, "",
		`data: {"type":"response.output_text.delta","output_index":0,"item_id":"placeholder-message","delta":"x"}`, "",
		`data: {"type":"response.output_item.added","output_index":1,"item":{"type":"reasoning","id":"keep-reasoning"}}`, "",
		`data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"placeholder-message","call_id":"call_1"}}`, "",
	}, "\n")
	output, err := io.ReadAll(RepairResponsesItemIDsWithConfig(strings.NewReader(input), ResponsesItemIDRepairConfig{Message: []string{"placeholder-message"}}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(output)
	if strings.Contains(text, `"item_id":"placeholder-message"`) || !strings.Contains(text, `"id":"msg_ocx_`) {
		t.Fatalf("message placeholder not repaired: %s", text)
	}
	if !strings.Contains(text, `"id":"keep-reasoning"`) || !strings.Contains(text, `"call_id":"call_1"`) || strings.Count(text, `"id":"placeholder-message"`) != 1 {
		t.Fatalf("unrelated IDs changed: %s", text)
	}
}

func TestConfiguredRepairFillsMissingTerminalIDFromEarlierItem(t *testing.T) {
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_native\"}}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\"}]}}\n\n"
	output, err := io.ReadAll(RepairResponsesItemIDsWithConfig(strings.NewReader(input), ResponsesItemIDRepairConfig{RepairMissingTerminalIDs: true}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(output), `"id":"msg_native"`) != 2 {
		t.Fatalf("terminal ID not repaired: %s", output)
	}
}

func TestConfiguredRepairScopesCanonicalIDsPerStream(t *testing.T) {
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"same\"}}\n\n"
	config := ResponsesItemIDRepairConfig{Message: []string{"same"}}
	first, _ := io.ReadAll(RepairResponsesItemIDsWithConfig(strings.NewReader(input), config))
	second, _ := io.ReadAll(RepairResponsesItemIDsWithConfig(strings.NewReader(input), config))
	if string(first) == string(second) {
		t.Fatalf("separate streams reused synthetic ID: %s", first)
	}
}
