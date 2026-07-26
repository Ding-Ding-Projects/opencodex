package server

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	maxStoredResponses       = 1000
	responseStateTTL         = time.Hour
	maxStoredResponseBytes   = 64 << 20
	responseSnapshotEntryMax = 2 << 20
	responseSnapshotTotalMax = 24 << 20
	responseSnapshotDebounce = 2 * time.Second
)

type ResponseStateMetrics struct {
	Count        int   `json:"count"`
	TotalBytes   int64 `json:"totalBytes"`
	LargestBytes int64 `json:"largestBytes"`
	OldestAgeMS  int64 `json:"oldestAgeMs"`
}

type storedResponseState struct {
	CreatedAt int64                           `json:"createdAt"`
	Items     []any                           `json:"items"`
	Providers types.ProviderContinuationState `json:"providers,omitempty"`
	sizeBytes int64
}

// ResponseStateStore retains bounded previous_response_id replay state. Disk
// persistence is a best-effort cache and is never required for request success.
type ResponseStateStore struct {
	mu       sync.Mutex
	states   map[string]*storedResponseState
	order    []string
	total    int64
	path     string
	loaded   bool
	timer    *time.Timer
	now      func() time.Time
	byteCap  int64
	debounce time.Duration
}

func NewResponseStateStore(path string) *ResponseStateStore {
	return &ResponseStateStore{
		states: make(map[string]*storedResponseState), path: path, now: time.Now,
		byteCap: maxStoredResponseBytes, debounce: responseSnapshotDebounce,
	}
}

func (s *ResponseStateStore) Expand(body map[string]any) (map[string]any, int, types.ProviderContinuationState, bool) {
	if s == nil || body == nil {
		return body, 0, nil, false
	}
	previousID, _ := body["previous_response_id"].(string)
	if previousID == "" {
		return body, 0, nil, false
	}
	s.mu.Lock()
	s.ensureLoadedLocked()
	s.pruneLocked(s.now())
	previous := s.states[previousID]
	if previous == nil {
		s.mu.Unlock()
		return body, 0, nil, false
	}
	items := append([]any(nil), previous.Items...)
	providers := cloneProviderState(previous.Providers)
	s.mu.Unlock()
	expanded := make(map[string]any, len(body))
	for key, value := range body {
		expanded[key] = value
	}
	expanded["input"] = append(items, responseInputItems(body["input"])...)
	return expanded, len(items), providers, true
}

func (s *ResponseStateStore) Remember(rawBody []byte, response bridge.Response, providerState types.ProviderContinuationState, force bool) {
	output := make([]any, len(response.Output))
	for index := range response.Output {
		output[index] = response.Output[index]
	}
	s.remember(rawBody, response.ID, output, response.Status, response.IncompleteDetails, providerState, force)
}

func (s *ResponseStateStore) RememberMap(rawBody []byte, response map[string]any, providerState types.ProviderContinuationState, force bool) {
	if s == nil || response == nil {
		return
	}
	id, _ := response["id"].(string)
	status, _ := response["status"].(string)
	output, _ := response["output"].([]any)
	details, _ := response["incomplete_details"].(map[string]any)
	s.remember(rawBody, id, output, status, details, providerState, force)
}

func (s *ResponseStateStore) remember(rawBody []byte, id string, output []any, status string, incomplete map[string]any, providerState types.ProviderContinuationState, force bool) {
	if s == nil || id == "" || output == nil {
		return
	}
	var request map[string]any
	if json.Unmarshal(rawBody, &request) != nil {
		return
	}
	if stored, ok := request["store"].(bool); ok && !stored && !force {
		return
	}
	if status == "incomplete" {
		if reason, _ := incomplete["reason"].(string); reason != "max_output_tokens" {
			return
		}
	} else if status != "" && status != "completed" {
		return
	}
	items := append(responseInputItems(request["input"]), output...)
	providers := cloneProviderState(providerState)
	if cursor := providers["cursor"]; cursor != nil {
		if conversationID, _ := cursor["conversationId"].(string); conversationID != "" {
			checkpoint := true
			for _, item := range output {
				if object, ok := item.(map[string]any); ok && object["type"] == "function_call" {
					checkpoint = false
					break
				}
			}
			cursor["checkpointUsable"] = checkpoint
		}
	}
	payload, _ := json.Marshal(items)
	entry := &storedResponseState{CreatedAt: s.now().UnixMilli(), Items: items, Providers: providers, sizeBytes: int64(len(payload))}
	s.mu.Lock()
	s.ensureLoadedLocked()
	s.deleteLocked(id)
	s.states[id] = entry
	s.order = append(s.order, id)
	s.total += entry.sizeBytes
	s.pruneLocked(s.now())
	s.schedulePersistLocked()
	s.mu.Unlock()
}

