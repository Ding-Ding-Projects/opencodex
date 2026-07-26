package claude

import (
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

const (
	maxStoredResponses       = 1000
	responseTTL              = time.Hour
	maxStoredResponseBytes   = 64 << 20
	snapshotEntryMaxBytes    = 2 << 20
	snapshotTotalMaxBytes    = 24 << 20
	responseSnapshotDebounce = 2 * time.Second
)

type ProviderState map[string]any

type storedResponse struct {
	CreatedAt time.Time
	Items     []any
	Providers ProviderState
	Size      int
}

type ResponseStateMetrics struct {
	Count        int   `json:"count"`
	TotalBytes   int   `json:"totalBytes"`
	LargestBytes int   `json:"largestBytes"`
	OldestAgeMS  int64 `json:"oldestAgeMs"`
}

type ResponseStateStore struct {
	mu           sync.Mutex
	states       map[string]storedResponse
	bytes        int
	now          func() time.Time
	byteCap      int
	snapshotPath func() string
	debounce     time.Duration
	loaded       bool
	persistTimer *time.Timer
	pendingPath  string
}

func NewResponseStateStore() *ResponseStateStore {
	return &ResponseStateStore{
		states:   map[string]storedResponse{},
		now:      time.Now,
		byteCap:  maxStoredResponseBytes,
		debounce: responseSnapshotDebounce,
	}
}

func newDefaultResponseStateStore() *ResponseStateStore {
	store := NewResponseStateStore()
	store.snapshotPath = responseStateSnapshotPath
	return store
}

var defaultResponseState = newDefaultResponseStateStore()

func ExpandPreviousResponseInput(body map[string]any) map[string]any {
	expanded, _, _ := defaultResponseState.ExpandWithMetadata(body)
	return expanded
}

func PreviousResponseProviderState(id string) ProviderState {
	return defaultResponseState.ProviderState(id)
}

func RememberResponseState(request map[string]any, response map[string]any, provider ProviderState, force bool) {
	defaultResponseState.Remember(request, response, provider, force)
}

func FlushResponseState() error { return defaultResponseState.Flush() }

func ResponseStateMemoryMetrics() ResponseStateMetrics { return defaultResponseState.Metrics() }

func (s *ResponseStateStore) Expand(body map[string]any) map[string]any {
	expanded, _, _ := s.ExpandWithMetadata(body)
	return expanded
}

// ExpandWithMetadata returns the replay prefix length and whether expansion
// succeeded without adding proxy-private fields to the forwarded request body.
func (s *ResponseStateStore) ExpandWithMetadata(body map[string]any) (map[string]any, int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	s.pruneLocked()
	id := stringField(body, "previous_response_id")
	previous, ok := s.states[id]
	if !ok {
		return body, 0, false
	}
	out := cloneMap(body)
	out["input"] = append(append([]any{}, previous.Items...), inputItems(body["input"])...)
	return out, len(previous.Items), true
}

func (s *ResponseStateStore) ProviderState(id string) ProviderState {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	s.pruneLocked()
	state, ok := s.states[id]
	if !ok {
		return nil
	}
	return cloneProvider(state.Providers)
}

func (s *ResponseStateStore) Remember(request, response map[string]any, providers ProviderState, force bool) {
	if request == nil || response == nil || (request["store"] == false && !force) {
		return
	}
	id := stringField(response, "id")
	output, ok := response["output"].([]any)
	if id == "" || !ok {
		return
	}
	status := stringField(response, "status")
	if status == "incomplete" {
		details, ok := response["incomplete_details"].(map[string]any)
		if !ok || stringField(details, "reason") != "max_output_tokens" {
			return
		}
	} else if status != "" && status != "completed" {
		return
	}

	providers = cloneProvider(providers)
	if providers == nil {
		providers = ProviderState{}
	}
	if cursor, ok := providers["cursor"].(map[string]any); ok && stringField(cursor, "conversationId") != "" {
		usable := true
		for _, item := range output {
			if value, ok := item.(map[string]any); ok && stringField(value, "type") == "function_call" {
				usable = false
				break
			}
		}
		cursor["checkpointUsable"] = usable
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	s.setEntryLocked(id, storedResponse{
		CreatedAt: s.now(),
		Items:     append(inputItems(request["input"]), output...),
		Providers: providers,
	})
	s.pruneLocked()
	s.schedulePersistLocked()
}

func (s *ResponseStateStore) Metrics() ResponseStateMetrics {
	s.mu.Lock()
	defer s.mu.Unlock()
	metrics := ResponseStateMetrics{Count: len(s.states), TotalBytes: s.bytes}
	now := s.now()
	var oldest time.Time
	for _, state := range s.states {
		if state.Size > metrics.LargestBytes {
			metrics.LargestBytes = state.Size
		}
		if oldest.IsZero() || state.CreatedAt.Before(oldest) {
			oldest = state.CreatedAt
		}
	}
	if !oldest.IsZero() {
		metrics.OldestAgeMS = max(0, now.Sub(oldest).Milliseconds())
	}
	return metrics
}

func (s *ResponseStateStore) SetByteCapForTests(bytes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if bytes <= 0 {
		s.byteCap = maxStoredResponseBytes
	} else {
		s.byteCap = bytes
	}
	s.pruneLocked()
}

func (s *ResponseStateStore) Save(path string) error {
	s.mu.Lock()
	s.ensureLoadedLocked()
	data, err := s.snapshotLocked()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return writeResponseSnapshot(path, data)
}

func (s *ResponseStateStore) Load(path string) error {
	data, err := readResponseSnapshot(path)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadSnapshotLocked(data); err != nil {
		return err
	}
	s.loaded = true
	s.pruneLocked()
	return nil
}

func (s *ResponseStateStore) Flush() error {
	s.mu.Lock()
	if s.persistTimer == nil || s.pendingPath == "" {
		s.mu.Unlock()
		return nil
	}
	s.persistTimer.Stop()
	s.persistTimer = nil
	path := s.pendingPath
	s.pendingPath = ""
	data, err := s.snapshotLocked()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return writeResponseSnapshot(path, data)
}

func (s *ResponseStateStore) ClearMemory() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.persistTimer != nil {
		s.persistTimer.Stop()
	}
	s.persistTimer = nil
	s.pendingPath = ""
	s.states = map[string]storedResponse{}
	s.bytes = 0
	s.loaded = false
}

func (s *ResponseStateStore) Clear() error {
	s.ClearMemory()
	if s.snapshotPath == nil {
		return nil
	}
	path := s.snapshotPath()
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *ResponseStateStore) ensureLoadedLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	if s.snapshotPath == nil {
		return
	}
	path := s.snapshotPath()
	if path == "" {
		return
	}
	data, err := readResponseSnapshot(path)
	if err != nil || s.loadSnapshotLocked(data) != nil {
		return
	}
	s.pruneLocked()
}

