package types

import (
	"encoding/json"
	"fmt"
)

type MessagePhase string

const (
	PhaseCommentary  MessagePhase = "commentary"
	PhaseFinalAnswer MessagePhase = "final_answer"
)

type ContentPartType string

const (
	ContentText     ContentPartType = "text"
	ContentImage    ContentPartType = "image"
	ContentThinking ContentPartType = "thinking"
	ContentToolCall ContentPartType = "toolCall"
)

// ContentPart is the typed counterpart of src/types.ts OcxContentPart and
// OcxAssistantContentPart. Fields are a tagged union selected by Type.
type ContentPart struct {
	Type             ContentPartType `json:"type"`
	Text             string          `json:"text,omitempty"`
	ImageURL         string          `json:"imageUrl,omitempty"`
	Detail           string          `json:"detail,omitempty"`
	Thinking         string          `json:"thinking,omitempty"`
	Signature        string          `json:"signature,omitempty"`
	ItemID           string          `json:"itemId,omitempty"`
	Redacted         []string        `json:"redacted,omitempty"`
	ID               string          `json:"id,omitempty"`
	Name             string          `json:"name,omitempty"`
	Arguments        map[string]any  `json:"arguments,omitempty"`
	CustomWireName   string          `json:"customWireName,omitempty"`
	ThoughtSignature string          `json:"thoughtSignature,omitempty"`
	Namespace        string          `json:"namespace,omitempty"`
}

func TextPart(text string) ContentPart {
	return ContentPart{Type: ContentText, Text: text}
}

func ImagePart(imageURL, detail string) ContentPart {
	return ContentPart{Type: ContentImage, ImageURL: imageURL, Detail: detail}
}

func ThinkingPart(thinking, signature string) ContentPart {
	return ContentPart{Type: ContentThinking, Thinking: thinking, Signature: signature}
}

func ToolCallPart(id, name string, arguments map[string]any) ContentPart {
	return ContentPart{Type: ContentToolCall, ID: id, Name: name, Arguments: arguments}
}

// Validate checks the discriminated-union requirements at the external JSON
// boundary. Empty text/thinking values are valid stream snapshots.
func (p ContentPart) Validate() error {
	switch p.Type {
	case ContentText:
		return nil
	case ContentImage:
		if p.ImageURL == "" {
			return fmt.Errorf("image content requires imageUrl")
		}
		return nil
	case ContentThinking:
		return nil
	case ContentToolCall:
		if p.ID == "" || p.Name == "" {
			return fmt.Errorf("toolCall content requires id and name")
		}
		if p.Arguments == nil {
			return fmt.Errorf("toolCall content requires arguments")
		}
		return nil
	default:
		return fmt.Errorf("unsupported content part type %q", p.Type)
	}
}

// DecodeContent accepts either the TS string shorthand or a typed content-part
// array and rejects malformed union members.
func DecodeContent(raw json.RawMessage) (text *string, parts []ContentPart, err error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil, nil
	}
	var scalar string
	if json.Unmarshal(raw, &scalar) == nil {
		return &scalar, nil, nil
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return nil, nil, fmt.Errorf("decode content parts: %w", err)
	}
	for index, part := range parts {
		if err := part.Validate(); err != nil {
			return nil, nil, fmt.Errorf("content part %d: %w", index, err)
		}
	}
	return nil, parts, nil
}

func EncodeTextContent(text string) json.RawMessage {
	encoded, _ := json.Marshal(text)
	return encoded
}

func EncodeContentParts(parts []ContentPart) (json.RawMessage, error) {
	for index, part := range parts {
		if err := part.Validate(); err != nil {
			return nil, fmt.Errorf("content part %d: %w", index, err)
		}
	}
	return json.Marshal(parts)
}

type ToolChoiceMode string

const (
	ToolChoiceAuto     ToolChoiceMode = "auto"
	ToolChoiceNone     ToolChoiceMode = "none"
	ToolChoiceRequired ToolChoiceMode = "required"
)

// ToolChoice covers named and allowed-tools choices without losing the simple
// string forms accepted by Responses clients.
type ToolChoice struct {
	Mode         ToolChoiceMode `json:"mode,omitempty"`
	Name         string         `json:"name,omitempty"`
	AllowedTools []string       `json:"allowedTools,omitempty"`
}

func (c ToolChoice) Validate() error {
	if c.Name != "" {
		if c.Mode != "" || len(c.AllowedTools) != 0 {
			return fmt.Errorf("named tool choice cannot include mode or allowedTools")
		}
		return nil
	}
	if len(c.AllowedTools) > 0 {
		if c.Mode != ToolChoiceAuto && c.Mode != ToolChoiceRequired {
			return fmt.Errorf("allowedTools mode must be auto or required")
		}
		return nil
	}
	if c.Mode != ToolChoiceAuto && c.Mode != ToolChoiceNone && c.Mode != ToolChoiceRequired {
		return fmt.Errorf("unsupported tool choice mode %q", c.Mode)
	}
	return nil
}
