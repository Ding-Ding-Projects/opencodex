package server

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
)

var responsesItemID = regexp.MustCompile(`^(msg|rs)_[A-Za-z0-9_-]+$`)

type repairState struct {
	scope                 string
	ids                   map[string]string
	messagePlaceholders   map[string]struct{}
	reasoningPlaceholders map[string]struct{}
	repairMissingTerminal bool
	repairAllInvalid      bool
}

type ResponsesItemIDRepairConfig struct {
	Message                  []string
	Reasoning                []string
	RepairMissingTerminalIDs bool
}

func HasResponsesItemIDRepair(config *ResponsesItemIDRepairConfig) bool {
	return config != nil && (config.RepairMissingTerminalIDs || len(config.Message) > 0 || len(config.Reasoning) > 0)
}

// RepairResponsesItemIDs transforms message/reasoning item IDs while preserving other SSE fields.
func RepairResponsesItemIDs(source io.Reader) io.Reader {
	return repairResponsesItemIDs(source, nil, true)
}

// RepairResponsesItemIDsWithConfig applies provider-local opt-in semantics.
// Only exact configured message/reasoning placeholders are canonicalized;
// missing lifecycle item_id fields may be filled from an earlier mapped item.
func RepairResponsesItemIDsWithConfig(source io.Reader, config ResponsesItemIDRepairConfig) io.Reader {
	return repairResponsesItemIDs(source, &config, false)
}

func repairResponsesItemIDs(source io.Reader, config *ResponsesItemIDRepairConfig, repairAllInvalid bool) io.Reader {
	reader, writer := io.Pipe()
	go func() { writer.CloseWithError(repairStreamConfigured(writer, source, config, repairAllInvalid)) }()
	return reader
}

func repairStream(dst io.Writer, source io.Reader) error {
	return repairStreamConfigured(dst, source, nil, true)
}

func repairStreamConfigured(dst io.Writer, source io.Reader, config *ResponsesItemIDRepairConfig, repairAllInvalid bool) error {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	state := repairState{
		scope: shortRandom(), ids: make(map[string]string), repairAllInvalid: repairAllInvalid,
		messagePlaceholders: make(map[string]struct{}), reasoningPlaceholders: make(map[string]struct{}),
	}
	if config != nil {
		state.repairMissingTerminal = config.RepairMissingTerminalIDs
		for _, value := range config.Message {
			state.messagePlaceholders[value] = struct{}{}
		}
		for _, value := range config.Reasoning {
			state.reasoningPlaceholders[value] = struct{}{}
		}
	}
	var block []string
	flush := func() error {
		if len(block) == 0 {
			_, err := io.WriteString(dst, "\n")
			return err
		}
		for _, line := range block {
			if strings.HasPrefix(line, "data:") {
				prefix, raw := "data:", strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if raw != "[DONE]" {
					raw = repairPayload(raw, &state)
				}
				line = prefix + " " + raw
			}
			if _, err := io.WriteString(dst, line+"\n"); err != nil {
				return err
			}
		}
		_, err := io.WriteString(dst, "\n")
		block = block[:0]
		return err
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
		} else {
			block = append(block, line)
		}
	}
	if len(block) > 0 {
		if err := flush(); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func repairPayload(raw string, state *repairState) string {
	var event map[string]any
	if json.Unmarshal([]byte(raw), &event) != nil {
		return raw
	}
	index, hasIndex := numberIndex(event["output_index"])
	if item, ok := event["item"].(map[string]any); ok && hasIndex {
		repairItem(item, index, state)
	}
	if response, ok := event["response"].(map[string]any); ok {
		if output, ok := response["output"].([]any); ok {
			for i, value := range output {
				if item, ok := value.(map[string]any); ok {
					repairItem(item, i, state)
				}
			}
		}
	}
	if hasIndex {
		kind := eventItemKind(event["type"])
		if kind != "" {
			if id := state.ids[kind+":"+strconv.Itoa(index)]; id != "" {
				_, hasItemID := event["item_id"]
				if hasItemID || state.repairMissingTerminal || state.repairAllInvalid {
					event["item_id"] = id
				}
			}
		}
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return raw
	}
	return string(encoded)
}

func repairItem(item map[string]any, index int, state *repairState) {
	kind, _ := item["type"].(string)
	if kind != "message" && kind != "reasoning" {
		return
	}
	key := kind + ":" + strconv.Itoa(index)
	id, _ := item["id"].(string)
	if mapped := state.ids[key]; mapped != "" {
		if id != "" || state.repairMissingTerminal || state.repairAllInvalid {
			item["id"] = mapped
		}
		return
	}
	_, configuredPlaceholder := state.placeholdersFor(kind)[id]
	if configuredPlaceholder || state.repairAllInvalid && (!responsesItemID.MatchString(id) || !strings.HasPrefix(id, prefixFor(kind))) {
		id = prefixFor(kind) + "ocx_" + state.scope + "_" + strconv.Itoa(index)
		state.ids[key], item["id"] = id, id
		return
	}
	if id != "" && state.repairMissingTerminal {
		state.ids[key] = id
		return
	}
}

func (state *repairState) placeholdersFor(kind string) map[string]struct{} {
	if kind == "reasoning" {
		return state.reasoningPlaceholders
	}
	return state.messagePlaceholders
}

func eventItemKind(value any) string {
	kind, _ := value.(string)
	if strings.Contains(kind, "reasoning_") {
		return "reasoning"
	}
	if strings.Contains(kind, "output_text") || strings.Contains(kind, "content_part") || strings.Contains(kind, "refusal") {
		return "message"
	}
	return ""
}
func numberIndex(value any) (int, bool) {
	n, ok := value.(float64)
	return int(n), ok && n >= 0 && n == float64(int(n))
}
func prefixFor(kind string) string {
	if kind == "reasoning" {
		return "rs_"
	}
	return "msg_"
}
func shortRandom() string { b := make([]byte, 8); _, _ = rand.Read(b); return hex.EncodeToString(b) }
