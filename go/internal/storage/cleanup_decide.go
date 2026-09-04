package storage

import (
	"regexp"
	"strings"
)

// Cleanup rejection codes. These reach the user and the policy scheduler, so
// they are a contract rather than log text: stale_preview means "re-preview and
// try again", while restore_pending_overlap means "a restore is using these
// files, wait for it" -- different causes needing different user actions.
const (
	CleanupErrorInvalidMode           = "invalid_mode"
	CleanupErrorInvalidDigest         = "invalid_digest"
	CleanupErrorStalePreview          = "stale_preview"
	CleanupErrorRestorePendingOverlap = "restore_pending_overlap"
)

var digestPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

// CleanupDecision is what a cleanup WOULD do. Producing it touches no files, so
// every rejection can be decided and tested before anything is moved.
type CleanupDecision struct {
	Candidates []ArchivedCandidate
	Mode       string
	Percent    int
	// Error is empty when the cleanup may proceed.
	Error string
}

// DecideArchivedCleanup runs the oracle's admission sequence
// (src/storage/cleanup.ts:1733). The ORDER is the contract: the digest check
// must happen before anything is staged, because the digest is what binds this
// request to the list the user actually approved.
func DecideArchivedCleanup(options ExecuteCleanupOptions) CleanupDecision {
	mode := options.Mode
	percent := ClampPercent(float64(options.Percent))
	reject := func(code string) CleanupDecision {
		return CleanupDecision{Mode: mode, Percent: percent, Error: code}
	}

	if mode != "quarantine" && mode != "permanent" {
		return reject(CleanupErrorInvalidMode)
	}
	if !digestPattern.MatchString(options.Digest) {
		return reject(CleanupErrorInvalidDigest)
	}

	codexHome := options.CodexHome
	exact := options.CandidateRelPaths != nil

	var unfiltered []ArchivedCandidate
	var preview CleanupPreview
	var err error
	if exact {
		selected, ok := ResolveExactArchivedCandidates(options.CandidateRelPaths, codexHome)
		if !ok {
			return reject(CleanupErrorStalePreview)
		}
		unfiltered = selected
		preview, err = PreviewExactArchivedCleanup(selected, codexHome)
	} else {
		unfiltered = SelectOldestPercent(ListArchivedCandidates(codexHome), float64(percent))
		preview, err = PreviewArchivedCleanup(codexHome, float64(percent))
	}
	if err != nil {
		return reject(CleanupErrorStalePreview)
	}

	if !strings.EqualFold(preview.Digest, options.Digest) {
		// The requested digest may still describe the pre-filter set. That means
		// the list did not go stale -- a pending restore removed entries from it,
		// which is a different problem with a different remedy.
		pending, pendingErr := CollectRestorePendingAcceptedDestRels(codexHome)
		if pendingErr == nil && len(pending) > 0 {
			var blocked bool
			for _, candidate := range unfiltered {
				if CandidateOverlapsPendingRestore(candidate, pending) {
					blocked = true
					break
				}
			}
			var unfilteredDigest string
			if exact {
				unfilteredDigest = ComputeExactPreviewDigest(unfiltered)
			} else {
				unfilteredDigest = ComputePreviewDigest(unfiltered, float64(percent))
			}
			if blocked && strings.EqualFold(unfilteredDigest, options.Digest) {
				return reject(CleanupErrorRestorePendingOverlap)
			}
		}
		return reject(CleanupErrorStalePreview)
	}

	pending, pendingErr := CollectRestorePendingAcceptedDestRels(codexHome)
	if pendingErr == nil {
		for _, candidate := range preview.Candidates {
			if CandidateOverlapsPendingRestore(candidate, pending) {
				return reject(CleanupErrorRestorePendingOverlap)
			}
		}
	}

	return CleanupDecision{Candidates: preview.Candidates, Mode: mode, Percent: percent}
}
