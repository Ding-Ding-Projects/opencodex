package storage

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testCoordinator(t *testing.T, defaultHome string) *MutationCoordinator {
	t.Helper()
	c := NewMutationCoordinator()
	c.resolveDefault = func() string { return defaultHome }
	return c
}

// The slot is exclusive: a second caller is refused rather than queued,
// because these operations move files and rewrite four SQLite stores, and a
// queued caller would run against a preview digest that has since gone stale.
func TestOnlyOneMutationHoldsAHomeAtATime(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	if !c.TryAcquire(MutationCleanup, Home("/tmp/home")) {
		t.Fatal("the first acquisition must succeed")
	}
	for _, kind := range []MutationKind{MutationCleanup, MutationRestore, MutationPolicy} {
		if c.TryAcquire(kind, Home("/tmp/home")) {
			t.Fatalf("%s acquired a held slot; all three kinds share one slot", kind)
		}
	}
	active, held := c.Active(Home("/tmp/home"))
	if !held || active.Kind != MutationCleanup {
		t.Fatalf("active = %+v held=%v, want the cleanup holder", active, held)
	}
	c.Release(Home("/tmp/home"))
	if _, held := c.Active(Home("/tmp/home")); held {
		t.Fatal("the slot survived its release")
	}
	if !c.TryAcquire(MutationRestore, Home("/tmp/home")) {
		t.Fatal("a released slot must be acquirable again")
	}
}

// Different homes do not contend.
func TestDifferentHomesHaveIndependentSlots(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	if !c.TryAcquire(MutationCleanup, Home("/tmp/one")) {
		t.Fatal("first home")
	}
	if !c.TryAcquire(MutationCleanup, Home("/tmp/two")) {
		t.Fatal("a second home must not be blocked by the first")
	}
}

// The key is the LEXICALLY resolved path, so spellings of one directory share
// a slot. Missing this would let two cleanups run against the same home.
func TestSlotKeyCollapsesEquivalentSpellings(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	if !c.TryAcquire(MutationCleanup, Home("/tmp/home")) {
		t.Fatal("first acquisition")
	}
	for _, spelling := range []string{"/tmp/home/", "/tmp/home/.", "/tmp/home/sub/..", "/tmp//home"} {
		if c.TryAcquire(MutationRestore, Home(spelling)) {
			t.Fatalf("%q was treated as a different home; it is the same directory", spelling)
		}
	}
}

// Resolution is LEXICAL, not physical: the oracle does not realpath or
// case-fold, so on case-insensitive macOS these remain separate slots.
// "improving" this would make Go refuse a mutation TypeScript allows.
func TestSlotKeyDoesNotCaseFold(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	if !c.TryAcquire(MutationCleanup, Home("/tmp/Codex")) {
		t.Fatal("first acquisition")
	}
	if !c.TryAcquire(MutationCleanup, Home("/tmp/codex")) {
		t.Fatal("a case-differing path is a different slot in the oracle; Go must not fold it")
	}
}

// An ABSENT home and an explicit empty string are different slots: the oracle
// resolves the first through resolveCodexHomeDir and the second to the process
// working directory.
func TestAbsentHomeIsNotTheEmptyString(t *testing.T) {
	c := testCoordinator(t, "/tmp/resolved-default")
	if !c.TryAcquire(MutationCleanup, DefaultHome()) {
		t.Fatal("the default home must be acquirable")
	}
	cwd, err := filepath.Abs("")
	if err != nil {
		t.Fatal(err)
	}
	if cwd == "/tmp/resolved-default" {
		t.Skip("the working directory happens to equal the fake default")
	}
	if !c.TryAcquire(MutationCleanup, Home("")) {
		t.Fatal(`an explicit "" resolves to the working directory, which is a different slot from the default home`)
	}
	// And the default really did key on the resolved default, not on "".
	if _, held := c.Active(Home("/tmp/resolved-default")); !held {
		t.Fatal("the absent home did not key on the resolved default")
	}
}

// WithSlot refuses without running the work at all.
func TestWithSlotRefusesWithoutRunningTheWork(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	if !c.TryAcquire(MutationCleanup, Home("/tmp/home")) {
		t.Fatal("seed the slot")
	}
	ran := false
	err := c.WithSlot(MutationRestore, Home("/tmp/home"), func() error {
		ran = true
		return nil
	})
	if ran {
		t.Fatal("the work ran despite the slot being held")
	}
	if !IsMutationBusy(err) {
		t.Fatalf("err = %v, want the busy refusal", err)
	}
	if err.Error() != ErrMutationBusy {
		t.Fatalf("error text = %q, want %q", err.Error(), ErrMutationBusy)
	}
}

