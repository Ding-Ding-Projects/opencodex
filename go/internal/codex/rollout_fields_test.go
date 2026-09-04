package codex

import (
	"strings"
	"testing"
)

func metaLine(payload string) string {
	return `{"type":"session_meta","payload":` + payload + `}`
}

func userLine(message string) string {
	return `{"type":"event_msg","payload":{"type":"user_message","message":"` + message + `"}}`
}

// Criterion 1: a rollout with metadata and a user turn fills every field.
func TestParseThreadFieldsReadsAWholeRollout(t *testing.T) {
	raw := strings.Join([]string{
		metaLine(`{"id":"t1","model_provider":"anthropic","source":"app","cwd":"/w",` +
			`"history_mode":"full","cli_version":"1.2.3"}`),
		userLine("hello there"),
	}, "\n")

	fields := ParseThreadFieldsFromRolloutText(raw)
	if fields == nil {
		t.Fatal("a well-formed rollout must parse")
	}
	if fields.ID != "t1" || fields.ModelProvider != "anthropic" || fields.Source != "app" {
		t.Fatalf("fields = %+v", fields)
	}
	if fields.FirstUserMessage != "hello there" || fields.HasUserEvent != 1 {
		t.Fatalf("message = %q hasUserEvent = %d", fields.FirstUserMessage, fields.HasUserEvent)
	}
	if fields.CWD == nil || *fields.CWD != "/w" ||
		fields.HistoryMode == nil || *fields.HistoryMode != "full" ||
		fields.CLIVersion == nil || *fields.CLIVersion != "1.2.3" {
		t.Fatalf("optional fields = %+v", fields)
	}
}

// Criteria 2 and 3: the two scans have OPPOSITE rules. Metadata is appended
// when a provider changes, so the last one is current; the preview is the
// conversation's opening line, so the first one wins.
func TestLastMetadataWinsAndFirstMessageWins(t *testing.T) {
	raw := strings.Join([]string{
		metaLine(`{"id":"t1","model_provider":"openai"}`),
		userLine("first"),
		metaLine(`{"id":"t1","model_provider":"anthropic"}`),
		userLine("second"),
	}, "\n")

	fields := ParseThreadFieldsFromRolloutText(raw)
	if fields.ModelProvider != "anthropic" {
		t.Fatalf("provider = %q, want the appended metadata to win", fields.ModelProvider)
	}
	if fields.FirstUserMessage != "first" {
		t.Fatalf("message = %q, want the opening line", fields.FirstUserMessage)
	}
}

// Criteria 4 and 5: without usable metadata there is no row to rebuild.
func TestParseThreadFieldsRequiresUsableMetadata(t *testing.T) {
	for name, raw := range map[string]string{
		"no session_meta at all": userLine("hello"),
		"empty id":               metaLine(`{"id":""}`),
		"numeric id":             metaLine(`{"id":7}`),
		"missing id":             metaLine(`{"model_provider":"openai"}`),
		"payload not an object":  `{"type":"session_meta","payload":"x"}`,
		"wrong record type":      `{"type":"other","payload":{"id":"t1"},"note":"session_meta"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if fields := ParseThreadFieldsFromRolloutText(raw); fields != nil {
				t.Fatalf("fields = %+v, want nil", fields)
			}
		})
	}
}

// Criterion 21: the raw-line test is part of the contract. JSON may escape the
// type name, and the oracle never parses a line that does not literally carry
// the marker — so an escaped spelling is invisible to it.
func TestAnEscapedRecordTypeIsIgnored(t *testing.T) {
	raw := `{"type":"\u0073ession_meta","payload":{"id":"t1"}}`
	if strings.Contains(raw, `"session_meta"`) {
		t.Fatal("this fixture must not contain the literal marker")
	}
	if fields := ParseThreadFieldsFromRolloutText(raw); fields != nil {
		t.Fatalf("fields = %+v; the lexical prefilter is semantic, not an optimization", fields)
	}
}

// Criterion 22: an unrelated overflowing number must not cost us the line.
// Standard Go decoding fails the whole document on it while JSON.parse yields
// Infinity and the parser simply ignores the field.
func TestAnOverflowingUnrelatedNumberDoesNotDiscardTheLine(t *testing.T) {
	raw := `{"type":"session_meta","payload":{"id":"t1"},"junk":1e400}`
	fields := ParseThreadFieldsFromRolloutText(raw)
	if fields == nil || fields.ID != "t1" {
		t.Fatalf("fields = %+v, want the line parsed", fields)
	}
}

// Criterion 25: JSON.parse takes one value per line.
func TestATrailingValueDiscardsTheLine(t *testing.T) {
	raw := metaLine(`{"id":"t1"}`) + ` 0`
	if fields := ParseThreadFieldsFromRolloutText(raw); fields != nil {
		t.Fatalf("fields = %+v, want the line rejected", fields)
	}
}

// Criteria 6 and 7: these two fall back, so empty is not a value.
func TestProviderAndSourceFallBack(t *testing.T) {
	for name, payload := range map[string]string{
		"absent":       `{"id":"t1"}`,
		"empty string": `{"id":"t1","model_provider":"","source":""}`,
		"not a string": `{"id":"t1","model_provider":7,"source":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			fields := ParseThreadFieldsFromRolloutText(metaLine(payload))
			if fields.ModelProvider != "openai" || fields.Source != "cli" {
				t.Fatalf("provider = %q source = %q, want the defaults",
					fields.ModelProvider, fields.Source)
			}
		})
	}
}

