package storage

import (
	"time"
)

// Evaluating and running the cleanup policy, ported from
// src/storage/policy.ts.
//
// The entry points here are private on purpose. The oracle's
// `maybeRunDueStorageCleanupPolicy(reason)` fills in config load, config save
// and cleanup execution itself; none of those three are ported yet, so a
// same-named Go function demanding full injection would be a different API
// wearing the oracle's name. The public wrappers land with the defaults.

// BusyDeferMS is how far a run defers when the database is busy.
const BusyDeferMS = 15 * 60 * 1000

// PolicyNextRunAction is the closed set of things a run does to `nextRun`.
type PolicyNextRunAction string

const (
	// PolicyNextRunAdvance moves to the next scheduled time.
	PolicyNextRunAdvance PolicyNextRunAction = "advance"
	// PolicyNextRunDeferBusy retries shortly, regardless of schedule.
	PolicyNextRunDeferBusy PolicyNextRunAction = "defer_busy"
)

// PolicyRunMetadataPatch is the only part of a policy a run may write.
type PolicyRunMetadataPatch struct {
	NowMS   float64
	NextRun PolicyNextRunAction
	// LastRun is nil on every path except a successful cleanup, and a nil
	// here PRESERVES whatever the reloaded policy already had.
	LastRun *PolicyLastRun
}

// PolicyRunDeps injects everything the run touches outside itself.
type PolicyRunDeps struct {
	// NowMS is a pointer because zero is a legitimate timestamp in the
	// oracle and only an absent value selects the clock.
	NowMS         *float64
	CodexHome     string
	Force         bool
	LoadPolicy    func() StorageCleanupPolicy
	SavePolicy    func(StorageCleanupPolicy)
	Execute       func(ExecuteCleanupOptions) CleanupResult
	BusyTimeoutMS *int
	// HoldAfterLoadMS is a test seam: it blocks after the start-of-run load so
	// a concurrent edit can land before the run commits its metadata.
	HoldAfterLoadMS float64
}

// PolicyRunResult is what one evaluation decided.
type PolicyRunResult struct {
	OK      bool
	Skipped string
	// Deferred is "codex_busy" when a live database pushed the run back.
	Deferred   string
	Error      string
	Mode       string
	FreedBytes int64
	Removed    int
	TrashDir   string
	Policy     StorageCleanupPolicy
}

// advanceNextRun recomputes from the LATEST schedule.
//
// Using the schedule the run started with would ignore an edit the user made
// while a long cleanup was in flight.
func advanceNextRun(policy StorageCleanupPolicy, nowMS float64) StorageCleanupPolicy {
	next := policy
	next.NextRun = ComputeNextRun(policy.Schedule, nowMS)
	return next
}

// deferBusy retries soon WITHOUT consulting the schedule.
//
// That is what lets a startup policy deferred by a busy database be picked up
// by a later scheduler tick: the stored nextRun is the only thing that makes
// the startup branch due again.
func deferBusy(policy StorageCleanupPolicy, nowMS float64) StorageCleanupPolicy {
	next := policy
	deferred := nowMS + BusyDeferMS
	next.NextRun = &deferred
	return next
}

// CommitPolicyRunMetadata writes only the two fields a run owns.
//
// It RELOADS the policy rather than using the one the run started with,
// because a long cleanup gives the user time to change enabled, trigger,
// target, schedule or mode, and saving the stale snapshot would silently undo
// that edit.
func CommitPolicyRunMetadata(
	load func() StorageCleanupPolicy,
	save func(StorageCleanupPolicy),
	patch PolicyRunMetadataPatch,
) StorageCleanupPolicy {
	latest := NormalizeStorageCleanupPolicy(policyAsMap(load()))
	var next StorageCleanupPolicy
	if patch.NextRun == PolicyNextRunDeferBusy {
		next = deferBusy(latest, patch.NowMS)
	} else {
		next = advanceNextRun(latest, patch.NowMS)
	}
	if patch.LastRun != nil {
		next.LastRun = patch.LastRun
	}
	save(next)
	return next
}

