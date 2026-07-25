package cursor

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestThreadContinuityStoreScopesRefreshesAndExpires(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := newThreadContinuityStore(time.Hour, 2, func() time.Time { return now })

	store.Remember("thread", "conversation-a", "account-a")
	store.Remember("thread", "conversation-b", "account-b")
	if got, ok := store.Lookup("thread", "account-a"); !ok || got != "conversation-a" {
		t.Fatalf("account-a lookup = %q, %v", got, ok)
	}
	if got, ok := store.Lookup("thread", "account-b"); !ok || got != "conversation-b" {
		t.Fatalf("account-b lookup = %q, %v", got, ok)
	}

	now = now.Add(30 * time.Minute)
	if _, ok := store.Lookup("thread", "account-a"); !ok {
		t.Fatal("refreshed account-a entry was not found")
	}
	store.Remember("new-thread", "conversation-c", "account-a")
	if _, ok := store.Lookup("thread", "account-b"); ok {
		t.Fatal("least-recently-used account-b entry survived capacity pruning")
	}

	now = now.Add(time.Hour + time.Nanosecond)
	if _, ok := store.Lookup("thread", "account-a"); ok {
		t.Fatal("expired account-a entry survived TTL pruning")
	}
}

func TestResolveCursorConversationIDUsesThreadIdentityAndRecovery(t *testing.T) {
	ClearCursorThreadContinuity()
	t.Cleanup(ClearCursorThreadContinuity)

	first := CursorConversationIDFromClientThread("thread-1", "account-a")
	if first != CursorConversationIDFromClientThread("thread-1", "account-a") {
		t.Fatal("thread-derived conversation id is not deterministic")
	}
	if first == CursorConversationIDFromClientThread("thread-1", "account-b") {
		t.Fatal("identity scope did not namespace the conversation id")
	}

	RememberCursorThreadConversation("thread-1", "cursor_recovered", "account-a")
	req := &types.NormalizedRequest{
		ModelID: "cursor/gpt-5.6-sol",
		Metadata: map[string]string{
			CursorClientThreadIDMetadata: "thread-1",
			CursorIdentityScopeMetadata:  "account-a",
		},
		Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
	}
	built, err := BuildAgentRunRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if built.Run.ConversationID != "cursor_recovered" {
		t.Fatalf("remembered conversation id = %q", built.Run.ConversationID)
	}

	req.Metadata[CursorIsolateConversationMetadata] = "true"
	isolated, err := BuildAgentRunRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if isolated.Run.ConversationID == "cursor_recovered" || isolated.Run.ConversationID == first {
		t.Fatalf("isolated conversation reused shared state: %q", isolated.Run.ConversationID)
	}
}
