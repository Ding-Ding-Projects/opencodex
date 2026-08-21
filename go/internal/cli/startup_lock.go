package cli

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

type startupLockRecord struct {
	PID   int    `json:"pid"`
	Nonce string `json:"nonce"`
}

type startupLock struct {
	Path  string
	PID   int
	Nonce string
}

func newStartupNonce() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

// acquireStartupLock serializes starts across processes. A pre-existing lock
// is removed only after its recorded owner is independently proven dead and a
// compare-before-delete confirms no newer process replaced the bytes.
func acquireStartupLock(path string, pid int, now time.Time, alive func(int) bool) (startupLock, error) {
	if pid <= 0 {
		pid = os.Getpid()
	}
	if alive == nil {
		alive = processAlive
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return startupLock{}, err
	}
	nonce, err := newStartupNonce()
	if err != nil {
		return startupLock{}, err
	}
	record := startupLockRecord{PID: pid, Nonce: nonce}
	data, err := json.Marshal(record)
	if err != nil {
		return startupLock{}, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		file, createErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if createErr == nil {
			if _, writeErr := file.Write(append(data, '\n')); writeErr != nil {
				_ = file.Close()
				_ = os.Remove(path)
				return startupLock{}, writeErr
			}
			if closeErr := file.Close(); closeErr != nil {
				_ = os.Remove(path)
				return startupLock{}, closeErr
			}
			_ = now // retained for deterministic callers and future stale-age diagnostics
			return startupLock{Path: path, PID: pid, Nonce: nonce}, nil
		}
		if !errors.Is(createErr, os.ErrExist) {
			return startupLock{}, createErr
		}
		current, readErr := os.ReadFile(path)
		if readErr != nil {
			if errors.Is(readErr, os.ErrNotExist) {
				continue
			}
			return startupLock{}, readErr
		}
		var owner startupLockRecord
		if json.Unmarshal(current, &owner) != nil || owner.PID <= 0 || owner.Nonce == "" {
			return startupLock{}, fmt.Errorf("startup lock is owned by an unknown process")
		}
		if alive(owner.PID) {
			return startupLock{}, fmt.Errorf("startup already in progress (PID %d)", owner.PID)
		}
		latest, latestErr := os.ReadFile(path)
		if latestErr != nil || string(latest) != string(current) {
			continue
		}
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return startupLock{}, removeErr
		}
	}
	return startupLock{}, fmt.Errorf("startup lock changed while recovering")
}

func releaseStartupLock(path string, lock startupLock) error {
	if path == "" {
		path = lock.Path
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var owner startupLockRecord
	if json.Unmarshal(data, &owner) != nil || owner.PID != lock.PID || owner.Nonce != lock.Nonce {
		return nil
	}
	latest, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if string(latest) == string(data) {
		return os.Remove(path)
	}
	return nil
}

func processAlive(pid int) bool {
	return pid > 0 && platform.ProcessAlive(pid)
}
