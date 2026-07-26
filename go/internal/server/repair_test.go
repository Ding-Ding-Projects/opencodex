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

func TestRepairResponsesItemIDsJoinsMultilineDataAndUsesExactEventAllowlist(t *testing.T) {
	input := "event: response.output_item.added\n" +
		"data: {\"type\":\"response.output_item.added\",\"output_index\":0,\n" +
		"data: \"item\":{\"type\":\"message\",\"id\":\"placeholder\"}}\n\n" +
		"event: vendor.output_text.delta.extra\n" +
		"data: {\"type\":\"vendor.output_text.delta.extra\",\"output_index\":0,\"item_id\":\"placeholder\"}\n\n"
	out, err := io.ReadAll(RepairResponsesItemIDsWithConfig(strings.NewReader(input), ResponsesItemIDRepairConfig{Message: []string{"placeholder"}}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if strings.Count(text, "data:") != 2 || !strings.Contains(text, `"id":"msg_ocx_`) {
		t.Fatalf("multiline payload was not repaired as one event:\n%s", text)
	}
	if !strings.Contains(text, `"item_id":"placeholder"`) {
		t.Fatalf("non-allowlisted event item_id changed:\n%s", text)
	}
}

func TestRepairResponsesItemIDsPreservesUnchangedMultilineData(t *testing.T) {
	input := "event: vendor.event\n" +
		"data: {\"type\":\"vendor.event\",\n" +
		"data: \"value\":true}\n\n"
	out, err := io.ReadAll(RepairResponsesItemIDsWithConfig(strings.NewReader(input), ResponsesItemIDRepairConfig{Message: []string{"placeholder"}}))
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != input {
		t.Fatalf("unchanged multiline event lost byte shape:\n got: %q\nwant: %q", out, input)
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
