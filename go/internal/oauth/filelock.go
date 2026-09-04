package oauth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// inProcessLocks provides context-aware goroutine-level exclusion on top of the
// OS file lock. macOS flock is process-scoped, so two goroutines in the same
// process can both succeed at flock simultaneously.
var inProcessLocks sync.Map // map[string]*inProcessLock

type inProcessLock struct{ token chan struct{} }

func newInProcessLock() *inProcessLock {
	lock := &inProcessLock{token: make(chan struct{}, 1)}
	lock.token <- struct{}{}
	return lock
}

func getInProcessMutex(path string) *inProcessLock {
	v, _ := inProcessLocks.LoadOrStore(path, newInProcessLock())
	return v.(*inProcessLock)
}

type fileLock struct {
	file *os.File
	mu   *inProcessLock
}

func acquireFileLock(ctx context.Context, path string) (*fileLock, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("lock credential file: %w", err)
	}
	// In-process mutex: serialise goroutines within the same binary.
	mu := getInProcessMutex(path)
	select {
	case <-mu.token:
	case <-ctx.Done():
		return nil, fmt.Errorf("lock credential file: %w", ctx.Err())
	}
	if err := ctx.Err(); err != nil {
		mu.token <- struct{}{}
		return nil, fmt.Errorf("lock credential file: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		mu.token <- struct{}{}
		return nil, fmt.Errorf("create lock directory: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		mu.token <- struct{}{}
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	_ = f.Chmod(0o600)

	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			_ = f.Close()
			mu.token <- struct{}{}
			return nil, fmt.Errorf("lock credential file: %w", err)
		}
		err = tryLockFile(f)
		if err == nil {
			return &fileLock{file: f, mu: mu}, nil
		}
		if !errors.Is(err, errLockBusy) {
			_ = f.Close()
			mu.token <- struct{}{}
			return nil, fmt.Errorf("lock credential file: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			mu.token <- struct{}{}
			return nil, fmt.Errorf("lock credential file: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (l *fileLock) release() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := unlockFile(l.file)
	closeErr := l.file.Close()
	l.file = nil
	if l.mu != nil {
		l.mu.token <- struct{}{}
	}
	if err != nil {
		return err
	}
	return closeErr
}
