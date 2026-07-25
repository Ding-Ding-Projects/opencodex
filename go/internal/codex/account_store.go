package codex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const maxAccountStoreBytes = 8 << 20

// AccountCredentials is the JSON-compatible credential stored by the TypeScript runtime.
// ExpiresAt is an epoch millisecond timestamp.
type AccountCredentials struct {
	AccessToken      string `json:"accessToken"`
	RefreshToken     string `json:"refreshToken"`
	ExpiresAt        int64  `json:"expiresAt"`
	ChatGPTAccountID string `json:"chatgptAccountId"`
}

type AccountValidationStatus string

const (
	AccountValidationOK     AccountValidationStatus = "ok"
	AccountValidationFailed AccountValidationStatus = "failed"
)

// AccountRecord wraps a credential with a monotonic generation and lifecycle metadata.
type AccountRecord struct {
	Credential                *AccountCredentials     `json:"credential,omitempty"`
	Generation                int64                   `json:"generation"`
	RefreshGrantFingerprint   string                  `json:"refreshGrantFingerprint,omitempty"`
	DeletedAt                 *int64                  `json:"deletedAt,omitempty"`
	ReplacedAt                *int64                  `json:"replacedAt,omitempty"`
	LastCodexValidatedAt      *int64                  `json:"lastCodexValidatedAt,omitempty"`
	LastCodexValidationStatus AccountValidationStatus `json:"lastCodexValidationStatus,omitempty"`
	LastCodexValidationError  string                  `json:"lastCodexValidationError,omitempty"`
}

var accountStoreLocks sync.Map // map[absolute path]*sync.Mutex

// AccountStore persists codex-accounts.json records.
type AccountStore struct {
	path string
	now  func() time.Time
}

func NewAccountStore(path string) *AccountStore {
	return &AccountStore{path: path, now: time.Now}
}

func (s *AccountStore) Path() string { return s.path }

func RefreshGrantFingerprint(refreshToken string) string {
	digest := sha256.Sum256([]byte("codex-refresh-grant:" + refreshToken))
	return hex.EncodeToString(digest[:])
}

func accountStoreMutex(path string) *sync.Mutex {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	value, _ := accountStoreLocks.LoadOrStore(absolute, &sync.Mutex{})
	return value.(*sync.Mutex)
}

// Load returns only live credentials, matching the legacy TypeScript public API.
func (s *AccountStore) Load() (map[string]AccountCredentials, error) {
	records, err := s.loadRecords()
	if err != nil {
		return nil, err
	}
	credentials := make(map[string]AccountCredentials)
	for id, record := range records {
		if record.DeletedAt == nil && record.Credential != nil {
			credentials[id] = *record.Credential
		}
	}
	return credentials, nil
}

func (s *AccountStore) loadRecords() (map[string]AccountRecord, error) {
	file, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]AccountRecord{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open Codex account store: %w", err)
	}
	defer file.Close()
	_ = file.Chmod(0o600)

	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(file, maxAccountStoreBytes))
	if err := decoder.Decode(&raw); err != nil {
		_ = s.backupInvalid()
		return map[string]AccountRecord{}, nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		_ = s.backupInvalid()
		return map[string]AccountRecord{}, nil
	}
	records := make(map[string]AccountRecord, len(raw))
	for id, encoded := range raw {
		if record, ok := decodeAccountRecord(encoded); ok {
			records[id] = record
		}
	}
	return records, nil
}

func decodeAccountRecord(encoded json.RawMessage) (AccountRecord, bool) {
	var shape map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &shape)
	var record AccountRecord
	if _, wrapped := shape["generation"]; wrapped && json.Unmarshal(encoded, &record) == nil && validAccountRecord(record) {
		if record.Credential != nil && record.RefreshGrantFingerprint == "" {
			record.RefreshGrantFingerprint = RefreshGrantFingerprint(record.Credential.RefreshToken)
		}
		return record, true
	}
	var credential AccountCredentials
	if err := json.Unmarshal(encoded, &credential); err == nil && validAccountCredential(credential) {
		return AccountRecord{
			Credential:              &credential,
			Generation:              0,
			RefreshGrantFingerprint: RefreshGrantFingerprint(credential.RefreshToken),
		}, true
	}
	return AccountRecord{}, false
}

func validAccountCredential(credential AccountCredentials) bool {
	return credential.AccessToken != "" && credential.RefreshToken != "" && credential.ChatGPTAccountID != ""
}

func validAccountRecord(record AccountRecord) bool {
	if record.Generation < 0 || record.Credential != nil && !validAccountCredential(*record.Credential) {
		return false
	}
	return record.LastCodexValidationStatus == "" ||
		record.LastCodexValidationStatus == AccountValidationOK ||
		record.LastCodexValidationStatus == AccountValidationFailed
}

func (s *AccountStore) backupInvalid() error {
	backup := fmt.Sprintf("%s.invalid-%d", s.path, s.now().UnixMilli())
	if err := os.Rename(s.path, backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *AccountStore) persist(records map[string]AccountRecord) error {
	encoded, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Codex account store: %w", err)
	}
	encoded = append(encoded, '\n')
	if err := atomicWriteFile(s.path, encoded, 0o600); err != nil {
		return fmt.Errorf("persist Codex account store: %w", err)
	}
	return nil
}

