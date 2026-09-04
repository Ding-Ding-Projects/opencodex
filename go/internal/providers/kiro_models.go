package providers

import (
	"regexp"
	"strings"
)

var KiroModels = []string{"kiro-auto", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-sonnet-5", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-opus-4.5", "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4.0", "claude-haiku-4.5", "deepseek-3.2", "minimax-m2.5", "minimax-m2.1", "glm-5", "qwen3-coder-next"}
var KiroModelContextWindows = map[string]int{"gpt-5.6-sol": 272000, "gpt-5.6-terra": 272000, "gpt-5.6-luna": 272000, "claude-sonnet-5": 1000000, "claude-opus-5": 1000000, "claude-opus-4.8": 1000000, "claude-opus-4.7": 1000000, "claude-opus-4.6": 1000000, "claude-opus-4.5": 200000, "claude-sonnet-4.6": 1000000, "claude-sonnet-4.5": 200000, "claude-sonnet-4.0": 200000, "claude-haiku-4.5": 200000, "deepseek-3.2": 128000, "minimax-m2.5": 200000, "minimax-m2.1": 200000, "glm-5": 200000, "qwen3-coder-next": 256000}
var KiroModelReasoningEfforts = func() map[string][]string {
	o := map[string][]string{}
	for _, id := range KiroModels {
		o[id] = []string{"low", "medium", "high", "xhigh", "max"}
	}
	return o
}()
var kiroDate = regexp.MustCompile(`-\d{8}$`)
var kiroEffort = regexp.MustCompile(`-(low|medium|high|xhigh|max)$`)
var kiroVersion = regexp.MustCompile(`(\d+)-(\d+)`)
var kiroClaude = regexp.MustCompile(`^claude-([\d.]+)-(sonnet|opus|haiku)$`)

func NormalizeKiroModelID(id string) string {
	model := strings.ToLower(strings.TrimSpace(id))
	model = strings.TrimPrefix(model, "kiro/")
	model = strings.TrimPrefix(model, "kiro-")
	if model == "auto" {
		return "auto"
	}
	model = kiroDate.ReplaceAllString(model, "")
	model = kiroEffort.ReplaceAllString(model, "")
	model = kiroVersion.ReplaceAllString(model, "$1.$2")
	model = kiroClaude.ReplaceAllString(model, "claude-$2-$1")
	return model
}
