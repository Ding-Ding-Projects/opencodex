package storage

import (
	"math"
	"path/filepath"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
)

// Single-flight gate for CODEX_HOME storage mutations, ported from
// src/storage/storage-mutation-coordinator.ts.
//
// Cleanup, trash restore and policy-driven cleanup all mutate the same home,
// so they share ONE slot per resolved CODEX_HOME. A second caller is refused
// immediately rather than queued: these operations move files and rewrite four
// SQLite stores, and a queue would leave the caller waiting on work whose
// preview digest has already gone stale by the time it ran.

// MutationKind names the three operations that contend for the slot.
type MutationKind string

const (
	MutationCleanup MutationKind = "cleanup"
	MutationRestore MutationKind = "restore"
	MutationPolicy  MutationKind = "policy"
)

// ErrMutationBusy is the wire error a refused caller sees. Management maps it
// to HTTP 409.
//
// It has no other producer: every occurrence originates from a failed
// acquisition, so a caller seeing it knows another mutation holds the home.
const ErrMutationBusy = "storage_mutation_busy"

// ActiveMutation describes the slot holder.
type ActiveMutation struct {
	Kind      MutationKind
	StartedAt time.Time
}

// HomeRef is a CODEX_HOME argument that can be ABSENT.
//
// The distinction is load-bearing and not a Go nicety: the oracle's optional
// parameter means "use resolveCodexHomeDir()", while an explicit empty string
// resolves to the process working directory. Those are two different slots, so
// a plain string API that treated "" as "not supplied" would merge them and
// let two mutations run against different homes under one lock -- or worse,
// against the same home under two.
type HomeRef struct {
	value   string
	present bool
}

// Home names an explicit CODEX_HOME, including the empty string.
func Home(path string) HomeRef { return HomeRef{value: path, present: true} }

// DefaultHome is the absent argument: resolve it the way the runtime would.
func DefaultHome() HomeRef { return HomeRef{} }

// MutationCoordinator holds one slot per resolved home.
//
// The oracle keeps a module-global map, so a port that created one coordinator
// per API object or per request would let two mutations run against the same
// home concurrently -- exactly what the gate exists to prevent. Callers share
// the process-wide instance returned by Mutations().
type MutationCoordinator struct {
	mu       sync.Mutex
	slots    map[string]ActiveMutation
	blockFor time.Duration
	// resolveDefault is the fallback for an absent home. It is a field so a
	// test can pin it without setting a process-wide environment variable.
	resolveDefault func() string
	now            func() time.Time
}

var processMutations = NewMutationCoordinator()

// Mutations returns the process-wide coordinator.
func Mutations() *MutationCoordinator { return processMutations }

// NewMutationCoordinator builds an isolated coordinator. Production code uses
// Mutations(); tests use this so one test cannot strand another's slot.
func NewMutationCoordinator() *MutationCoordinator {
	return &MutationCoordinator{slots: map[string]ActiveMutation{}, now: time.Now}
}

// slotKey resolves a home to its slot identity.
//
// The resolution is LEXICAL, matching Node's path.resolve: trailing slashes,
// relative paths and . / .. segments collapse, but symlinks are NOT followed
// and case is NOT folded. That is deliberate rather than an oversight to fix:
// on case-insensitive macOS the oracle still treats /tmp/Codex and /tmp/codex
// as different slots, so adding EvalSymlinks or case folding here would make
// Go refuse a mutation the TypeScript runtime allows.
func (c *MutationCoordinator) slotKey(home HomeRef) string {
	raw := home.value
	if !home.present {
		raw = c.defaultHome()
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		// Abs only fails when the working directory is unavailable. Falling
		// back to the cleaned input keeps the gate closed rather than letting
		// an unkeyable home run unguarded.
		return filepath.Clean(raw)
	}
	return absolute
}

func (c *MutationCoordinator) defaultHome() string {
	if c.resolveDefault != nil {
		return c.resolveDefault()
	}
	return codex.ResolveCodexHome(codex.HomeOptions{})
}

// Active reports the current holder for a home, if any.
//
// It returns a COPY: handing back a reference into the map would let a caller
// observe a slot mutating underneath it, and would race with Release.
func (c *MutationCoordinator) Active(home HomeRef) (ActiveMutation, bool) {
	key := c.slotKey(home)
	c.mu.Lock()
	defer c.mu.Unlock()
	active, held := c.slots[key]
	return active, held
}

// TryAcquire takes the slot or reports that it is busy. It never blocks.
//
// The check and the claim are ONE critical section. Splitting them would let
// two callers both observe an empty slot and both proceed, which is the race
// the single-threaded oracle gets for free.
func (c *MutationCoordinator) TryAcquire(kind MutationKind, home HomeRef) bool {
	key := c.slotKey(home)
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, held := c.slots[key]; held {
		return false
	}
	c.slots[key] = ActiveMutation{Kind: kind, StartedAt: c.now()}
	return true
}

// Release frees the slot. It is unowned, matching the oracle: any holder may
// release, and releasing a free slot is a no-op rather than an error.
func (c *MutationCoordinator) Release(home HomeRef) {
	key := c.slotKey(home)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.slots, key)
}

// SetBlockForTests makes an acquired slot linger before the work runs, so a
// race test can observe a contender being refused.
func (c *MutationCoordinator) SetBlockForTests(block time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.blockFor = block
}

// ResetForTests clears both the hooks and every slot.
func (c *MutationCoordinator) ResetForTests() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.blockFor = 0
	c.slots = map[string]ActiveMutation{}
}

// blockDuration reads the hook under the lock. Only a finite positive value
// blocks, and it is truncated to whole milliseconds like the oracle's floor.
func (c *MutationCoordinator) blockDuration() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.blockFor <= 0 || c.blockFor > math.MaxInt64/2 {
		return 0
	}
	return c.blockFor.Truncate(time.Millisecond)
}

// WithSlot runs work while holding the slot, or reports busy without running
// it at all.
//
// The mutex is NOT held across the work: it guards the slot map only. Holding
// it would make a contender block until the mutation finished instead of being
// refused immediately, turning the gate into the queue the oracle explicitly
// does not have.
func (c *MutationCoordinator) WithSlot(kind MutationKind, home HomeRef, work func() error) error {
	if !c.TryAcquire(kind, home) {
		return &MutationBusyError{Kind: kind}
	}
	// Registered immediately after acquisition so a panic in work cannot
	// strand the slot and lock the home until the process restarts.
	defer c.Release(home)
	if block := c.blockDuration(); block > 0 {
		time.Sleep(block)
	}
	return work()
}

// MutationBusyError is returned when the slot is held.
type MutationBusyError struct {
	Kind MutationKind
}

func (e *MutationBusyError) Error() string { return ErrMutationBusy }

// IsMutationBusy reports whether an error is the busy refusal.
func IsMutationBusy(err error) bool {
	_, busy := err.(*MutationBusyError)
	return busy
}
