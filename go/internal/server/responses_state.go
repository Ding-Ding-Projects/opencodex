package server

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	maxStoredResponses        = 1000
	responseStateTTL          = time.Hour
	maxStoredResponseBytes    = 64 << 20
	responseSnapshotEntryMax  = 2 << 20
	responseSnapshotTotalMax  = 24 << 20
	responseSnapshotDebounce  = 2 * time.Second
	responseStateTempGrace    = 15 * time.Minute
	responseStateTempEntries  = 4096
	responseStateTempCleanups = 512
	responseStateTempMaxSafe  = uint64(1<<53 - 1)
)

var responseStateTempSequence atomic.Uint64

type ResponseStateTempRecoveryResult struct {
	Matched      int
	Removed      int
	Failed       int
	BytesRemoved int64
}

type responseStateTempDir interface {
	ReadDir(int) ([]os.DirEntry, error)
	Close() error
}

type responseStateTempRecoveryIO struct {
	now           func() time.Time
	openDir       func(string) (responseStateTempDir, error)
	inspect       func(string) (os.FileInfo, error)
	processExists func(int) bool
	unlink        func(string) error
	currentPID    int
	maxEntries    int
	maxCleanups   int
}

func defaultResponseStateTempRecoveryIO() responseStateTempRecoveryIO {
	return responseStateTempRecoveryIO{
		now:           time.Now,
		openDir:       func(path string) (responseStateTempDir, error) { return os.Open(path) },
		inspect:       os.Lstat,
		processExists: platform.ProcessExists,
		unlink:        unlinkResponseStateTemp,
		currentPID:    os.Getpid(),
		maxEntries:    responseStateTempEntries,
		maxCleanups:   responseStateTempCleanups,
	}
}

func responseStateTempDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func parseResponseStateTempName(snapshotPath, name string) (int, uint64, bool, bool) {
	prefix := filepath.Base(snapshotPath) + ".ocx."
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".tmp") {
		return 0, 0, false, false
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".tmp"), ".")
	if len(parts) != 2 || !responseStateTempDigits(parts[0]) || !responseStateTempDigits(parts[1]) {
		return 0, 0, false, false
	}
	pidValue, err := strconv.ParseUint(parts[0], 10, 64)
	if err != nil || pidValue == 0 || pidValue > responseStateTempMaxSafe || pidValue > uint64(^uint(0)>>1) {
		return 0, 0, true, false
	}
	sequence, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil || sequence == 0 || sequence > responseStateTempMaxSafe {
		return 0, 0, true, false
	}
	return int(pidValue), sequence, true, true
}

func recoverStaleResponseStateTemps(snapshotPath string, recoveryIO responseStateTempRecoveryIO) ResponseStateTempRecoveryResult {
	result := ResponseStateTempRecoveryResult{}
	if snapshotPath == "" || recoveryIO.maxEntries <= 0 || recoveryIO.maxCleanups <= 0 {
		return result
	}
	directory, err := recoveryIO.openDir(filepath.Dir(snapshotPath))
	if err != nil {
		return result
	}
	defer directory.Close()

	scanned := 0
	for scanned < recoveryIO.maxEntries && result.Removed+result.Failed < recoveryIO.maxCleanups {
		entries, readErr := directory.ReadDir(1)
		if len(entries) == 0 {
			if readErr != nil {
				return result
			}
			continue
		}
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return result
		}
		scanned++
		entry := entries[0]
		pid, _, matches, valid := parseResponseStateTempName(snapshotPath, entry.Name())
		if !matches {
			continue
		}
		result.Matched++
		if !valid {
			continue
		}
		path := filepath.Join(filepath.Dir(snapshotPath), entry.Name())
		info, inspectErr := recoveryIO.inspect(path)
		if inspectErr == nil && info.Mode().IsRegular() && recoveryIO.now().Sub(info.ModTime()) >= responseStateTempGrace && pid != recoveryIO.currentPID && !recoveryIO.processExists(pid) {
			if recoveryIO.unlink(path) == nil {
				result.Removed++
				result.BytesRemoved += info.Size()
			} else {
				result.Failed++
			}
		}
		if readErr != nil {
			return result
		}
	}
	return result
}

func createResponseStateTemp(snapshotPath string) (*os.File, string, error) {
	for {
		sequence := responseStateTempSequence.Add(1)
		if sequence == 0 {
			continue
		}
		if sequence > responseStateTempMaxSafe {
			return nil, "", errors.New("response-state temp sequence exhausted")
		}
		path := snapshotPath + ".ocx." + strconv.Itoa(os.Getpid()) + "." + strconv.FormatUint(sequence, 10) + ".tmp"
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return file, path, err
	}
}

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
	_ = recoverStaleResponseStateTemps(s.path, defaultResponseStateTempRecoveryIO())
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
	temporary, temporaryPath, err := createResponseStateTemp(s.path)
	if err != nil {
		return
	}
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
