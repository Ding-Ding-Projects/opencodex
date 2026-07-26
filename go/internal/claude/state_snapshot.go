package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type snapshotState struct {
	CreatedAt int64         `json:"createdAt"`
	Items     []any         `json:"items"`
	Providers ProviderState `json:"providers,omitempty"`
}

type snapshotEntry struct {
	ID    string
	State snapshotState
}

func (s *ResponseStateStore) snapshotLocked() ([]byte, error) {
	entries := make([]snapshotEntry, 0, len(s.states))
	for id, state := range s.states {
		entries = append(entries, snapshotEntry{id, snapshotState{state.CreatedAt.UnixMilli(), state.Items, state.Providers}})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].State.CreatedAt == entries[j].State.CreatedAt {
			return entries[i].ID < entries[j].ID
		}
		return entries[i].State.CreatedAt < entries[j].State.CreatedAt
	})
	selected := make([]json.RawMessage, 0, len(entries))
	total := 0
	for index := len(entries) - 1; index >= 0; index-- {
		entry, err := json.Marshal([]any{entries[index].ID, entries[index].State})
		if err != nil {
			continue
		}
		if len(entry) > snapshotEntryMaxBytes {
			continue
		}
		if total+len(entry) > snapshotTotalMaxBytes {
			break
		}
		total += len(entry)
		selected = append(selected, entry)
	}
	for left, right := 0, len(selected)-1; left < right; left, right = left+1, right-1 {
		selected[left], selected[right] = selected[right], selected[left]
	}
	return json.Marshal(struct {
		Version int               `json:"version"`
		States  []json.RawMessage `json:"states"`
	}{Version: 2, States: selected})
}

func (s *ResponseStateStore) loadSnapshotLocked(data []byte) error {
	var envelope struct {
		Version int             `json:"version"`
		States  json.RawMessage `json:"states"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}
	if envelope.Version != 1 && envelope.Version != 2 {
		return fmt.Errorf("unsupported response state version %d", envelope.Version)
	}
	s.states = map[string]storedResponse{}
	s.bytes = 0
	var entries []json.RawMessage
	if len(envelope.States) > 0 && envelope.States[0] == '[' {
		_ = json.Unmarshal(envelope.States, &entries)
		for _, raw := range entries {
			var pair []json.RawMessage
			if json.Unmarshal(raw, &pair) != nil || len(pair) != 2 {
				continue
			}
			var id string
			var state struct {
				CreatedAt              int64         `json:"createdAt"`
				Items                  []any         `json:"items"`
				Providers              ProviderState `json:"providers"`
				ConversationID         string        `json:"conversationId"`
				CursorCheckpointUsable *bool         `json:"cursorCheckpointUsable"`
			}
			if json.Unmarshal(pair[0], &id) != nil || json.Unmarshal(pair[1], &state) != nil || id == "" || state.Items == nil {
				continue
			}
			providers := state.Providers
			if providers == nil && state.ConversationID != "" {
				cursor := map[string]any{"conversationId": state.ConversationID}
				if state.CursorCheckpointUsable != nil {
					cursor["checkpointUsable"] = *state.CursorCheckpointUsable
				}
				providers = ProviderState{"cursor": cursor}
			}
			s.setEntryLocked(id, storedResponse{CreatedAt: time.UnixMilli(state.CreatedAt), Items: state.Items, Providers: providers})
		}
		return nil
	}
	var legacy map[string]struct {
		CreatedAt time.Time     `json:"createdAt"`
		Items     []any         `json:"items"`
		Providers ProviderState `json:"providers"`
	}
	if json.Unmarshal(envelope.States, &legacy) != nil {
		return fmt.Errorf("response state snapshot states must be an array or object")
	}
	for id, state := range legacy {
		if id != "" && state.Items != nil && !state.CreatedAt.IsZero() {
			s.setEntryLocked(id, storedResponse{CreatedAt: state.CreatedAt, Items: state.Items, Providers: state.Providers})
		}
	}
	return nil
}

func readResponseSnapshot(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > snapshotTotalMaxBytes+1<<20 {
		return nil, fmt.Errorf("response state snapshot exceeds size limit")
	}
	return os.ReadFile(path)
}

func writeResponseSnapshot(path string, data []byte) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("response state snapshot path is required")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(dir, 0o700)
	temporary := fmt.Sprintf("%s.tmp-%d", path, os.Getpid())
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Chmod(path, 0o600)
}

func responseStateSnapshotPath() string {
	dir := strings.TrimSpace(os.Getenv("OPENCODEX_HOME"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		dir = filepath.Join(home, ".opencodex")
	}
	return filepath.Join(dir, "responses-state.json")
}
