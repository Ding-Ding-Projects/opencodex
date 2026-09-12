package grok

import (
	"strings"
	"testing"
)

// The defect this pins: the managed fence carried the model's id, name, base URL, headers and
// context window, and silently dropped its reasoning ladder. The registry already knew the
// ladder, so a Grok user of the native port got a config with no effort picker at all while the
// proxy wrote the full menu for the same model. The differential in test/parity is what caught
// it, but that check needs a Bun runtime; this one is decisive on its own.
func TestManagedBlockCarriesTheModelsEffortLadder(t *testing.T) {
	block := BuildGrokManagedBlock(10190, []InjectModel{{
		ID:               "gpt-5.6-sol",
		ContextWindow:    372000,
		ReasoningEfforts: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
	}}, "127.0.0.1", nil, nil)

	for _, want := range []string{
		"supports_reasoning_effort = true",
		`reasoning_effort = "medium"`,
		"[[model.ocx-gpt-5-6-sol.reasoning_efforts]]",
		`label = "Low"`,
		`description = "Quick, fast implementations"`,
		`label = "Max"`,
		`description = "Maximum reasoning effort"`,
	} {
		if !strings.Contains(block, want) {
			t.Errorf("managed block is missing %q\n%s", want, block)
		}
	}

	// `ultra` is a Codex rung Grok's CLI does not accept, so emitting it would put an
	// unusable option in the picker.
	if strings.Contains(block, `id = "ultra"`) {
		t.Errorf("managed block offers the Codex-only ultra rung\n%s", block)
	}

	// Exactly one option is the default, and it is the one the scalar names.
	if got := strings.Count(block, "default = true"); got != 1 {
		t.Errorf("default option count = %d, want 1\n%s", got, block)
	}

	// The array-of-tables has to follow every parent keyval, or TOML binds the tables to
	// the wrong parent. The inline extra_headers is the last one that used to move.
	headers := strings.Index(block, "extra_headers")
	window := strings.Index(block, "context_window")
	first := strings.Index(block, "[[model.")
	if headers < 0 || window < 0 || first < 0 || !(headers < window && window < first) {
		t.Errorf("parent keyvals must precede the picker tables; got headers=%d window=%d tables=%d\n%s",
			headers, window, first, block)
	}
}

func TestModelWithoutALadderKeepsTheEffortKeysOut(t *testing.T) {
	block := BuildGrokManagedBlock(10190, []InjectModel{{
		ID:            "alpha",
		ContextWindow: 131072,
	}}, "127.0.0.1", nil, nil)

	for _, unwanted := range []string{"supports_reasoning_effort", "reasoning_effort", "reasoning_efforts"} {
		if strings.Contains(block, unwanted) {
			t.Errorf("a model with no ladder must not emit %q\n%s", unwanted, block)
		}
	}
}

func TestConfiguredDefaultIsHonouredOnlyWhenItIsOnTheLadder(t *testing.T) {
	onLadder := BuildGrokManagedBlock(10190, []InjectModel{{
		ID:                     "alpha",
		ReasoningEfforts:       []string{"low", "medium", "high"},
		DefaultReasoningEffort: "high",
	}}, "127.0.0.1", nil, nil)
	if !strings.Contains(onLadder, `reasoning_effort = "high"`) {
		t.Errorf("configured default on the ladder was not honoured\n%s", onLadder)
	}

	// `ultra` is dropped by sanitization, so the configured default is no longer on the
	// ladder and the medium-then-high-then-first fallback picks instead.
	offLadder := BuildGrokManagedBlock(10190, []InjectModel{{
		ID:                     "alpha",
		ReasoningEfforts:       []string{"low", "medium", "high"},
		DefaultReasoningEffort: "ultra",
	}}, "127.0.0.1", nil, nil)
	if !strings.Contains(offLadder, `reasoning_effort = "medium"`) {
		t.Errorf("a default that is off the ladder must fall back to medium\n%s", offLadder)
	}
}

func TestLadderOrderAndDuplicatesFollowTheCatalog(t *testing.T) {
	block := BuildGrokManagedBlock(10190, []InjectModel{{
		ID:               "alpha",
		ReasoningEfforts: []string{"high", "low", "high", "bogus", "minimal"},
	}}, "127.0.0.1", nil, nil)

	var ids []string
	for _, line := range strings.Split(block, "\n") {
		if strings.HasPrefix(line, "id = ") {
			ids = append(ids, strings.Trim(strings.TrimPrefix(line, "id = "), `"`))
		}
	}
	want := []string{"high", "low", "minimal"}
	if len(ids) != len(want) {
		t.Fatalf("picker options = %v, want %v\n%s", ids, want, block)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("picker options = %v, want %v (catalog order, no duplicates, no unknown rungs)", ids, want)
		}
	}
}
