package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// The whole reason this hashes: every source is a client-controlled header, and
// a raw one would land an email or a short secret in a log file the user might
// paste into an issue.
func TestACorrelationIDIsNeverStoredRaw(t *testing.T) {
	raw := "person@example.com"
	stored := NormalizeLogConversationID(raw)
	if stored == "" {
		t.Fatal("a normal id produced nothing")
	}
	if strings.Contains(stored, raw) || stored == raw {
		t.Fatalf("the raw value survived: %q", stored)
	}
	if len(stored) != LogConversationIDLen {
		t.Fatalf("length = %d, want %d", len(stored), LogConversationIDLen)
	}
	// Hashed even when the input already looks like a digest: an exception for
	// "looks safe" is how raw values get in.
	if again := NormalizeLogConversationID(stored); again == stored {
		t.Fatal("an id that already looked hashed was passed through unhashed")
	}
	// Stable, or two requests in one conversation would not group.
	if NormalizeLogConversationID(raw) != stored {
		t.Fatal("the same input produced two different ids")
	}
}

// Inputs that would break a JSONL line or turn a header into work are refused
// rather than sanitised into something almost right.
func TestHostileCorrelationInputsAreRefused(t *testing.T) {
	for name, input := range map[string]string{
		"empty":           "",
		"whitespace only": "   \t ",
		"newline":         "thread\nid",
		"carriage return": "thread\rid",
		"null byte":       "thread\x00id",
		"DEL":             "thread\x7fid",
		"absurdly long":   strings.Repeat("a", logConversationInputMax+1),
	} {
		if got := NormalizeLogConversationID(input); got != "" {
			t.Fatalf("%s produced %q", name, got)
		}
	}
	// The boundary itself is accepted, so the cap is a cap and not an
	// off-by-one refusal of legitimate ids.
	if NormalizeLogConversationID(strings.Repeat("a", logConversationInputMax)) == "" {
		t.Fatal("an id exactly at the cap was refused")
	}
}

// A user pastes whichever id they can see: the digest from the Logs detail, or
// the session id their client shows them. Both have to work.
func TestFilteringAcceptsEitherTheDigestOrThePreimage(t *testing.T) {
	raw := "session-abc"
	stored := NormalizeLogConversationID(raw)
	if !MatchesLogConversationID(stored, stored) {
		t.Fatal("the stored digest did not match itself")
	}
	if !MatchesLogConversationID(stored, raw) {
		t.Fatal("the preimage did not match its own digest")
	}
	if !MatchesLogConversationID(stored, "  "+raw+"  ") {
		t.Fatal("a pasted id with surrounding whitespace did not match")
	}
	if MatchesLogConversationID(stored, "someone-else") {
		t.Fatal("an unrelated id matched")
	}
	// An entry with no correlation must never match a query, or it would be
	// grouped into a conversation it was not part of.
	if MatchesLogConversationID("", raw) || MatchesLogConversationID(stored, "") {
		t.Fatal("an empty side matched")
	}
}

// Priority order decides which id a turn joins. Taking a later source first
// would split one conversation across two ids when a client sends several.
func TestTheHighestPrioritySourceWins(t *testing.T) {
	all := ConversationIDFromResponsesRequest("parent", "session", "thread", "cursor")
	if all != NormalizeLogConversationID("parent") {
		t.Fatal("the parent thread did not win")
	}
	if got := ConversationIDFromResponsesRequest("", "session", "thread", "cursor"); got != NormalizeLogConversationID("session") {
		t.Fatal("the session header did not win over the thread header")
	}
	if got := ConversationIDFromResponsesRequest("", "", "thread", "cursor"); got != NormalizeLogConversationID("thread") {
		t.Fatal("the thread header did not win over the cursor id")
	}
	if got := ConversationIDFromResponsesRequest("", "", "", "cursor"); got != NormalizeLogConversationID("cursor") {
		t.Fatal("the cursor id was not used as the last resort")
	}
	// Nothing supplied means no correlation, not a fabricated group.
	if got := ConversationIDFromResponsesRequest("", "", "", ""); got != "" {
		t.Fatalf("an uncorrelated turn produced %q", got)
	}
	// A blank-but-PRESENT source DOES shadow the ones below it, matching the
	// oracle's `??`, which falls through on absent but not on empty. A client
	// sending an empty parent thread correlates on nothing rather than being
	// silently regrouped under a different id — and grouping identically
	// across runtimes is the only reason the digest is shared.
	if got := ConversationIDFromResponsesRequest("   ", "session", "", ""); got != "" {
		t.Fatalf("a present-but-blank parent fell through to %q", got)
	}
}