// Criteria 8 and 9: unlike provider and source, these keep the difference
// between an empty value and no key at all.
func TestOptionalFieldsDistinguishEmptyFromAbsent(t *testing.T) {
	present := ParseThreadFieldsFromRolloutText(
		metaLine(`{"id":"t1","cwd":"","history_mode":"","cli_version":""}`))
	if present.CWD == nil || *present.CWD != "" {
		t.Fatalf("cwd = %v; an empty string is a present value", present.CWD)
	}
	if present.HistoryMode == nil || present.CLIVersion == nil {
		t.Fatalf("fields = %+v, want all three present", present)
	}

	absent := ParseThreadFieldsFromRolloutText(
		metaLine(`{"id":"t1","cwd":7,"history_mode":null}`))
	if absent.CWD != nil || absent.HistoryMode != nil || absent.CLIVersion != nil {
		t.Fatalf("fields = %+v, want all three absent", absent)
	}
}

// Criteria 10, 11, 23 and 24: hasUserEvent follows JavaScript's trim, which
// differs from Go's in both directions.
func TestHasUserEventFollowsJavaScriptTrim(t *testing.T) {
	for name, test := range map[string]struct {
		message string
		want    int
	}{
		"no message at all": {"", 0},
		"spaces only":       {"   ", 0},
		"real text":         {"hi", 1},
		// JavaScript strips U+FEFF, Go's TrimSpace does not.
		"byte order mark only": {"\ufeff", 0},
		// Go strips U+0085 NEL, JavaScript does not.
		"next line only": {"\u0085", 1},
	} {
		t.Run(name, func(t *testing.T) {
			raw := metaLine(`{"id":"t1"}`)
			if test.message != "" {
				raw += "\n" + userLine(test.message)
			}
			fields := ParseThreadFieldsFromRolloutText(raw)
			if fields.HasUserEvent != test.want {
				t.Fatalf("hasUserEvent = %d, want %d for %q",
					fields.HasUserEvent, test.want, test.message)
			}
		})
	}
}

// Criteria 12-16: which records carry a preview, and which do not.
func TestUserMessageExtraction(t *testing.T) {
	for name, test := range map[string]struct {
		line string
		want string
	}{
		"event_msg with a message string": {
			`{"type":"event_msg","payload":{"type":"user_message","message":" hi "}}`, "hi"},
		"event_msg with only a message field": {
			`{"type":"event_msg","payload":{"message":"implied"}}`, "implied"},
		"event_msg with content parts": {
			`{"type":"event_msg","payload":{"type":"user_message","content":[{"text":"from parts"}]}}`,
			"from parts"},
		"event_msg that never enters the branch": {
			`{"type":"event_msg","payload":{"type":"other","content":[{"text":"ignored"}]}}`, ""},
		"response_item user message": {
			`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"asked"}]}}`,
			"asked"},
		"response_item from the assistant": {
			`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"replied"}]}}`,
			""},
		"unrelated record type": {
			`{"type":"turn_context","payload":{"content":[{"text":"nope"}]}}`, ""},
	} {
		t.Run(name, func(t *testing.T) {
			if got := extractUserMessagePreview(test.line); got != test.want {
				t.Fatalf("preview = %q, want %q", got, test.want)
			}
		})
	}
}

// Criterion 14, sharpened: an event_msg carrying a response-item shape must be
// read as the type it declares, not as the shape it resembles.
func TestAnEventMsgIsNeverReadAsAResponseItem(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"message","role":"user",` +
		`"content":[{"text":"looks like a response item"}]}}`
	if got := extractUserMessagePreview(line); got != "" {
		t.Fatalf("preview = %q; the event_msg branch owns this record and finds nothing", got)
	}
}

// Criteria 17 and 18: a whitespace-only `text` does not claim the part, so the
// same part still contributes its `input_text`.
func TestTextFromContentParts(t *testing.T) {
	for name, test := range map[string]struct {
		content string
		want    string
	}{
		"a plain string":           {`" padded "`, "padded"},
		"a whitespace-only string": {`"   "`, ""},
		"not an array":             {`7`, ""},
		"text wins":                {`[{"text":"a","input_text":"b"}]`, "a"},
		"blank text falls through": {`[{"text":"   ","input_text":"b"}]`, "b"},
		"both blank":               {`[{"text":"  ","input_text":" "}]`, ""},
		"several parts join":       {`[{"text":"one"},{"text":"two"}]`, "one\ntwo"},
		"non-object parts skipped": {`[7,{"text":"kept"}]`, "kept"},
	} {
		t.Run(name, func(t *testing.T) {
			line := `{"type":"event_msg","payload":{"type":"user_message","content":` +
				test.content + `}}`
			if got := extractUserMessagePreview(line); got != test.want {
				t.Fatalf("preview = %q, want %q", got, test.want)
			}
		})
	}
}

// Criteria 19 and 20: a malformed or blank line is skipped and the scan keeps
// going, so one bad line cannot cost a whole rollout its metadata.
func TestMalformedLinesAreSkipped(t *testing.T) {
	raw := strings.Join([]string{
		"",
		`{"type":"session_meta","payload":{`,
		"not json at all",
		metaLine(`{"id":"t1"}`),
		"",
		userLine("survived"),
	}, "\n")

	fields := ParseThreadFieldsFromRolloutText(raw)
	if fields == nil || fields.ID != "t1" || fields.FirstUserMessage != "survived" {
		t.Fatalf("fields = %+v, want the scan to continue past bad lines", fields)
	}
}