func (s *AccountStore) mutate(fn func(map[string]AccountRecord) error) error {
	mutex := accountStoreMutex(s.path)
	mutex.Lock()
	defer mutex.Unlock()
	records, err := s.loadRecords()
	if err != nil {
		return err
	}
	if err := fn(records); err != nil {
		return err
	}
	return s.persist(records)
}

func (s *AccountStore) GetCredential(id string) (AccountCredentials, bool, error) {
	record, ok, err := s.ReadRecord(id)
	if err != nil || !ok || record.DeletedAt != nil || record.Credential == nil {
		return AccountCredentials{}, false, err
	}
	return *record.Credential, true, nil
}

func (s *AccountStore) ReadRecord(id string) (AccountRecord, bool, error) {
	records, err := s.loadRecords()
	if err != nil {
		return AccountRecord{}, false, err
	}
	record, ok := records[id]
	return record, ok, nil
}

func (s *AccountStore) SaveCredential(id string, credential AccountCredentials) error {
	if id == "" || !validAccountCredential(credential) {
		return errors.New("account id and complete Codex credential are required")
	}
	return s.mutate(func(records map[string]AccountRecord) error {
		current, exists := records[id]
		fingerprint := RefreshGrantFingerprint(credential.RefreshToken)
		if exists && current.Credential != nil && current.Credential.RefreshToken == credential.RefreshToken && current.RefreshGrantFingerprint != "" {
			fingerprint = current.RefreshGrantFingerprint
		}
		next := AccountRecord{
			Credential:                &credential,
			Generation:                current.Generation + 1,
			RefreshGrantFingerprint:   fingerprint,
			LastCodexValidatedAt:      current.LastCodexValidatedAt,
			LastCodexValidationStatus: current.LastCodexValidationStatus,
			LastCodexValidationError:  current.LastCodexValidationError,
		}
		if exists {
			now := s.now().UnixMilli()
			next.ReplacedAt = &now
		}
		records[id] = next
		return nil
	})
}

func (s *AccountStore) SaveCredentialIfGeneration(id string, generation int64, credential AccountCredentials) (bool, error) {
	if !validAccountCredential(credential) {
		return false, errors.New("complete Codex credential is required")
	}
	saved := false
	err := s.mutate(func(records map[string]AccountRecord) error {
		current, ok := records[id]
		if !ok || current.Generation != generation || current.DeletedAt != nil || current.Credential == nil {
			return nil
		}
		fingerprint := RefreshGrantFingerprint(credential.RefreshToken)
		if current.Credential.RefreshToken == credential.RefreshToken && current.RefreshGrantFingerprint != "" {
			fingerprint = current.RefreshGrantFingerprint
		}
		records[id] = AccountRecord{
			Credential:                &credential,
			Generation:                generation + 1,
			RefreshGrantFingerprint:   fingerprint,
			ReplacedAt:                current.ReplacedAt,
			LastCodexValidatedAt:      current.LastCodexValidatedAt,
			LastCodexValidationStatus: current.LastCodexValidationStatus,
			LastCodexValidationError:  current.LastCodexValidationError,
		}
		saved = true
		return nil
	})
	return saved, err
}

func (s *AccountStore) MarkValidated(id string, at time.Time) error {
	return s.mutate(func(records map[string]AccountRecord) error {
		record, ok := records[id]
		if !ok || record.DeletedAt != nil || record.Credential == nil {
			return nil
		}
		millis := at.UnixMilli()
		record.LastCodexValidatedAt = &millis
		record.LastCodexValidationStatus = AccountValidationOK
		record.LastCodexValidationError = ""
		records[id] = record
		return nil
	})
}

func (s *AccountStore) MarkValidationFailed(id, reason string) error {
	return s.mutate(func(records map[string]AccountRecord) error {
		record, ok := records[id]
		if !ok || record.DeletedAt != nil || record.Credential == nil {
			return nil
		}
		record.LastCodexValidationStatus = AccountValidationFailed
		record.LastCodexValidationError = reason
		records[id] = record
		return nil
	})
}

func (s *AccountStore) Tombstone(id string) (int64, error) {
	var generation int64
	err := s.mutate(func(records map[string]AccountRecord) error {
		generation = records[id].Generation + 1
		now := s.now().UnixMilli()
		records[id] = AccountRecord{Generation: generation, DeletedAt: &now}
		return nil
	})
	return generation, err
}

func (s *AccountStore) RemoveCredential(id string) error {
	_, err := s.Tombstone(id)
	return err
}

func (s *AccountStore) ListAccountIDs() ([]string, error) {
	credentials, err := s.Load()
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(credentials))
	for id := range credentials {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

func (s *AccountStore) IsGenerationLive(id string, generation int64) bool {
	record, ok, err := s.ReadRecord(id)
	return err == nil && ok && record.Credential != nil && record.DeletedAt == nil && record.Generation == generation
}
