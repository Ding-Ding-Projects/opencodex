package combos

import (
	"fmt"
	"testing"
)

func BenchmarkPickTarget128(b *testing.B) {
	targets := make([]Target, 128)
	providers := make(map[string]Provider, len(targets))
	for index := range targets {
		provider := fmt.Sprintf("provider_%d", index)
		targets[index] = Target{Provider: provider, Model: "model", Weight: index%10 + 1}
		providers[provider] = Provider{}
	}
	resolver, err := New(map[string]Combo{"bench": {Strategy: StrategyRoundRobin, StickyLimit: 1, Targets: targets}}, providers)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		pick, err := resolver.PickTarget("combo/bench")
		if err != nil {
			b.Fatal(err)
		}
		resolver.NoteSuccess(pick)
	}
}
