package server

import (
	"encoding/json"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// RequestHasInlineImage reports whether a normalized request contains a data URL image.
func RequestHasInlineImage(request *types.NormalizedRequest) bool {
	if request == nil {
		return false
	}
	for _, message := range request.Context.Messages {
		var content []map[string]any
		if json.Unmarshal(message.Content, &content) != nil {
			continue
		}
		for _, part := range content {
			for _, key := range []string{"imageUrl", "image_url", "url"} {
				if value, ok := part[key].(string); ok && strings.HasPrefix(value, "data:") {
					return true
				}
			}
		}
	}
	return false
}

// ShouldAttemptImageTierRetry permits one Anthropic 413 rebuild when lowering
// the inline-image tier can materially shrink the request.
func ShouldAttemptImageTierRetry(status int, adapterName string, request *types.NormalizedRequest, alreadyAttempted bool) bool {
	return status == 413 && !alreadyAttempted && adapterName == "anthropic" && RequestHasInlineImage(request)
}