func TestBothSessionHeaderSpellingsAreRead(t *testing.T) {
	underscore := http.Header{}
	underscore.Set("session_id", "from-underscore")
	if SessionIDHeader(underscore) != "from-underscore" {
		t.Fatal("session_id was not read")
	}
	hyphen := http.Header{}
	hyphen.Set("session-id", "from-hyphen")
	if SessionIDHeader(hyphen) != "from-hyphen" {
		t.Fatal("session-id was not read")
	}
	if SessionIDHeader(http.Header{}) != "" {
		t.Fatal("an absent header produced a value")
	}
}

// Claude Desktop's fallback is derived from the MACHINE, not the conversation,
// so using it would group every Desktop request on a host into one thread.
func TestOnlyClaudeUserIDIsUsedForCorrelation(t *testing.T) {
	if got := ConversationIDFromClaudeMetadata(map[string]any{"user_id": "abc"}); got != NormalizeLogConversationID("abc") {
		t.Fatalf("user_id produced %q", got)
	}
	for name, metadata := range map[string]map[string]any{
		"nil":            nil,
		"absent user_id": {"other": "x"},
		"non-string":     {"user_id": 42},
	} {
		if got := ConversationIDFromClaudeMetadata(metadata); got != "" {
			t.Fatalf("%s produced %q", name, got)
		}
	}
}

// The filter is the point of the whole field.
func TestFilteringReturnsOnlyTheRequestedConversation(t *testing.T) {
	first := NormalizeLogConversationID("chat-one")
	second := NormalizeLogConversationID("chat-two")
	entries := []RequestLogEntry{
		{RequestID: "a", ConversationID: first, Provider: "p", Status: 200},
		{RequestID: "b", ConversationID: second, Provider: "p", Status: 200},
		{RequestID: "c", ConversationID: first, Provider: "p", Status: 200},
		{RequestID: "d", Provider: "p", Status: 200},
	}

	// Both the canonical query and its alias, and both the digest and the
	// preimage, must select the same two entries.
	for name, query := range map[string]url.Values{
		"conversationId with digest":   {"conversationId": {first}},
		"conversation alias":           {"conversation": {first}},
		"conversationId with preimage": {"conversationId": {"chat-one"}},
		"alias with preimage":          {"conversation": {"chat-one"}},
	} {
		filtered := FilterRequestLogs(entries, query)
		if len(filtered) != 2 || filtered[0].RequestID != "a" || filtered[1].RequestID != "c" {
			ids := []string{}
			for _, entry := range filtered {
				ids = append(ids, entry.RequestID)
			}
			t.Fatalf("%s selected %v, want [a c]", name, ids)
		}
	}

	// No filter returns everything, including the uncorrelated entry.
	if len(FilterRequestLogs(entries, url.Values{})) != 4 {
		t.Fatal("an unfiltered query dropped entries")
	}
}

// The field has to be POPULATED by a real request, not merely filterable.
func TestARealRequestCarriesItsConversationIntoTheLog(t *testing.T) {
	logs := NewRequestLogStore(16, nil)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, RequestLogs: logs,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
	})

	request := loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":true,"input":"hello"}`))
	request.Header.Set("session_id", "chat-from-a-real-request")
	core.ServeHTTP(httptest.NewRecorder(), request)

	entries := logs.Entries()
	if len(entries) == 0 {
		t.Fatal("nothing was logged")
	}
	last := entries[len(entries)-1]
	want := NormalizeLogConversationID("chat-from-a-real-request")
	if last.ConversationID != want {
		t.Fatalf("logged conversation = %q, want %q", last.ConversationID, want)
	}
	// And the raw header value must not be anywhere in the entry.
	if last.ConversationID == "chat-from-a-real-request" {
		t.Fatal("the raw header value was persisted")
	}
}

// A conversation started under the TypeScript proxy has to group with one
// continued under Go, so the digest must be identical across runtimes. Each
// value below was produced by RUNNING the oracle.
func TestDigestsMatchTheTypeScriptRuntime(t *testing.T) {
	for input, want := range map[string]string{
		"session-abc":              "df98a8544084cba1bfbcf00faea193bf",
		"person@example.com":       "542d240129883c019e106e3b1b2d3f3c",
		"chat-from-a-real-request": "8ce6a2715c20faec54c7bcb8c1eb986b",
		// Trimmed before hashing, so a pasted id with stray spaces still
		// groups with the same conversation.
		"  spaced  ": "4cf28831d09470e8185fbb6ace85c0ae",
		"日本語":        "77710aedc74ecfa33685e33a6c7df5cc",
	} {
		if got := NormalizeLogConversationID(input); got != want {
			t.Fatalf("%q hashed to %q, want the oracle's %q", input, got, want)
		}
	}
	// And the value exactly at the cap, which is accepted rather than refused.
	if got := NormalizeLogConversationID(strings.Repeat("a", 4096)); got != "c93eee2d0db02f10acc7460d9576e122" {
		t.Fatalf("the boundary input hashed to %q", got)
	}
}

