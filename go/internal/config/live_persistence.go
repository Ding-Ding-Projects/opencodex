package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// LivePersistence serializes every write made by a long-lived runtime and
// protects user edits to claudeCode with an eagerly captured three-way baseline.
// Short-lived CLI commands intentionally continue to call Save directly.
type LivePersistence struct {
	mu       sync.RWMutex
	path     string
	config   *Config
	baseline json.RawMessage
	save     func(string, *Config) error
	configMu *sync.RWMutex
}

// NewLivePersistence arms protection immediately for the long-lived config.
func NewLivePersistence(path string, cfg *Config) *LivePersistence {
	store := &LivePersistence{path: path, config: cfg, save: Save}
	store.baseline = marshalClaudeCode(cfg)
	return store
}

func marshalClaudeCode(cfg *Config) json.RawMessage {
	if cfg == nil {
		return json.RawMessage("null")
	}
	data, err := json.Marshal(cfg.ClaudeCode)
	if err != nil {
		return json.RawMessage("null")
	}
	return data
}

func rawClaudeCode(path string) (json.RawMessage, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return nil, false
	}
	if raw, ok := object["claudeCode"]; ok {
		return raw, true
	}
	return json.RawMessage("null"), true
}

func semanticJSONEqual(left, right json.RawMessage) bool {
	var leftValue, rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return false
	}
	return deepEqualJSON(leftValue, rightValue)
}

func deepEqualJSON(left, right any) bool {
	switch leftValue := left.(type) {
	case nil:
		return right == nil
	case bool:
		rightValue, ok := right.(bool)
		return ok && leftValue == rightValue
	case string:
		rightValue, ok := right.(string)
		return ok && leftValue == rightValue
	case float64:
		rightValue, ok := right.(float64)
		return ok && leftValue == rightValue
	case []any:
		rightValue, ok := right.([]any)
		if !ok || len(leftValue) != len(rightValue) {
			return false
		}
		for index := range leftValue {
			if !deepEqualJSON(leftValue[index], rightValue[index]) {
				return false
			}
		}
		return true
	case map[string]any:
		rightValue, ok := right.(map[string]any)
		if !ok || len(leftValue) != len(rightValue) {
			return false
		}
		for key, value := range leftValue {
			if !deepEqualJSON(value, rightValue[key]) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// Save persists the currently held config under the shared runtime write lock.
func (p *LivePersistence) Save() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.configMu != nil {
		p.configMu.Lock()
		defer p.configMu.Unlock()
	}
	return p.saveTransactionalLocked()
}

// BindConfigMutex connects the persistence owner to the management API's
// existing config lock. Update then protects readers that predate this owner
// while the persistence RWMutex protects the newer runtime projections.
func (p *LivePersistence) BindConfigMutex(mu *sync.RWMutex) {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.configMu = mu
	p.mu.Unlock()
}

// Read keeps a dynamic runtime projection on one stable config image while a
// request-path writer may be selecting and persisting a replacement value.
func (p *LivePersistence) Read(read func(*Config)) {
	if p == nil || read == nil {
		return
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	read(p.config)
}

// Snapshot returns a detached config image for lower-frequency projections
// that need to traverse several nested fields after releasing the read lock.
func (p *LivePersistence) Snapshot() *Config {
	if p == nil {
		return nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	cloned, err := cloneConfig(p.config)
	if err != nil {
		return nil
	}
	return cloned
}

// Serialize runs one complete long-lived mutation while holding the shared
// writer lock. Code inside run must persist with SaveAssumingLocked.
func (p *LivePersistence) Serialize(run func()) {
	if p == nil {
		if run != nil {
			run()
		}
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if run != nil {
		run()
	}
}

// SaveAssumingLocked persists from inside Serialize without reacquiring the
// non-reentrant writer lock. It still rolls back claudeCode preservation if the
// durable write fails.
func (p *LivePersistence) SaveAssumingLocked() error {
	if p == nil {
		return nil
	}
	return p.saveTransactionalLocked()
}

// Update serializes a live mutation and its durable save with every other
// long-lived writer. A failed save restores the complete pre-update config so
// request-path callers never publish an in-memory-only mutation.
func (p *LivePersistence) Update(update func(*Config)) error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.configMu != nil {
		p.configMu.Lock()
		defer p.configMu.Unlock()
	}
	previous, err := cloneConfig(p.config)
	if err != nil {
		return err
	}
	if update != nil {
		update(p.config)
	}
	if err := p.saveLocked(); err != nil {
		*p.config = *previous
		return err
	}
	return nil
}

func (p *LivePersistence) saveTransactionalLocked() error {
	previous, err := cloneConfig(p.config)
	if err != nil {
		return err
	}
	if err := p.saveLocked(); err != nil {
		*p.config = *previous
		return err
	}
	return nil
}

func cloneConfig(cfg *Config) (*Config, error) {
	if cfg == nil {
		return nil, &ConfigError{Field: "config", Message: "must not be nil"}
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("snapshot config: %w", err)
	}
	var cloned Config
	if err := json.Unmarshal(data, &cloned); err != nil {
		return nil, fmt.Errorf("restore config snapshot: %w", err)
	}
	return &cloned, nil
}

func (p *LivePersistence) saveLocked() error {
	if p.config == nil || p.path == "" {
		return nil
	}
	runtimeValue := marshalClaudeCode(p.config)
	if diskValue, ok := rawClaudeCode(p.path); ok {
		diskChanged := !semanticJSONEqual(diskValue, p.baseline)
		runtimeChanged := !semanticJSONEqual(runtimeValue, p.baseline)
		if diskChanged && !runtimeChanged {
			var preserved *ClaudeCodeConfig
			if !bytes.Equal(bytes.TrimSpace(diskValue), []byte("null")) {
				if err := json.Unmarshal(diskValue, &preserved); err == nil {
					p.config.ClaudeCode = preserved
				}
			} else {
				p.config.ClaudeCode = nil
			}
		}
	}
	save := p.save
	if save == nil {
		save = Save
	}
	if err := save(p.path, p.config); err != nil {
		return err
	}
	p.baseline = marshalClaudeCode(p.config)
	return nil
}
