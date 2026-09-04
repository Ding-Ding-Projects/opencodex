package server

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// ApplyAnthropicImageTierRetry lowers every inline image by one normalization
// tier in the normalized request. The next adapter BuildRequest therefore sees
// a materially smaller request instead of repeating the rejected payload.
func ApplyAnthropicImageTierRetry(request *types.NormalizedRequest) error {
	if request == nil {
		return fmt.Errorf("normalized request is nil")
	}
	for messageIndex := range request.Context.Messages {
		var parts []map[string]any
		if json.Unmarshal(request.Context.Messages[messageIndex].Content, &parts) != nil {
			continue
		}
		changed := false
		targets := make([]anthropic.NormalizeTarget, 0)
		for partIndex := range parts {
			index := partIndex
			key, raw := inlineImageField(parts[index])
			if key == "" {
				continue
			}
			mediaType, data, ok := splitDataURL(raw)
			if !ok {
				continue
			}
			targets = append(targets, anthropic.NormalizeTarget{
				Base64: data, MediaType: mediaType,
				Replace: func(next, nextMedia string) error {
					parts[index][key] = "data:" + nextMedia + ";base64," + next
					changed = true
					return nil
				},
				Drop: func(note string) error {
					parts[index] = map[string]any{"type": "text", "text": note}
					changed = true
					return nil
				},
			})
		}
		if err := anthropic.NormalizeImageTargets(targets, anthropic.NormalizeOptions{TierBias: 1, OverflowAction: anthropic.OverflowKeep}); err != nil {
			return err
		}
		if changed {
			encoded, err := json.Marshal(parts)
			if err != nil {
				return err
			}
			request.Context.Messages[messageIndex].Content = encoded
		}
	}
	return nil
}

func inlineImageField(part map[string]any) (string, string) {
	for _, key := range []string{"imageUrl", "image_url", "url"} {
		if value, ok := part[key].(string); ok && strings.HasPrefix(value, "data:") {
			return key, value
		}
	}
	return "", ""
}

func splitDataURL(value string) (string, string, bool) {
	header, data, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") || data == "" {
		return "", "", false
	}
	return strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64"), data, true
}
