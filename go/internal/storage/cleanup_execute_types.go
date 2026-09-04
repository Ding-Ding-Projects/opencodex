package storage

// The cleanup execution contract, ported from src/storage/cleanup.ts.
//
// These live with the cleanup owner rather than with the policy that calls
// them: the execution port lands later and would otherwise have to reshape a
// contract declared in someone else's file. The full oracle shape is here even
// though the policy currently reads only part of it.

// ExecuteCleanupOptions is what a caller asks a cleanup to do.
type ExecuteCleanupOptions struct {
	Percent int
	Mode    string
	// Digest binds the request to a preview. A drifted candidate set is
	// rejected rather than silently deleting something else.
	Digest string
	// CandidateRelPaths is the exact set for a byte target. Nil means the
	// percentage path, where selection is derived rather than supplied.
	CandidateRelPaths []string
	// CodexHome is empty when the caller did not override it.
	CodexHome string
	// BusyTimeoutMS shrinks the SQLite busy timeout so lock tests fail fast.
	BusyTimeoutMS *int
	NowMS         *float64
}

// CleanupResult is what a cleanup did.
type CleanupResult struct {
	OK      bool
	Mode    string
	Percent int
	Count   int
	Bytes   int64
	// TrashDir is set for a quarantine, empty for a permanent removal.
	TrashDir     string
	Error        string
	RemovedPaths []string
}
