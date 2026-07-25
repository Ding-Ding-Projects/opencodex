package cursor

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	CursorConversationIDMetadata         = "cursorConversationId"
	CursorClientThreadIDMetadata         = "cursorClientThreadId"
	CursorIdentityScopeMetadata          = "cursorIdentityScope"
	CursorIsolateConversationMetadata    = "cursorIsolateConversation"
	CursorForceFreshConversationMetadata = "cursorForceFreshConversation"

	cursorContinuityTTL        = time.Hour
	cursorContinuityMaxEntries = 2048
)

type threadContinuityEntry struct {
	key            string
	conversationID string
	updatedAt      time.Time
}

type threadContinuityStore struct {
	mu         sync.Mutex
	ttl        time.Duration
	maxEntries int
	now        func() time.Time
	entries    map[string]*list.Element
	order      *list.List
}

func newThreadContinuityStore(ttl time.Duration, maxEntries int, now func() time.Time) *threadContinuityStore {
	return &threadContinuityStore{
		ttl: ttl, maxEntries: maxEntries, now: now,
		entries: make(map[string]*list.Element), order: list.New(),
	}
}

var defaultThreadContinuity = newThreadContinuityStore(cursorContinuityTTL, cursorContinuityMaxEntries, time.Now)

// CursorThreadScopeKey namespaces a client thread by the authenticated identity
// that owns its upstream Cursor conversation.
func CursorThreadScopeKey(threadID, identityScope string) string {
	identityScope = strings.TrimSpace(identityScope)
	if identityScope == "" {
		identityScope = "local"
	}
	return identityScope + "\x00" + threadID
}

func (s *threadContinuityStore) Remember(threadID, conversationID, identityScope string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	key := CursorThreadScopeKey(threadID, identityScope)
	if element, ok := s.entries[key]; ok {
		s.order.Remove(element)
	}
	element := s.order.PushBack(threadContinuityEntry{key: key, conversationID: conversationID, updatedAt: now})
	s.entries[key] = element
	s.prune(now)
}

func (s *threadContinuityStore) Lookup(threadID, identityScope string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := CursorThreadScopeKey(threadID, identityScope)
	element, ok := s.entries[key]
	if !ok {
		return "", false
	}
	entry := element.Value.(threadContinuityEntry)
	now := s.now()
	if now.Sub(entry.updatedAt) > s.ttl {
		s.remove(element)
		return "", false
	}
	entry.updatedAt = now
	element.Value = entry
	s.order.MoveToBack(element)
	return entry.conversationID, true
}

func (s *threadContinuityStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = make(map[string]*list.Element)
	s.order.Init()
}

func (s *threadContinuityStore) prune(now time.Time) {
	for element := s.order.Front(); element != nil; element = s.order.Front() {
		entry := element.Value.(threadContinuityEntry)
		if now.Sub(entry.updatedAt) <= s.ttl {
			break
		}
		s.remove(element)
	}
	for len(s.entries) > s.maxEntries {
		s.remove(s.order.Front())
	}
}

func (s *threadContinuityStore) remove(element *list.Element) {
	if element == nil {
		return
	}
	entry := element.Value.(threadContinuityEntry)
	delete(s.entries, entry.key)
	s.order.Remove(element)
}

func RememberCursorThreadConversation(threadID, conversationID, identityScope string) {
	defaultThreadContinuity.Remember(threadID, conversationID, identityScope)
}

func LookupCursorThreadConversation(threadID, identityScope string) (string, bool) {
	return defaultThreadContinuity.Lookup(threadID, identityScope)
}

func ClearCursorThreadContinuity() { defaultThreadContinuity.Clear() }

// CursorConversationIDFromClientThread derives an opaque provider-scoped id.
func CursorConversationIDFromClientThread(threadID, identityScope string) string {
	identityScope = strings.TrimSpace(identityScope)
	if identityScope == "" {
		identityScope = "local"
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte("ocx:cursor:thread:"))
	_, _ = digest.Write([]byte(identityScope))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(threadID))
	return "cursor_" + hex.EncodeToString(digest.Sum(nil)[:16])
}

func generatedCursorConversationID() string {
	return "cursor_" + strings.ReplaceAll(newID(), "-", "")
}

func resolveCursorConversationID(req *types.NormalizedRequest) string {
	metadata := req.Metadata
	if metadata[CursorForceFreshConversationMetadata] == "true" || metadata[CursorIsolateConversationMetadata] == "true" {
		return generatedCursorConversationID()
	}
	if conversationID := strings.TrimSpace(metadata[CursorConversationIDMetadata]); conversationID != "" {
		return conversationID
	}
	threadID := strings.TrimSpace(metadata[CursorClientThreadIDMetadata])
	if threadID != "" {
		identityScope := metadata[CursorIdentityScopeMetadata]
		if conversationID, ok := LookupCursorThreadConversation(threadID, identityScope); ok {
			return conversationID
		}
		return CursorConversationIDFromClientThread(threadID, identityScope)
	}
	return generatedCursorConversationID()
}