// runPolicyWithDeps evaluates the policy and runs it when it is due.
//
// A non-nil error means the result is a zero value and must be ignored. The
// oracle throws in the same places, and nothing there both returns and throws.
func runPolicyWithDeps(reason PolicyRunReason, deps PolicyRunDeps) (PolicyRunResult, error) {
	nowMS := float64(time.Now().UnixMilli())
	if deps.NowMS != nil {
		nowMS = *deps.NowMS
	}
	load := deps.LoadPolicy
	save := deps.SavePolicy
	policy := NormalizeStorageCleanupPolicy(policyAsMap(load()))

	if deps.HoldAfterLoadMS > 0 {
		time.Sleep(time.Duration(deps.HoldAfterLoadMS) * time.Millisecond)
	}

	// Nothing happened, so nothing is written: touching nextRun here would
	// move a schedule the user never triggered.
	if !policy.Enabled {
		return PolicyRunResult{OK: true, Skipped: "disabled", Policy: policy}, nil
	}
	if !deps.Force && !IsPolicyDue(policy, nowMS, reason) {
		return PolicyRunResult{OK: true, Skipped: "not_due", Policy: policy}, nil
	}

	selection, err := SelectPolicyPreview(policy, deps.CodexHome)
	if err != nil {
		return PolicyRunResult{}, err
	}

	// From here on every exit advances the schedule, including failures:
	// leaving it alone would retry on every tick.
	if selection.ArchivedBytes <= int64(policy.Trigger.ArchivedBytesOver) {
		saved := CommitPolicyRunMetadata(load, save,
			PolicyRunMetadataPatch{NowMS: nowMS, NextRun: PolicyNextRunAdvance})
		return PolicyRunResult{OK: true, Skipped: "under_threshold", Policy: saved}, nil
	}
	if selection.Count == 0 {
		saved := CommitPolicyRunMetadata(load, save,
			PolicyRunMetadataPatch{NowMS: nowMS, NextRun: PolicyNextRunAdvance})
		return PolicyRunResult{OK: true, Skipped: "nothing_selected", Policy: saved}, nil
	}

	options := ExecuteCleanupOptions{
		Percent:           selection.Percent,
		Mode:              policy.Mode,
		Digest:            selection.Digest,
		CandidateRelPaths: selection.CandidateRelPaths,
		CodexHome:         deps.CodexHome,
		BusyTimeoutMS:     deps.BusyTimeoutMS,
		NowMS:             &nowMS,
	}
	result := deps.Execute(options)

	if !result.OK && result.Error == CleanupErrorCodexBusy {
		saved := CommitPolicyRunMetadata(load, save,
			PolicyRunMetadataPatch{NowMS: nowMS, NextRun: PolicyNextRunDeferBusy})
		return PolicyRunResult{
			Deferred: CleanupErrorCodexBusy,
			Error:    CleanupErrorCodexBusy,
			Policy:   saved,
		}, nil
	}
	if !result.OK {
		saved := CommitPolicyRunMetadata(load, save,
			PolicyRunMetadataPatch{NowMS: nowMS, NextRun: PolicyNextRunAdvance})
		return PolicyRunResult{
			Error:    result.Error,
			Mode:     result.Mode,
			TrashDir: result.TrashDir,
			Policy:   saved,
		}, nil
	}

	saved := CommitPolicyRunMetadata(load, save, PolicyRunMetadataPatch{
		NowMS:   nowMS,
		NextRun: PolicyNextRunAdvance,
		LastRun: &PolicyLastRun{
			At:         nowMS,
			FreedBytes: float64(result.Bytes),
			Removed:    float64(result.Count),
		},
	})
	return PolicyRunResult{
		OK:         true,
		Mode:       result.Mode,
		FreedBytes: result.Bytes,
		Removed:    result.Count,
		TrashDir:   result.TrashDir,
		Policy:     saved,
	}, nil
}

// maybeRunPolicyWithDeps is the startup and tick entry point.
//
// It swallows everything, because a scheduler tick must not die of a policy
// bug. The oracle's catch covers a thrown selector failure, which this port
// surfaces as an error, so BOTH channels have to be absorbed here.
func maybeRunPolicyWithDeps(reason PolicyRunReason, deps PolicyRunDeps) (result *PolicyRunResult) {
	defer func() {
		if recover() != nil {
			result = nil
		}
	}()
	run, err := runPolicyWithDeps(reason, deps)
	if err != nil {
		return nil
	}
	return &run
}