func (s *ResponseStateStore) setEntryLocked(id string, state storedResponse) {
	s.deleteEntryLocked(id)
	raw, err := json.Marshal(state.Items)
	if err == nil {
		state.Size = len(raw)
	}
	s.states[id] = state
	s.bytes += state.Size
}

func (s *ResponseStateStore) deleteEntryLocked(id string) {
	state, ok := s.states[id]
	if !ok {
		return
	}
	delete(s.states, id)
	s.bytes -= state.Size
	if s.bytes < 0 {
		s.bytes = 0
	}
}

func (s *ResponseStateStore) pruneLocked() {
	now := s.now()
	for id, state := range s.states {
		if now.Sub(state.CreatedAt) > responseTTL {
			s.deleteEntryLocked(id)
		}
	}
	for len(s.states) > maxStoredResponses {
		if id := s.oldestIDLocked(); id != "" {
			s.deleteEntryLocked(id)
		} else {
			break
		}
	}
	for s.bytes > s.byteCap && len(s.states) > 1 {
		if id := s.oldestIDLocked(); id != "" {
			s.deleteEntryLocked(id)
		} else {
			break
		}
	}
}

func (s *ResponseStateStore) oldestIDLocked() string {
	var id string
	var created time.Time
	for candidate, state := range s.states {
		if id == "" || state.CreatedAt.Before(created) || (state.CreatedAt.Equal(created) && candidate < id) {
			id, created = candidate, state.CreatedAt
		}
	}
	return id
}

func (s *ResponseStateStore) schedulePersistLocked() {
	if s.snapshotPath == nil || s.persistTimer != nil {
		return
	}
	path := s.snapshotPath()
	if path == "" {
		return
	}
	s.pendingPath = path
	delay := s.debounce
	if delay <= 0 {
		delay = responseSnapshotDebounce
	}
	s.persistTimer = time.AfterFunc(delay, func() { _ = s.persistScheduled(path) })
}

func (s *ResponseStateStore) persistScheduled(path string) error {
	s.mu.Lock()
	if s.pendingPath != path {
		s.mu.Unlock()
		return nil
	}
	s.persistTimer = nil
	s.pendingPath = ""
	data, err := s.snapshotLocked()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return writeResponseSnapshot(path, data)
}

func inputItems(value any) []any {
	switch input := value.(type) {
	case nil:
		return nil
	case []any:
		return append([]any{}, input...)
	case string:
		return []any{map[string]any{"role": "user", "content": input}}
	default:
		return []any{input}
	}
}

func cloneMap(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}

func cloneProvider(value ProviderState) ProviderState {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var result ProviderState
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	return result
}
