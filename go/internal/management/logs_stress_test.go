package management

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestRequestLogRingConcurrentAccessIsBoundedAndRedacted(t *testing.T) {
	const capacity, writers, entriesPerWriter = 64, 12, 80
	log := NewRequestLog(capacity)
	secret := "sk-concurrency-secret-value"
	var wait sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			for index := 0; index < entriesPerWriter; index++ {
				attempt := log.Begin(fmt.Sprintf("provider-%d", writer%3), "model")
				log.Finish(attempt, 502, &types.Usage{InputTokens: index, OutputTokens: 1}, "Authorization: Bearer "+secret)
				if index%7 == 0 {
					_ = log.Entries("", "", capacity)
				}
			}
		}(writer)
	}
	for reader := 0; reader < 4; reader++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := 0; index < entriesPerWriter; index++ {
				_ = log.Entries("", "", capacity)
			}
		}()
	}
	wait.Wait()
	entries := log.Entries("", "", capacity+1)
	if len(entries) != capacity {
		t.Fatalf("ring size = %d, want %d", len(entries), capacity)
	}
	for _, entry := range entries {
		if strings.Contains(entry.UpstreamError, secret) {
			t.Fatalf("request log leaked credential material: %q", entry.UpstreamError)
		}
	}
}
