package cursor

import "unicode/utf8"

// EstimateInputTokens provides a dependency-free chars/4 estimate for the model-visible payload.
func EstimateInputTokens(text string) int {
	chars := utf8.RuneCountInString(text)
	if chars == 0 {
		return 0
	}
	return (chars + 3) / 4
}
