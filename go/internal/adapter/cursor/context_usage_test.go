package cursor

import (
	"testing"
	"time"
)

func TestContextUsageTrackerMonotonicRekeyAndExpiry(t *testing.T) {
	now := time.Unix(1_000, 0)
	tracker := newContextUsageTracker(2, time.Minute, func() time.Time { return now })
	tracker.Record("a", 100)
	tracker.Record("a", 90)
	if got, ok := tracker.Get("a"); !ok || got != 100 {
		t.Fatalf("a = %d, %v", got, ok)
	}
	tracker.Record("b", 120)
	tracker.Rekey("a", "b")
	if got, ok := tracker.Get("b"); !ok || got != 120 {
		t.Fatalf("rekeyed b = %d, %v", got, ok)
	}
	now = now.Add(2 * time.Minute)
	if _, ok := tracker.Get("b"); ok {
		t.Fatal("expired context usage was retained")
	}
}

func TestEventParserCarriesAndRecordsAbsoluteContext(t *testing.T) {
	recorded := 0
	parser := NewEventParser(EventParserOptions{
		CarryForwardTokens:  200,
		RecordContextTokens: func(tokens int) { recorded = tokens },
	})
	checkpoint := appendMessage(nil, 5, appendVarintField(nil, 1, 150))
	if _, err := parser.Parse(appendMessage(nil, 3, checkpoint)); err != nil {
		t.Fatal(err)
	}
	if recorded != 150 {
		t.Fatalf("recorded = %d", recorded)
	}
	tokenAndEnd := appendMessage(nil, 8, appendVarintField(nil, 1, 25))
	tokenAndEnd = appendMessage(tokenAndEnd, 14, nil)
	events, err := parser.Parse(appendMessage(nil, 1, tokenAndEnd))
	if err != nil {
		t.Fatal(err)
	}
	usage := events[0].Usage
	if usage == nil || usage.TotalTokens != 200 || usage.InputTokens != 175 || usage.OutputTokens != 25 || !usage.Estimated {
		t.Fatalf("usage = %#v", usage)
	}
}
