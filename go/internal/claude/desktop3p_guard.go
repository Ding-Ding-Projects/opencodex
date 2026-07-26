package claude

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"
)

const desktop3pMaxLabelChars = 80

var desktop3pModelNamePattern = regexp.MustCompile(`^claude-[a-z0-9-]+$`)

// AssertDesktop3pModelsValid validates the model list immediately before it is
// exposed for writing to Claude Desktop's user-visible config.
func AssertDesktop3pModelsValid(models []Desktop3pModelEntry) error {
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		if !desktop3pModelNamePattern.MatchString(model.Name) {
			return fmt.Errorf("Desktop 3P model name is not a valid Claude-shaped id: %s", model.Name)
		}
		if _, duplicate := seen[model.Name]; duplicate {
			return fmt.Errorf("Desktop 3P model name duplicated: %s", model.Name)
		}
		seen[model.Name] = struct{}{}
		if strings.ContainsAny(model.LabelOverride, "[]") {
			return fmt.Errorf("Desktop 3P label carries a raw capability marker: %s", model.LabelOverride)
		}
		if len(utf16.Encode([]rune(model.LabelOverride))) > desktop3pMaxLabelChars {
			return fmt.Errorf("Desktop 3P label exceeds %d chars: %s", desktop3pMaxLabelChars, model.LabelOverride)
		}
	}
	return nil
}
