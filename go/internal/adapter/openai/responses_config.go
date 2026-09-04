package openai

import (
	"encoding/base64"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

const (
	responsesCompactionPrefix = "ocx1:"
	responsesSummaryPrefix    = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"
	responsesCompactPrompt    = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`
)

func decodeResponsesCompactionSummary(value string) (string, bool) {
	if !strings.HasPrefix(value, responsesCompactionPrefix) {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, responsesCompactionPrefix))
	if err != nil {
		return "", false
	}
	return string(decoded), true
}

func scrubResponsesCompactionItems(body map[string]any) {
	input := sliceValue(body["input"])
	for index, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(item["type"]) {
		case "compaction", "compaction_summary", "context_compaction":
		default:
			continue
		}
		summary, ok := decodeResponsesCompactionSummary(stringValue(item["encrypted_content"]))
		if !ok {
			continue
		}
		input[index] = responsesInputTextMessage(responsesSummaryPrefix + "\n\n" + summary)
	}
}

func stripDisabledResponsesReasoningSummaries(body map[string]any, provider config.ProviderConfig, modelID string) {
	supported, configured := config.ModelRecordValue(provider.ModelSupportsReasoningSummaries, modelID)
	if !configured || supported {
		return
	}
	if stream, ok := body["stream_options"].(map[string]any); ok {
		delete(stream, "reasoning_summary_delivery")
		if len(stream) == 0 {
			delete(body, "stream_options")
		}
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		delete(reasoning, "summary")
		delete(reasoning, "generate_summary")
		if len(reasoning) == 0 {
			delete(body, "reasoning")
		}
	}
}

func buildRoutedResponsesCompactionBody(body map[string]any) {
	delete(body, "tools")
	delete(body, "tool_choice")
	delete(body, "parallel_tool_calls")
	kept := make([]any, 0)
	for _, raw := range sliceValue(body["input"]) {
		item, _ := raw.(map[string]any)
		typeName := stringValue(item["type"])
		if typeName == "compaction_trigger" || typeName == "additional_tools" {
			continue
		}
		kept = append(kept, stripResponsesInputImages(raw))
	}
	body["input"] = append(kept, responsesInputTextMessage(responsesCompactPrompt))
}

func stripResponsesInputImages(value any) any {
	switch current := value.(type) {
	case []any:
		out := make([]any, len(current))
		for index, child := range current {
			out[index] = stripResponsesInputImages(child)
		}
		return out
	case map[string]any:
		if current["type"] == "input_image" {
			return map[string]any{"type": "input_text", "text": "[image omitted for compaction]"}
		}
		out := make(map[string]any, len(current))
		for key, child := range current {
			out[key] = stripResponsesInputImages(child)
		}
		return out
	default:
		return value
	}
}

func responsesInputTextMessage(text string) map[string]any {
	return map[string]any{
		"type": "message", "role": "user",
		"content": []any{map[string]any{"type": "input_text", "text": text}},
	}
}

func isRoutedResponsesCompaction(provider config.ProviderConfig) bool {
	return !providers.IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL)
}
