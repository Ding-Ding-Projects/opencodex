package providers

import (
	"fmt"
	"strings"
)

type OpenAIVirtualModelResolution struct{ SelectedModelID, WireModelID, ReasoningMode string }
type InvalidOpenAIVirtualModelRegistryError struct{ SelectedModelID string }

func (e *InvalidOpenAIVirtualModelRegistryError) Error() string {
	return fmt.Sprintf("invalid OpenAI virtual model registry definition: %s", e.SelectedModelID)
}
func ValidateOpenAIVirtualModelDefinition(selected string, def VirtualModelDefinition) (OpenAIVirtualModelResolution, error) {
	if def.WireModelID == "" || strings.TrimSpace(def.WireModelID) != def.WireModelID || strings.Contains(def.WireModelID, "/") || def.WireModelID == selected || def.ReasoningMode != "pro" {
		return OpenAIVirtualModelResolution{}, &InvalidOpenAIVirtualModelRegistryError{selected}
	}
	return OpenAIVirtualModelResolution{selected, def.WireModelID, "pro"}, nil
}
func ResolveOpenAIVirtualModel(provider, selected string) (OpenAIVirtualModelResolution, bool, error) {
	if provider != OpenAIAPIProviderID {
		return OpenAIVirtualModelResolution{}, false, nil
	}
	e, ok := GetProviderRegistryEntry(OpenAIAPIProviderID)
	if !ok {
		return OpenAIVirtualModelResolution{}, false, nil
	}
	def, ok := e.VirtualModels[selected]
	if !ok {
		return OpenAIVirtualModelResolution{}, false, nil
	}
	r, err := ValidateOpenAIVirtualModelDefinition(selected, def)
	return r, true, err
}

type VirtualRequest struct {
	ModelID string
	RawBody map[string]any
}
type RouteResult struct{ ProviderName, ModelID string }
type RequestLogContext struct{ Model, ResolvedModel string }

func ApplyOpenAIVirtualModel(parsed *VirtualRequest, route *RouteResult, log *RequestLogContext) (OpenAIVirtualModelResolution, bool, error) {
	selected := route.ModelID
	if log.Model != "" && log.Model != route.ModelID {
		selected = log.Model
	}
	r, ok, err := ResolveOpenAIVirtualModel(route.ProviderName, selected)
	if err != nil || !ok {
		return r, ok, err
	}
	log.Model, log.ResolvedModel = r.SelectedModelID, r.WireModelID
	route.ModelID = r.WireModelID
	parsed.ModelID = r.WireModelID
	if parsed.RawBody != nil {
		parsed.RawBody["model"] = r.WireModelID
		reasoning, _ := parsed.RawBody["reasoning"].(map[string]any)
		if reasoning == nil {
			reasoning = map[string]any{}
		}
		reasoning["mode"] = r.ReasoningMode
		parsed.RawBody["reasoning"] = reasoning
	}
	return r, true, nil
}
func ResolveOpenAICompactModel(provider, selected string) (OpenAIVirtualModelResolution, bool, error) {
	return ResolveOpenAIVirtualModel(provider, selected)
}
