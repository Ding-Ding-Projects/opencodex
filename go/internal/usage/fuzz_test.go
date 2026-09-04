package usage

import (
	"math/big"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func FuzzNormalizeCostTokens(f *testing.F) {
	f.Add(0, 0, 0, 0, 0)
	f.Add(100, 20, 30, 10, 0)
	f.Add(int(^uint(0)>>1), 1, int(^uint(0)>>1), 0, 1)
	f.Fuzz(func(t *testing.T, input, output, cached, read, write int) {
		if input < 0 || output < 0 || cached < 0 || read < 0 || write < 0 {
			return
		}
		tokens, ok := NormalizeCostTokens(types.Usage{
			InputTokens: input, OutputTokens: output, CachedInputTokens: cached,
			CacheReadInputTokens: read, CacheCreationInputTokens: write,
		})
		if !ok {
			return
		}
		if tokens.Input < 0 || tokens.Output < 0 || tokens.CacheRead < 0 || tokens.CacheWrite < 0 {
			t.Fatalf("normalization returned negative tokens: %#v", tokens)
		}
		total := new(big.Int).SetInt64(int64(tokens.Input))
		total.Add(total, new(big.Int).SetInt64(int64(tokens.CacheRead)))
		total.Add(total, new(big.Int).SetInt64(int64(tokens.CacheWrite)))
		if total.Cmp(new(big.Int).SetInt64(int64(input))) != 0 || tokens.Output != output {
			t.Fatalf("normalization changed totals: input=%d output=%d tokens=%#v", input, output, tokens)
		}
	})
}

func FuzzCanonicalTotalNeverWraps(f *testing.F) {
	f.Add(0, 0, 0)
	f.Add(10, 20, 40)
	f.Add(int(^uint(0)>>1), 1, 0)
	f.Fuzz(func(t *testing.T, input, output, reported int) {
		if input < 0 || output < 0 || reported < 0 {
			return
		}
		total := CanonicalTotal(types.Usage{InputTokens: input, OutputTokens: output, TotalTokens: reported})
		if total < input || total < output || total < reported {
			t.Fatalf("canonical total wrapped or decreased: input=%d output=%d reported=%d total=%d", input, output, reported, total)
		}
	})
}
