package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// Reading a thread's listing fields back out of its rollout file, ported from
// src/codex/history-provider.ts.
//
// A quarantine restore uses this when the satellite backup carries no usable
// thread snapshot: the rollout that just came back is the only remaining
// record of what the row said.

// RolloutThreadFields is what a rollout can tell us about its thread.
type RolloutThreadFields struct {
	ID               string
	ModelProvider    string
	Source           string
	FirstUserMessage string
	HasUserEvent     int
	// These three are pointers because absent and empty are different. The
	// oracle spreads them in only when the value is a string, so "" is a
	// present value while a number means the key is simply not there.
	CWD         *string
	HistoryMode *string
	CLIVersion  *string
}

// ecmaScriptWhitespace is the exact set `String.prototype.trim` removes.
//
// strings.TrimSpace is wrong in BOTH directions here, which flips
// HasUserEvent either way: JavaScript strips U+FEFF and Go does not, while Go
// strips U+0085 NEL and JavaScript does not. Measured on both runtimes.
const ecmaScriptWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004" +
	"\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// jsTrim trims the way JavaScript does.
func jsTrim(value string) string {
	return strings.Trim(value, ecmaScriptWhitespace)
}

// sessionMetaMarker is matched against the RAW line before any parsing.
//
// That lexical test is part of the contract, not a shortcut. JSON may escape
// the type name, and `{"type":"\u0073ession_meta",...}` parses to
// "session_meta" while the raw line does not contain this marker, so the
// oracle skips it. Parsing first and checking the decoded type would accept a
// line the ported runtime ignores.
const sessionMetaMarker = `"session_meta"`

// decodeRolloutLine parses one JSONL line the way JSON.parse does.
//
// UseNumber matters even though no number is interpreted here: plain
// unmarshalling fails the whole document on an overflowing literal, so an
// unrelated `1e400` field would make Go skip a metadata line the oracle reads
// without complaint.
func decodeRolloutLine(line string) map[string]any {
	decoder := json.NewDecoder(bytes.NewReader([]byte(line)))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return nil
	}
	return object
}

// ParseThreadFieldsFromRolloutText scans a rollout for its thread metadata.
//
// One pass finds two things with opposite rules: the LAST session_meta wins,
// because a provider change is recorded by appending a new one rather than
// rewriting the first, while the FIRST user message wins, because that is the
// preview the listing shows.
func ParseThreadFieldsFromRolloutText(raw string) *RolloutThreadFields {
	var latest map[string]any
	firstUserMessage := ""

	for _, line := range strings.Split(raw, "\n") {
		if line == "" {
			continue
		}
		if strings.Contains(line, sessionMetaMarker) {
			if payload := sessionMetaPayload(line); payload != nil {
				latest = payload
			}
		}
		if firstUserMessage == "" {
			if preview := extractUserMessagePreview(line); preview != "" {
				firstUserMessage = preview
			}
		}
	}
	if latest == nil {
		return nil
	}

	id, _ := latest["id"].(string)
	if id == "" {
		return nil
	}

	fields := &RolloutThreadFields{
		ID: id,
		// A missing, empty or non-string value falls back to the default,
		// unlike the optional fields below where empty is a real value.
		ModelProvider:    stringOrDefault(latest["model_provider"], "openai"),
		Source:           stringOrDefault(latest["source"], "cli"),
		FirstUserMessage: firstUserMessage,
	}
	if jsTrim(firstUserMessage) != "" {
		fields.HasUserEvent = 1
	}
	fields.CWD = optionalString(latest["cwd"])
	fields.HistoryMode = optionalString(latest["history_mode"])
	fields.CLIVersion = optionalString(latest["cli_version"])
	return fields
}

// sessionMetaPayload returns the payload of a session_meta record.
func sessionMetaPayload(line string) map[string]any {
	record := decodeRolloutLine(line)
	if record == nil {
		return nil
	}
	if recordType, _ := record["type"].(string); recordType != "session_meta" {
		return nil
	}
	payload, ok := record["payload"].(map[string]any)
	if !ok {
		return nil
	}
	return payload
}

func stringOrDefault(value any, fallback string) string {
	text, ok := value.(string)
	if !ok || text == "" {
		return fallback
	}
	return text
}

// optionalString keeps the difference between absent and empty.
func optionalString(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

// extractUserMessagePreview pulls the listing preview out of one line.
//
// An event_msg that enters its branch and finds nothing returns empty and does
// NOT fall through to the response_item shape, so a record carrying both
// spellings is read only as the type it declares.
func extractUserMessagePreview(line string) string {
	record := decodeRolloutLine(line)
	if record == nil {
		return ""
	}
	payload, ok := record["payload"].(map[string]any)
	if !ok {
		return ""
	}
	recordType, _ := record["type"].(string)

	if recordType == "event_msg" {
		message, hasMessage := payload["message"].(string)
		if payloadType, _ := payload["type"].(string); payloadType != "user_message" && !hasMessage {
			return ""
		}
		if hasMessage && jsTrim(message) != "" {
			return jsTrim(message)
		}
		return textFromContentParts(payload["content"])
	}

	if recordType == "response_item" {
		payloadType, _ := payload["type"].(string)
		role, _ := payload["role"].(string)
		if payloadType == "message" && role == "user" {
			return textFromContentParts(payload["content"])
		}
	}
	return ""
}

// textFromContentParts joins the text of a content array.
//
// A whitespace-only `text` does NOT claim the part: the condition includes the
// trim test, so the part falls through to `input_text` instead of contributing
// nothing.
func textFromContentParts(content any) string {
	if text, ok := content.(string); ok {
		return jsTrim(text)
	}
	parts, ok := content.([]any)
	if !ok {
		return ""
	}
	collected := make([]string, 0, len(parts))
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := part["text"].(string); ok && jsTrim(text) != "" {
			collected = append(collected, jsTrim(text))
			continue
		}
		if text, ok := part["input_text"].(string); ok && jsTrim(text) != "" {
			collected = append(collected, jsTrim(text))
		}
	}
	return jsTrim(strings.Join(collected, "\n"))
}
