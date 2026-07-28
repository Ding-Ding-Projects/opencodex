package oauth

// Smooth weighted round-robin with sticky selection, ported from
// src/codex/pool-rotation.ts.
//
// The state is PER POOL, not per request: rotation only means anything if the
// ring position survives between selections. Everything here is pure given the
// eligible-id list, so the selection path never performs I/O.

import (
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

// Pool keys, matching the oracle's POOL_KEY_* constants.
const (
	PoolKeyCodex     = "codex"
	PoolKeyAnthropic = "anthropic"
)

type selectionState struct {
	activeKey     string
	hasActiveKey  bool
	successes     int
	currentWeight map[string]int
}

func (s *selectionState) clone() *selectionState {
	weights := make(map[string]int, len(s.currentWeight))
	for id, weight := range s.currentWeight {
		weights[id] = weight
	}
	return &selectionState{
		activeKey:     s.activeKey,
		hasActiveKey:  s.hasActiveKey,
		successes:     s.successes,
		currentWeight: weights,
	}
}

// RotationRegistry holds the per-pool selection state.
//
// The oracle keeps this in a module-level map; an explicit registry is used
// here so tests can start from a known state instead of inheriting whatever a
// previous test left behind.
type RotationRegistry struct {
	mu    sync.Mutex
	pools map[string]*selectionState
}

func NewRotationRegistry() *RotationRegistry {
	return &RotationRegistry{pools: map[string]*selectionState{}}
}

func (r *RotationRegistry) state(poolKey string) *selectionState {
	if r.pools == nil {
		r.pools = map[string]*selectionState{}
	}
	existing, found := r.pools[poolKey]
	if !found {
		existing = &selectionState{currentWeight: map[string]int{}}
		r.pools[poolKey] = existing
	}
	return existing
}

// smoothWeightedIndex advances the ring by one unit-weight step.
//
// Every eligible id gains one point, the highest scorer wins, and the winner
// then pays back the total weight handed out. With unit weights that produces a
// stable rotation, and a FIRST-maximum tie-break means the caller's input order
// decides ties rather than map iteration order.
func smoothWeightedIndex(ids []string, state *selectionState) int {
	best := -1
	bestScore := 0
	total := 0
	for index, id := range ids {
		score := state.currentWeight[id] + 1
		state.currentWeight[id] = score
		total++
		if best < 0 || score > bestScore {
			best, bestScore = index, score
		}
	}
	if best >= 0 {
		winner := ids[best]
		state.currentWeight[winner] -= total
	}
	return best
}

func pickRoundRobinFromState(eligibleIDs []string, stickyLimit int, state *selectionState, commitSticky bool) (string, bool) {
	if len(eligibleIDs) == 0 {
		return "", false
	}
	limit := config.NormalizedAccountPoolStickyLimit(&stickyLimit)

	// A held account short-circuits the ring entirely, but only while it is
	// still eligible: a cooled-down or reauth-pending account must not be
	// handed out just because it was sticky.
	if state.hasActiveKey {
		for _, id := range eligibleIDs {
			if id == state.activeKey {
				return state.activeKey, true
			}
		}
		state.activeKey, state.hasActiveKey, state.successes = "", false, 0
	}

	index := smoothWeightedIndex(eligibleIDs, state)
	if index < 0 {
		return "", false
	}
	picked := eligibleIDs[index]
	// A limit of 1 means "no stickiness", so nothing is held.
	if commitSticky && limit > 1 {
		state.activeKey, state.hasActiveKey, state.successes = picked, true, 0
	}
	return picked, true
}

// PickRoundRobinAccount advances the ring and returns the selected id.
func (r *RotationRegistry) PickRoundRobinAccount(poolKey string, eligibleIDs []string, stickyLimit int) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return pickRoundRobinFromState(eligibleIDs, stickyLimit, r.state(poolKey), true)
}

// PeekRoundRobinAccount reports what PickRoundRobinAccount would return WITHOUT
// advancing the ring, so a dashboard preview cannot perturb live rotation.
func (r *RotationRegistry) PeekRoundRobinAccount(poolKey string, eligibleIDs []string, stickyLimit int) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	live, found := r.pools[poolKey]
	scratch := &selectionState{currentWeight: map[string]int{}}
	if found {
		scratch = live.clone()
	}
	return pickRoundRobinFromState(eligibleIDs, stickyLimit, scratch, false)
}

// NoteRotationSuccess records one successful new-session bind.
//
// The hold is released on the Nth success rather than after it, which is what
// makes stickyLimit a count of BINDS rather than of releases.
func (r *RotationRegistry) NoteRotationSuccess(poolKey, accountID string, stickyLimit int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	limit := config.NormalizedAccountPoolStickyLimit(&stickyLimit)
	state, found := r.pools[poolKey]
	if !found {
		// The oracle returns early when no state exists, so a success for a
		// pool that never selected anything is not allowed to create one.
		return
	}
	if !state.hasActiveKey || state.activeKey != accountID {
		state.activeKey, state.hasActiveKey, state.successes = accountID, true, 0
	}
	state.successes++
	if state.successes >= limit {
		state.activeKey, state.hasActiveKey, state.successes = "", false, 0
	}
}

// NoteRotationFailure drops the hold immediately.
//
// A failing account must not keep receiving new sessions for the remainder of
// its sticky budget, so failure clears rather than decrements.
func (r *RotationRegistry) NoteRotationFailure(poolKey, accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state, found := r.pools[poolKey]
	if found && state.hasActiveKey && state.activeKey == accountID {
		state.activeKey, state.hasActiveKey, state.successes = "", false, 0
	}
}

// SeedRotationAccount forces the next pick onto accountID, for a manual
// dashboard selection. The ring weights are cleared so the seeded account is
// held for the next new-session pick before ordinary rotation resumes.
func (r *RotationRegistry) SeedRotationAccount(poolKey, accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.state(poolKey)
	state.activeKey, state.hasActiveKey, state.successes = accountID, true, 0
	state.currentWeight = map[string]int{}
}
