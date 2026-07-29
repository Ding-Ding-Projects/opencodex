package storage

// RestoreTrashEntry is the entry point a route calls to put a quarantined
// session back.
//
// Every stage below already existed and was individually tested; what was
// missing is the thing that runs them in order. The order matters and is the
// oracle's: resolve the trash id, read what the quarantine recorded, then move
// files and reconcile metadata inside the lock scope the move phase owns.
//
// Nothing here decides policy. A failure at any stage returns the code that
// stage produced, because the caller maps those codes to distinct HTTP
// statuses and a collapsed error would tell the user the wrong thing to do.
func RestoreTrashEntry(trashID, codexHome string, busyTimeoutMS int, hooks *RestoreMoveHooks) RestoreResult {
	plan, code := PlanTrashRestore(trashID, codexHome)
	if code != RestoreOK {
		return RestoreResult{TrashDir: plan.TrashDirID, Error: code}
	}
	pre, code := PrepareRestorePreflight(plan, codexHome)
	if code != RestoreOK {
		return RestoreResult{TrashDir: plan.TrashDirID, Error: code}
	}
	return ExecuteRestoreMoves(
		plan,
		pre,
		codexHome,
		busyTimeoutMS,
		hooks,
		RestoreRemainingWork(plan, pre, busyTimeoutMS, hooks),
	)
}
