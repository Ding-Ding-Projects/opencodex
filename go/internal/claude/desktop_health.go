package claude

import (
	"sync"
	"time"
)

type DesktopHealthStatus struct {
	LastRequestAt *time.Time `json:"lastRequestAt"`
	RequestCount  uint64     `json:"requestCount"`
	ErrorCount    uint64     `json:"errorCount"`
}

type DesktopHealthTracker struct {
	mu            sync.RWMutex
	lastRequestAt *time.Time
	requestCount  uint64
	errorCount    uint64
	now           func() time.Time
}

func NewDesktopHealthTracker() *DesktopHealthTracker {
	return &DesktopHealthTracker{now: time.Now}
}

func (tracker *DesktopHealthTracker) RecordRequest() {
	now := tracker.now().UTC()
	tracker.mu.Lock()
	tracker.lastRequestAt = &now
	tracker.requestCount++
	tracker.mu.Unlock()
}

func (tracker *DesktopHealthTracker) RecordError() {
	tracker.mu.Lock()
	tracker.errorCount++
	tracker.mu.Unlock()
}

func (tracker *DesktopHealthTracker) Status() DesktopHealthStatus {
	tracker.mu.RLock()
	defer tracker.mu.RUnlock()
	status := DesktopHealthStatus{RequestCount: tracker.requestCount, ErrorCount: tracker.errorCount}
	if tracker.lastRequestAt != nil {
		value := *tracker.lastRequestAt
		status.LastRequestAt = &value
	}
	return status
}

var defaultDesktopHealth = NewDesktopHealthTracker()

func RecordDesktopRequest() {
	defaultDesktopHealth.RecordRequest()
}

func RecordDesktopError() {
	defaultDesktopHealth.RecordError()
}

func GetDesktopHealth() DesktopHealthStatus {
	return defaultDesktopHealth.Status()
}
