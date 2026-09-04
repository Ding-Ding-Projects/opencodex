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

// IsImageGenName reports whether a CALL targets the synthetic tool.
//
// Deliberately narrower than the alias set used when SCANNING declarations:
// only the two canonical spellings count, because a call arriving as
// `generate_image` came from a real client tool the bridge replaced rather than
// from the synthetic one.
func IsImageGenName(name string) bool {
	lower := strings.ToLower(name)
	return lower == ImageGenToolName || lower == "image_generation"
}

// HostedImageGeneration is the hosted declaration a request carried. It lives
// in types so the parser can attach it without importing this package.
type HostedImageGeneration = types.HostedImageTools

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
