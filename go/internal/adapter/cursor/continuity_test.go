package cursor

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestContinuityRetryErrorContract(t *testing.T) {
	cause := errors.New("invalid_argument")
	err := &ContinuityRetryError{Err: cause}
	if !IsContinuityRetry(err) || !errors.Is(err, cause) || err.Error() != cause.Error() {
		t.Fatalf("retry error contract failed: %v", err)
	}
}

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

func TestResolveCursorConversationIDUsesProductionRequestFields(t *testing.T) {
	ClearCursorThreadContinuity()
	t.Cleanup(ClearCursorThreadContinuity)
	request := &types.NormalizedRequest{ClientThreadID: "thread-live", CursorIdentity: "account-live"}
	want := CursorConversationIDFromClientThread("thread-live", "account-live")
	if got := resolveCursorConversationID(request); got != want {
		t.Fatalf("resolved conversation = %q, want %q", got, want)
	}
	request.CursorConversation = "cursor_previous"
	if got := resolveCursorConversationID(request); got != "cursor_previous" {
		t.Fatalf("continued conversation = %q", got)
	}
	request.IsolateCursor = true
	if got := resolveCursorConversationID(request); got == "cursor_previous" || got == want {
		t.Fatalf("isolated conversation reused state: %q", got)
	}
}
