// Package images implements the opt-in image-generation bridge, ported from
// src/images/**.
//
// A model that cannot call a hosted image tool is instead offered a synthetic
// function tool. The proxy intercepts that call, runs the real generation, and
// feeds the result back, so the call is never relayed upstream.
package images

import (
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// ImageGenToolName is both the function name the model sees and the name the
// loop intercepts.
const ImageGenToolName = "image_gen"

// imageGenAliases are client-side spellings that CONFLICT with the synthetic
// tool.
//
// They are collected only to be stripped or replaced when a hosted entry is
// present. A request declaring one of these as an ordinary function, with no
// hosted image tool, is somebody else's tool and must be left alone.
var imageGenAliases = map[string]struct{}{
	"imagegen":         {},
	"generate_image":   {},
	"generateimage":    {},
	ImageGenToolName:   {},
	"image_generation": {},
}

// IsImageGenName reports whether a CALL targets the synthetic tool.
//
// Deliberately narrower than the alias set: only the two canonical spellings
// count, because a call arriving as `generate_image` came from a real client
// tool that the bridge replaced rather than from the synthetic one.
func IsImageGenName(name string) bool {
	lower := strings.ToLower(name)
	return lower == ImageGenToolName || lower == "image_generation"
}

func isImageGenClientAlias(name string) bool {
	_, found := imageGenAliases[strings.ToLower(name)]
	return found
}

// HostedImageGeneration is the result of scanning a request's tools.
type HostedImageGeneration struct {
	// ToolNames are every declared name that must be dropped or replaced.
	ToolNames []string
	// OriginalTool is the FIRST hosted entry, kept so its options can be
	// carried into the synthetic replacement.
	OriginalTool map[string]any
}

// ExtractHostedImageGeneration scans tools for hosted image-generation entries.
//
// An ordinary `type:"function"` tool NEVER activates the bridge by name alone.
// Doing so would hijack any unrelated tool that happens to be called
// `generate_image`, so a hosted entry has to be present first.
func ExtractHostedImageGeneration(tools []any) (HostedImageGeneration, bool) {
	hosted := false
	var original map[string]any
	for _, entry := range tools {
		tool, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if isHostedImageTool(tool) {
			hosted = true
			if original == nil {
				original = tool
			}
		}
	}
	if !hosted {
		return HostedImageGeneration{}, false
	}

	names := make([]string, 0, len(tools))
	seen := map[string]struct{}{}
	add := func(name string) {
		if name == "" {
			return
		}
		if _, duplicate := seen[name]; duplicate {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	for _, entry := range tools {
		tool, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if isHostedImageTool(tool) {
			// A hosted entry without an explicit name is identified by its
			// type, which is what the request actually carried.
			name, _ := tool["name"].(string)
			if name == "" {
				name, _ = tool["type"].(string)
			}
			add(name)
			continue
		}
		if kind, _ := tool["type"].(string); kind != "function" {
			continue
		}
		// Responses function tools are flat; the nested Chat Completions shape
		// is accepted too so a mixed client cannot slip an alias past this.
		name, _ := tool["name"].(string)
		if name == "" {
			if nested, ok := tool["function"].(map[string]any); ok {
				name, _ = nested["name"].(string)
			}
		}
		// Matched case-insensitively but recorded VERBATIM, because the caller
		// has to strip the exact name the request declared.
		if isImageGenClientAlias(name) {
			add(name)
		}
	}
	if len(names) == 0 {
		return HostedImageGeneration{}, false
	}
	return HostedImageGeneration{ToolNames: names, OriginalTool: original}, true
}

func isHostedImageTool(tool map[string]any) bool {
	kind, _ := tool["type"].(string)
	return kind == "image_generation" || kind == "image_gen"
}

// BuildImageTool is the synthetic function tool offered in place of the dropped
// hosted entry.
func BuildImageTool() types.Tool {
	return types.Tool{
		Name: ImageGenToolName,
		Description: "Generate an image from a text prompt. Returns absolute local filesystem path(s). " +
			"Use when the user asks to create or draw an image.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"prompt": map[string]any{
					"type":        "string",
					"description": "Detailed image generation prompt. Required.",
				},
				"n": map[string]any{"type": "integer", "minimum": 1, "maximum": 4},
			},
			"required": []any{"prompt"},
		},
		ImageGeneration: true,
	}
}
