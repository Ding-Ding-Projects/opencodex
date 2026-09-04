package lib

import (
	"math"
	"strings"
	"unicode"
)

const (
	defaultCharsPerToken = 4.0
	kiroCharsPerToken    = 3.5
	cjkCharsPerToken     = 2.5
	cjkRatioThreshold    = 0.3
)

var kiroModelPrefixes = []string{"kiro", "claude", "deepseek", "minimax", "glm", "qwen"}

func CharsPerToken(modelID string) float64 {
	modelID = strings.ToLower(modelID)
	for _, prefix := range kiroModelPrefixes {
		if strings.HasPrefix(modelID, prefix) {
			return kiroCharsPerToken
		}
	}
	return defaultCharsPerToken
}

func EstimateTokens(text, modelID string) int {
	if text == "" {
		return 0
	}
	runes := []rune(text)
	ratio := CharsPerToken(modelID)
	var cjk int
	for _, r := range runes {
		if unicode.In(r, unicode.Han, unicode.Hangul, unicode.Hiragana, unicode.Katakana) {
			cjk++
		}
	}
	if float64(cjk)/float64(len(runes)) > cjkRatioThreshold && ratio > cjkCharsPerToken {
		ratio = cjkCharsPerToken
	}
	return max(1, int(math.Ceil(float64(len(runes))/ratio)))
}
