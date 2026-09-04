package cursor

import (
	"sync"
	"time"
)

const (
	defaultContextUsageMaxEntries = 200
	defaultContextUsageTTL        = time.Hour
)

type contextUsageEntry struct {
	tokens    int
	updatedAt time.Time
}

type ContextUsageControls struct {
	CarryForwardTokens  int
	RecordContextTokens func(int)
}

type ContextUsageTracker struct {
	mu         sync.Mutex
	entries    map[string]contextUsageEntry
	maxEntries int
	ttl        time.Duration
	now        func() time.Time
}

func NewContextUsageTracker() *ContextUsageTracker {
	return newContextUsageTracker(defaultContextUsageMaxEntries, defaultContextUsageTTL, time.Now)
}

func newContextUsageTracker(maxEntries int, ttl time.Duration, now func() time.Time) *ContextUsageTracker {
	return &ContextUsageTracker{entries: map[string]contextUsageEntry{}, maxEntries: maxEntries, ttl: ttl, now: now}
}

func (t *ContextUsageTracker) ControlsForConversation(conversationID string, clearPrior, storeCheckpoints bool) ContextUsageControls {
	if clearPrior {
		t.Clear(conversationID)
	}
	controls := ContextUsageControls{}
	if !storeCheckpoints {
		return controls
	}
	controls.CarryForwardTokens, _ = t.Get(conversationID)
	controls.RecordContextTokens = func(tokens int) { t.Record(conversationID, tokens) }
	return controls
}

func (t *ContextUsageTracker) Get(conversationID string) (int, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	entry, ok := t.entries[conversationID]
	if !ok {
		return 0, false
	}
	entry.updatedAt = t.now()
	t.entries[conversationID] = entry
	return entry.tokens, true
}

func (t *ContextUsageTracker) Record(conversationID string, tokens int) {
	if conversationID == "" || tokens <= 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	if current := t.entries[conversationID].tokens; current > tokens {
		tokens = current
	}
	t.entries[conversationID] = contextUsageEntry{tokens: tokens, updatedAt: t.now()}
	t.pruneLocked()
}

func (t *ContextUsageTracker) Rekey(fromConversationID, toConversationID string) {
	if fromConversationID == "" || toConversationID == "" || fromConversationID == toConversationID {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	from, ok := t.entries[fromConversationID]
	if !ok {
		return
	}
	if to := t.entries[toConversationID]; to.tokens > from.tokens {
		from.tokens = to.tokens
	}
	delete(t.entries, fromConversationID)
	t.entries[toConversationID] = contextUsageEntry{tokens: from.tokens, updatedAt: t.now()}
}

func (t *ContextUsageTracker) Clear(conversationID string) {
	t.mu.Lock()
	delete(t.entries, conversationID)
	t.mu.Unlock()
}

func (t *ContextUsageTracker) ClearAll() {
	t.mu.Lock()
	t.entries = map[string]contextUsageEntry{}
	t.mu.Unlock()
}

func (t *ContextUsageTracker) pruneLocked() {
	now := t.now()
	for id, entry := range t.entries {
		if now.Sub(entry.updatedAt) > t.ttl {
			delete(t.entries, id)
		}
	}
	for len(t.entries) > t.maxEntries {
		oldestID := ""
		var oldest time.Time
		for id, entry := range t.entries {
			if oldestID == "" || entry.updatedAt.Before(oldest) {
				oldestID, oldest = id, entry.updatedAt
			}
		}
		delete(t.entries, oldestID)
	}
}
