package storage

// The post-move sequence, ported from src/storage/cleanup.ts.
//
// This is the continuation the move phase was written to accept, and wiring it
// removes the temporary seam that reported a restore as incomplete because
// there was nothing to hand off to.

// RestoreRemainingWork builds the continuation that finishes a restore.
//
// The order is the oracle's and each step depends on the one before it:
// reconcile the thread rows, record that they are done, commit the satellite
// stores one at a time, then verify and tombstone. A failure at any point
// leaves the files where they are and the marker describing what is left.
func RestoreRemainingWork(
	plan RestorePlan,
	pre RestorePreflight,
	busyTimeoutMS int,
	hooks *RestoreMoveHooks,
) func(RestoreMovedState) RestoreResult {
	return func(state RestoreMovedState) RestoreResult {
		if state.Pending.State {
			if code := ReconcileThreadsFromManifest(state, plan, pre.Paths, busyTimeoutMS); code != RestoreOK {
				return state.AbortAfterMoves(code)
			}
			// Cleared by the caller rather than inside the reconcile, and only
			// after it succeeded, so a crash before this point retries the
			// whole reconcile instead of skipping it.
			state.Pending.State = false
			if err := state.PersistPending(); err != nil {
				return state.AbortAfterMoves(RestoreFSFailed)
			}
		}
		if hooks != nil && hooks.FailAfterStateCommit {
			return state.AbortAfterMoves(RestoreDBReconcileFailed)
		}

		if code := CommitSatelliteSections(state, hooks); code != RestoreOK {
			return state.AbortAfterMoves(code)
		}
		return FinalizeRestore(state, plan, hooks)
	}
}