func (s *ResponseStateStore) Metrics() ResponseStateMetrics {
	if s == nil {
		return ResponseStateMetrics{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.now().UnixMilli()
	metrics := ResponseStateMetrics{Count: len(s.states), TotalBytes: s.total}
	oldest := at
	for _, state := range s.states {
		if state.sizeBytes > metrics.LargestBytes {
			metrics.LargestBytes = state.sizeBytes
		}
		if state.CreatedAt < oldest {
			oldest = state.CreatedAt
		}
	}
	if metrics.Count > 0 {
		metrics.OldestAgeMS = at - oldest
	}
	return metrics
}

func (s *ResponseStateStore) Flush() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.timer == nil {
		s.mu.Unlock()
		return
	}
	s.timer.Stop()
	s.timer = nil
	s.persistLocked()
	s.mu.Unlock()
}

func (s *ResponseStateStore) schedulePersistLocked() {
	if s.path == "" || s.timer != nil {
		return
	}
	delay := s.debounce
	if delay <= 0 {
		delay = responseSnapshotDebounce
	}
	s.timer = time.AfterFunc(delay, func() {
		s.mu.Lock()
		s.timer = nil
		s.persistLocked()
		s.mu.Unlock()
	})
}

func (s *ResponseStateStore) ensureLoadedLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	if s.path == "" {
		return
	}
	payload, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var snapshot struct {
		Version int               `json:"version"`
		States  []json.RawMessage `json:"states"`
	}
	if json.Unmarshal(payload, &snapshot) != nil || (snapshot.Version != 1 && snapshot.Version != 2) {
		return
	}
	for _, raw := range snapshot.States {
		var tuple []json.RawMessage
		if json.Unmarshal(raw, &tuple) != nil || len(tuple) != 2 {
			continue
		}
		var id string
		var disk struct {
			CreatedAt              int64                           `json:"createdAt"`
			Items                  []any                           `json:"items"`
			Providers              types.ProviderContinuationState `json:"providers"`
			ConversationID         string                          `json:"conversationId"`
			CursorCheckpointUsable *bool                           `json:"cursorCheckpointUsable"`
		}
		if json.Unmarshal(tuple[0], &id) != nil || id == "" || json.Unmarshal(tuple[1], &disk) != nil || disk.CreatedAt == 0 || disk.Items == nil {
			continue
		}
		providers := disk.Providers
		if len(providers) == 0 && disk.ConversationID != "" {
			cursor := map[string]any{"conversationId": disk.ConversationID}
			if disk.CursorCheckpointUsable != nil {
				cursor["checkpointUsable"] = *disk.CursorCheckpointUsable
			}
			providers = types.ProviderContinuationState{"cursor": cursor}
		}
		encoded, _ := json.Marshal(disk.Items)
		s.setLoadedLocked(id, &storedResponseState{CreatedAt: disk.CreatedAt, Items: disk.Items, Providers: providers, sizeBytes: int64(len(encoded))})
	}
	s.pruneLocked(s.now())
}

func (s *ResponseStateStore) setLoadedLocked(id string, entry *storedResponseState) {
	s.deleteLocked(id)
	s.states[id] = entry
	s.order = append(s.order, id)
	s.total += entry.sizeBytes
}

func (s *ResponseStateStore) deleteLocked(id string) {
	existing := s.states[id]
	if existing == nil {
		return
	}
	delete(s.states, id)
	s.total -= existing.sizeBytes
	if s.total < 0 {
		s.total = 0
	}
	for index, candidate := range s.order {
		if candidate == id {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
}

func (s *ResponseStateStore) pruneLocked(at time.Time) {
	cutoff := at.Add(-responseStateTTL).UnixMilli()
	for _, id := range append([]string(nil), s.order...) {
		if state := s.states[id]; state != nil && state.CreatedAt < cutoff {
			s.deleteLocked(id)
		}
	}
	for len(s.order) > maxStoredResponses {
		s.deleteLocked(s.order[0])
	}
	cap := s.byteCap
	if cap <= 0 {
		cap = maxStoredResponseBytes
	}
	for s.total > cap && len(s.order) > 1 {
		s.deleteLocked(s.order[0])
	}
}

func (s *ResponseStateStore) persistLocked() {
	if s.path == "" {
		return
	}
	entries := make([]any, 0, len(s.order))
	total := 0
	for index := len(s.order) - 1; index >= 0; index-- {
		id := s.order[index]
		state := s.states[id]
		if state == nil {
			continue
		}
		persistable := struct {
			CreatedAt int64                           `json:"createdAt"`
			Items     []any                           `json:"items"`
			Providers types.ProviderContinuationState `json:"providers,omitempty"`
		}{state.CreatedAt, state.Items, state.Providers}
		entry := []any{id, persistable}
		encoded, err := json.Marshal(entry)
		if err != nil || len(encoded) > responseSnapshotEntryMax {
			continue
		}
		if total+len(encoded) > responseSnapshotTotalMax {
			break
		}
		total += len(encoded)
		entries = append(entries, entry)
	}
	for left, right := 0, len(entries)-1; left < right; left, right = left+1, right-1 {
		entries[left], entries[right] = entries[right], entries[left]
	}
	payload, err := json.Marshal(struct {
		Version int   `json:"version"`
		States  []any `json:"states"`
	}{Version: 2, States: entries})
	if err != nil {
		return
	}
	directory := filepath.Dir(s.path)
	if os.MkdirAll(directory, 0o700) != nil {
		return
	}
	_ = os.Chmod(directory, 0o700)
	temporary, err := os.CreateTemp(directory, ".responses-state-*")
	if err != nil {
		return
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if errors.Join(temporary.Chmod(0o600), func() error { _, err := temporary.Write(payload); return err }(), temporary.Sync(), temporary.Close()) != nil {
		return
	}
	_ = os.Rename(temporaryPath, s.path)
}

func responseInputItems(input any) []any {
	if input == nil {
		return nil
	}
	if items, ok := input.([]any); ok {
		return append([]any(nil), items...)
	}
	if text, ok := input.(string); ok {
		return []any{map[string]any{"role": "user", "content": text}}
	}
	return []any{input}
}

func cloneProviderState(source types.ProviderContinuationState) types.ProviderContinuationState {
	if len(source) == 0 {
		return nil
	}
	payload, err := json.Marshal(source)
	if err != nil {
		return nil
	}
	var result types.ProviderContinuationState
	if json.Unmarshal(payload, &result) != nil {
		return nil
	}
	return result
}

func providerStateFromEvents(events []types.AdapterEvent) types.ProviderContinuationState {
	var result types.ProviderContinuationState
	for _, event := range events {
		if len(event.ProviderState) > 0 {
			result = cloneProviderState(event.ProviderState)
		}
	}
	return result
}
