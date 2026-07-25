package cursor

import (
	"sort"
	"strings"
)

var cursorArgumentKeyAliases = map[string]string{
	"filepath":         "path",
	"filename":         "path",
	"file":             "path",
	"targetpath":       "path",
	"directorypath":    "path",
	"dir":              "path",
	"folder":           "path",
	"directory":        "path",
	"targetdirectory":  "path",
	"targetfile":       "path",
	"globpattern":      "pattern",
	"filepattern":      "pattern",
	"searchpattern":    "pattern",
	"includepattern":   "include",
	"workingdirectory": "cwd",
	"workdir":          "cwd",
	"currentdirectory": "cwd",
	"cmd":              "command",
	"script":           "command",
	"shellcommand":     "command",
	"terminalcommand":  "command",
	"contents":         "content",
	"text":             "content",
	"body":             "content",
	"data":             "content",
	"payload":          "content",
	"streamcontent":    "content",
	"oldstring":        "old_string",
	"newstring":        "new_string",
	"oldtext":          "old_string",
	"newtext":          "new_string",
	"oldcontent":       "old_string",
	"newcontent":       "new_string",
	"recursive":        "force",
}

// NormalizeArgKeys maps Cursor's common argument aliases only when the tool's
// declared JSON schema contains the canonical property. Explicit canonical
// values always win over aliases.
func NormalizeArgKeys(arguments map[string]any, toolSchema map[string]any) map[string]any {
	if len(arguments) == 0 || toolSchema == nil {
		return arguments
	}
	properties, ok := toolSchema["properties"].(map[string]any)
	if !ok || len(properties) == 0 {
		return arguments
	}

	canonicalSupplied := make(map[string]struct{}, len(arguments))
	for key := range arguments {
		if _, declared := properties[key]; declared {
			canonicalSupplied[key] = struct{}{}
		}
	}

	keys := make([]string, 0, len(arguments))
	for key := range arguments {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	changed := false
	result := make(map[string]any, len(arguments))
	for _, key := range keys {
		value := arguments[key]
		if _, declared := properties[key]; declared {
			result[key] = value
			continue
		}
		canonical := cursorArgumentKeyAliases[strings.ToLower(key)]
		if canonical == "" {
			result[key] = value
			continue
		}
		if _, declared := properties[canonical]; !declared {
			result[key] = value
			continue
		}
		changed = true
		if _, supplied := canonicalSupplied[canonical]; supplied {
			continue
		}
		if _, alreadyMapped := result[canonical]; !alreadyMapped {
			result[canonical] = value
		}
	}
	if !changed {
		return arguments
	}
	return result
}