// The Claude ingress has to CARRY the correlating id, or the value is
// unreachable from the surface that produces it.
//
// Go's chat/Claude surface does not write request-log entries at all today, so
// this proves the id survives translation and is available to whatever consumes
// it. Hashing stays in the server package so the persistence rule lives with
// the sanitising and the cap.
func TestTheClaudeIngressCarriesItsCorrelatingUserID(t *testing.T) {
	body := []byte(`{"model":"claude-sonnet-5","max_tokens":16,"metadata":{"user_id":"claude-person"},` +
		`"messages":[{"role":"user","content":"hi"}]}`)
	translation, err := claude.TranslateAnthropicRequest(body, nil)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if translation.ConversationUserID != "claude-person" {
		t.Fatalf("carried user id = %q", translation.ConversationUserID)
	}
	// It arrives RAW and is hashed by the consumer, so the digest matches what
	// the Responses surface would store for the same id.
	stored := ConversationIDFromClaudeMetadata(map[string]any{"user_id": translation.ConversationUserID})
	if stored != NormalizeLogConversationID("claude-person") {
		t.Fatalf("hashed to %q", stored)
	}

	// A request with no metadata correlates to nothing rather than to a
	// fabricated group.
	plain, err := claude.TranslateAnthropicRequest(
		[]byte(`{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`), nil)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if plain.ConversationUserID != "" {
		t.Fatalf("an uncorrelated request carried %q", plain.ConversationUserID)
	}
}

// The header boundary has to preserve present-versus-absent too, or the
// priority rule above cannot be expressed: an explicitly empty session_id
// shadows session-id exactly as it does in the oracle.
func TestAnExplicitlyEmptySessionHeaderShadowsTheOtherSpelling(t *testing.T) {
	both := http.Header{}
	both.Set("session_id", "")
	both.Set("session-id", "fallback")
	if got := SessionIDHeader(both); got != "" {
		t.Fatalf("an empty session_id fell through to %q", got)
	}
	// Absent, not empty: the other spelling is used.
	onlyHyphen := http.Header{}
	onlyHyphen.Set("session-id", "fallback")
	if got := SessionIDHeader(onlyHyphen); got != "fallback" {
		t.Fatalf("an absent session_id did not fall through: %q", got)
	}
}

// A stored id nobody can read is useless: the dashboard needs it to show the
// grouping and to build a link back to the same conversation.
func TestTheConversationIDReachesTheAPIPayload(t *testing.T) {
	stored := NormalizeLogConversationID("visible-chat")
	payload, err := json.Marshal(newRequestLogDTO(RequestLogEntry{
		RequestID: "a", Provider: "p", Model: "m", Status: 200, ConversationID: stored,
	}))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["conversationId"] != stored {
		t.Fatalf("payload conversationId = %v, want %q", decoded["conversationId"], stored)
	}

	// And an uncorrelated entry omits the key rather than shipping an empty
	// string the UI would have to special-case.
	plain, err := json.Marshal(newRequestLogDTO(RequestLogEntry{RequestID: "b", Provider: "p", Model: "m", Status: 200}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(plain), "conversationId") {
		t.Fatalf("an uncorrelated entry carried the key: %s", plain)
	}
}

// The cap counts UTF-16 code units, not bytes, because that is what the oracle
// counts. Capping on bytes would refuse ids TypeScript accepted, and the same
// conversation would stop grouping the moment it crossed runtimes.
//
// Every digest below came from RUNNING the oracle.
func TestTheInputCapCountsUTF16UnitsNotBytes(t *testing.T) {
	// 1366 CJK characters: 1366 UTF-16 units but 4098 UTF-8 bytes. A byte cap
	// would refuse this; the oracle accepts it.
	cjk := strings.Repeat("日", 1366)
	if got := NormalizeLogConversationID(cjk); got != "65f4f758677d200d1b188c41c24ead6e" {
		t.Fatalf("a 4098-byte CJK id hashed to %q, want the oracle's digest", got)
	}
	// 2048 astral characters: each costs TWO units, so this sits exactly on the
	// 4096 boundary and is accepted. Counting them as one unit each would let
	// through strings the oracle refuses.
	astral := strings.Repeat("😀", 2048)
	if got := NormalizeLogConversationID(astral); got != "55e55e79898ca22c448887e4f14ede68" {
		t.Fatalf("a 4096-unit astral id hashed to %q, want the oracle's digest", got)
	}
	// One astral character past the boundary is refused, which is what proves
	// the two-unit cost rather than the acceptance above.
	if got := NormalizeLogConversationID(strings.Repeat("😀", 2049)); got != "" {
		t.Fatalf("a 4098-unit astral id was accepted: %q", got)
	}
	// And one CJK character past it.
	if got := NormalizeLogConversationID(strings.Repeat("日", 4097)); got != "" {
		t.Fatalf("a 4097-unit CJK id was accepted: %q", got)
	}
}
