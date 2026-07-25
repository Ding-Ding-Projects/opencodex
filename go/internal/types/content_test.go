package types

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestContentPartRoundTrip(t *testing.T) {
	input := []ContentPart{
		TextPart("hello"),
		ImagePart("data:image/png;base64,AA==", "high"),
		ThinkingPart("considering", "sig"),
		ToolCallPart("call_1", "lookup", map[string]any{"q": "go"}),
	}
	raw, err := EncodeContentParts(input)
	if err != nil {
		t.Fatal(err)
	}
	text, parts, err := DecodeContent(raw)
	if err != nil || text != nil || len(parts) != len(input) {
		t.Fatalf("decoded text=%v parts=%#v err=%v", text, parts, err)
	}
	if parts[1].ImageURL != input[1].ImageURL || parts[3].Arguments["q"] != "go" {
		t.Fatalf("round trip = %#v", parts)
	}
}

func TestDecodeContentStringAndRejectsMalformedUnion(t *testing.T) {
	text, parts, err := DecodeContent(EncodeTextContent("hello"))
	if err != nil || text == nil || *text != "hello" || parts != nil {
		t.Fatalf("text=%v parts=%#v err=%v", text, parts, err)
	}
	for _, raw := range []string{
		`[{"type":"image"}]`,
		`[{"type":"toolCall","id":"call_1","name":"lookup"}]`,
		`[{"type":"unknown"}]`,
	} {
		if _, _, err := DecodeContent(json.RawMessage(raw)); err == nil {
			t.Fatalf("DecodeContent(%s) succeeded", raw)
		}
	}
}

func TestToolChoiceValidation(t *testing.T) {
	valid := []ToolChoice{
		{Mode: ToolChoiceAuto},
		{Name: "lookup"},
		{Mode: ToolChoiceRequired, AllowedTools: []string{"lookup"}},
	}
	for _, choice := range valid {
		if err := choice.Validate(); err != nil {
			t.Errorf("%#v: %v", choice, err)
		}
	}
	invalid := []ToolChoice{
		{},
		{Name: "lookup", Mode: ToolChoiceAuto},
		{Mode: ToolChoiceNone, AllowedTools: []string{"lookup"}},
	}
	for _, choice := range invalid {
		if err := choice.Validate(); err == nil || strings.TrimSpace(err.Error()) == "" {
			t.Errorf("%#v should fail", choice)
		}
	}
}