// A failing operation must not strand the slot and lock the home until the
// process restarts.
func TestWithSlotReleasesOnFailureAndPanic(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	sentinel := errors.New("work failed")
	if err := c.WithSlot(MutationCleanup, Home("/tmp/home"), func() error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want the work's own error", err)
	}
	if _, held := c.Active(Home("/tmp/home")); held {
		t.Fatal("a failed operation stranded the slot")
	}

	func() {
		defer func() { _ = recover() }()
		_ = c.WithSlot(MutationCleanup, Home("/tmp/home"), func() error { panic("boom") })
	}()
	if _, held := c.Active(Home("/tmp/home")); held {
		t.Fatal("a panicking operation stranded the slot")
	}
}

// The mutex guards the slot map only. Holding it across the work would make a
// contender BLOCK until the mutation finished instead of being refused, which
// is the queue the oracle explicitly does not have.
func TestContenderIsRefusedImmediatelyWhileWorkRuns(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	started := make(chan struct{})
	finish := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = c.WithSlot(MutationCleanup, Home("/tmp/home"), func() error {
			close(started)
			<-finish
			return nil
		})
	}()
	<-started

	refused := make(chan error, 1)
	go func() {
		refused <- c.WithSlot(MutationRestore, Home("/tmp/home"), func() error { return nil })
	}()
	select {
	case err := <-refused:
		if !IsMutationBusy(err) {
			t.Fatalf("err = %v, want the busy refusal", err)
		}
	case <-time.After(2 * time.Second):
		close(finish)
		wg.Wait()
		t.Fatal("the contender blocked instead of being refused; the gate became a queue")
	}
	close(finish)
	wg.Wait()
}

// Concurrent acquisition must admit exactly one winner. The check and the
// claim are one critical section; splitting them lets two callers both see an
// empty slot.
func TestConcurrentAcquisitionAdmitsExactlyOne(t *testing.T) {
	for round := 0; round < 200; round++ {
		c := testCoordinator(t, "/tmp/home")
		var wins int32
		var mu sync.Mutex
		var wg sync.WaitGroup
		start := make(chan struct{})
		for worker := 0; worker < 8; worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if c.TryAcquire(MutationCleanup, Home("/tmp/home")) {
					mu.Lock()
					wins++
					mu.Unlock()
				}
			}()
		}
		close(start)
		wg.Wait()
		if wins != 1 {
			t.Fatalf("round %d: %d winners, want exactly 1", round, wins)
		}
	}
}

// Reset clears the hooks AND every slot, so one test cannot strand another.
func TestResetForTestsClearsHooksAndSlots(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	c.SetBlockForTests(50 * time.Millisecond)
	if !c.TryAcquire(MutationCleanup, Home("/tmp/home")) {
		t.Fatal("seed the slot")
	}
	c.ResetForTests()
	if _, held := c.Active(Home("/tmp/home")); held {
		t.Fatal("reset left a slot held")
	}
	start := time.Now()
	if err := c.WithSlot(MutationCleanup, Home("/tmp/home"), func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 25*time.Millisecond {
		t.Fatalf("work took %v; reset did not clear the block hook", elapsed)
	}
}

// The block hook delays AFTER acquisition and BEFORE the work, which is what
// lets a race test observe a contender being refused.
func TestBlockHookDelaysBetweenAcquisitionAndWork(t *testing.T) {
	c := testCoordinator(t, "/tmp/home")
	c.SetBlockForTests(80 * time.Millisecond)
	start := time.Now()
	var workAt time.Time
	if err := c.WithSlot(MutationCleanup, Home("/tmp/home"), func() error {
		workAt = time.Now()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if workAt.Sub(start) < 70*time.Millisecond {
		t.Fatalf("work started after %v; the block hook did not apply", workAt.Sub(start))
	}
	// Only a positive value blocks.
	c.SetBlockForTests(0)
	start = time.Now()
	if err := c.WithSlot(MutationCleanup, Home("/tmp/home"), func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 25*time.Millisecond {
		t.Fatalf("a zero block still delayed for %v", elapsed)
	}
}
