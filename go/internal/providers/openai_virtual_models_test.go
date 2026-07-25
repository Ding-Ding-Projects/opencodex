package providers

import "testing"

func TestApplyOpenAIVirtualModel(t *testing.T) {
	parsed := &VirtualRequest{ModelID: "gpt-5.6-sol-pro", RawBody: map[string]any{"reasoning": map[string]any{"effort": "high"}}}
	route := &RouteResult{ProviderName: OpenAIAPIProviderID, ModelID: parsed.ModelID}
	log := &RequestLogContext{}
	r, ok, err := ApplyOpenAIVirtualModel(parsed, route, log)
	if err != nil || !ok || r.WireModelID != "gpt-5.6-sol" || parsed.RawBody["model"] != "gpt-5.6-sol" {
		t.Fatalf("%#v %v %v", r, ok, err)
	}
	reason := parsed.RawBody["reasoning"].(map[string]any)
	if reason["mode"] != "pro" || reason["effort"] != "high" {
		t.Fatal(reason)
	}
}
func TestRejectInvalidVirtualDefinition(t *testing.T) {
	_, err := ValidateOpenAIVirtualModelDefinition("x", VirtualModelDefinition{WireModelID: " x", ReasoningMode: "pro"})
	if err == nil {
		t.Fatal("expected validation error")
	}
}
