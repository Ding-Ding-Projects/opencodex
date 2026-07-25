package lib

import (
	"sync"
	"time"
)

type Breadcrumb struct {
	InFlight  int    `json:"inFlight"`
	LastLabel string `json:"lastLabel"`
	SinceMS   int64  `json:"sinceMs"`
}
type ActivityBreadcrumb struct {
	Note    string `json:"note"`
	SinceMS int64  `json:"sinceMs"`
}
type SidecarTracker struct {
	mu                      sync.Mutex
	inFlight                int
	lastLabel               string
	lastEnter, lastActivity time.Time
	activity                string
	now                     func() time.Time
}

func NewSidecarTracker() *SidecarTracker { return &SidecarTracker{now: time.Now} }
func (t *SidecarTracker) Enter(label string) func() {
	t.mu.Lock()
	t.inFlight++
	t.lastLabel = label
	t.lastEnter = t.now()
	t.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			t.mu.Lock()
			if t.inFlight > 0 {
				t.inFlight--
			}
			t.mu.Unlock()
		})
	}
}
func (t *SidecarTracker) Breadcrumb() Breadcrumb {
	t.mu.Lock()
	defer t.mu.Unlock()
	ms := int64(0)
	if !t.lastEnter.IsZero() {
		ms = t.now().Sub(t.lastEnter).Milliseconds()
	}
	return Breadcrumb{InFlight: t.inFlight, LastLabel: t.lastLabel, SinceMS: ms}
}
func (t *SidecarTracker) MarkActivity(note string) {
	t.mu.Lock()
	t.activity = note
	t.lastActivity = t.now()
	t.mu.Unlock()
}
func (t *SidecarTracker) Activity() ActivityBreadcrumb {
	t.mu.Lock()
	defer t.mu.Unlock()
	ms := int64(0)
	if !t.lastActivity.IsZero() {
		ms = t.now().Sub(t.lastActivity).Milliseconds()
	}
	return ActivityBreadcrumb{Note: t.activity, SinceMS: ms}
}

var DefaultSidecarTracker = NewSidecarTracker()
