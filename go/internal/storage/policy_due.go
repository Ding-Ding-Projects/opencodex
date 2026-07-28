package storage

import (
	"math"
)

// Deciding whether a cleanup policy should run, ported from
// src/storage/policy.ts.

// PolicyRunReason is why a run is being considered.
type PolicyRunReason string

const (
	// PolicyRunManual is a user pressing the button.
	PolicyRunManual PolicyRunReason = "manual"
	// PolicyRunStartup is the launch-time evaluation.
	PolicyRunStartup PolicyRunReason = "startup"
	// PolicyRunSchedule is a scheduler tick.
	PolicyRunSchedule PolicyRunReason = "schedule"
)

// IsPolicyDue answers whether this reason may run this policy now.
//
// The ladder order is the contract. `enabled` comes first, so a disabled
// policy cannot even be run by hand; then a manual reason beats every
// schedule, because pressing the button is a decision the schedule does not
// get to overrule.
func IsPolicyDue(policy StorageCleanupPolicy, nowMS float64, reason PolicyRunReason) bool {
	if !policy.Enabled {
		return false
	}
	if reason == PolicyRunManual {
		return true
	}
	if policy.Schedule == "manual" {
		return false
	}
	if policy.Schedule == "startup" {
		if reason == PolicyRunStartup {
			return true
		}
		// A startup run deferred by a busy database leaves a nextRun behind,
		// and a later scheduler tick picks it up. The reason test is kept
		// because the oracle has it, though manual and startup have both
		// already returned above so nothing else can reach here.
		return reason == PolicyRunSchedule &&
			policy.NextRun != nil && nowMS >= *policy.NextRun
	}
	// daily and weekly share this branch and do not look at the reason.
	if policy.NextRun == nil {
		return true
	}
	return nowMS >= *policy.NextRun
}

// SelectReduceToBytes picks oldest-first until the archive would drop to the
// target.
//
// This is NOT the pending-restore-aware variant. It takes no home, so it
// cannot consult in-flight restores, and the oracle keeps the two apart on
// purpose: this one is the arithmetic, the other one is the policy.
func SelectReduceToBytes(candidates []ArchivedCandidate, reduceToBytes float64) []ArchivedCandidate {
	if math.IsNaN(reduceToBytes) || math.IsInf(reduceToBytes, 0) || reduceToBytes < 0 {
		return []ArchivedCandidate{}
	}
	total := float64(0)
	for _, candidate := range candidates {
		total += float64(candidate.Bytes)
	}
	if total <= reduceToBytes {
		return []ArchivedCandidate{}
	}

	need := total - reduceToBytes
	selected := []ArchivedCandidate{}
	freed := float64(0)
	for _, candidate := range candidates {
		// Overshooting is allowed: files are removed whole, so the last one
		// taken will usually free more than was strictly needed.
		selected = append(selected, candidate)
		freed += float64(candidate.Bytes)
		if freed >= need {
			break
		}
	}
	return selected
}

// PercentForAtLeastCount is the smallest percentage that selects at least
// `selectedCount` of `totalCount`.
//
// The search exists because percent selection floors with a minimum of one, so
// the mapping is not a simple ratio: with ten candidates, wanting one answers
// 1 even though one percent of ten floors to zero.
func PercentForAtLeastCount(totalCount, selectedCount int) int {
	if selectedCount <= 0 || totalCount <= 0 {
		return 0
	}
	if selectedCount >= totalCount {
		return 100
	}
	for percent := 1; percent <= 100; percent++ {
		got := int(math.Max(1, math.Floor(float64(totalCount*percent)/100)))
		if got >= selectedCount {
			return percent
		}
	}
	return 100
}

// PolicySelection is what a policy would remove right now.
type PolicySelection struct {
	// ArchivedBytes is the total across EVERY candidate, not the selection.
	ArchivedBytes int64
	Percent       int
	Count         int
	Bytes         int64
	Digest        string
	// CandidateRelPaths is set only on the exact-target branch, and stays nil
	// on the percentage branch so a caller can tell the two apart.
	CandidateRelPaths []string
}

// SelectPolicyPreview computes what this policy would do without doing it.
//
// A byte target resolves to an EXACT candidate list rather than being
// approximated as a percentage: percentage selection rounds up, so the
// approximation would delete more than the target asked for.
func SelectPolicyPreview(policy StorageCleanupPolicy, codexHome string) (PolicySelection, error) {
	all := ListArchivedCandidates(codexHome)
	archivedBytes := int64(0)
	for _, candidate := range all {
		archivedBytes += candidate.Bytes
	}

	if policy.Target.ReduceToBytes != nil {
		desired, err := SelectReduceToBytesSkippingPendingRestore(all, *policy.Target.ReduceToBytes, codexHome)
		if err != nil {
			return PolicySelection{}, err
		}
		preview, err := PreviewExactArchivedCleanup(desired, codexHome)
		if err != nil {
			return PolicySelection{}, err
		}
		paths := make([]string, 0, len(preview.Candidates))
		for _, candidate := range preview.Candidates {
			paths = append(paths, candidate.RelPath)
		}
		return PolicySelection{
			ArchivedBytes:     archivedBytes,
			Percent:           0,
			Count:             preview.Count,
			Bytes:             preview.Bytes,
			Digest:            preview.Digest,
			CandidateRelPaths: paths,
		}, nil
	}

	percentValue := float64(0)
	if policy.Target.RemoveOldestPercent != nil {
		percentValue = *policy.Target.RemoveOldestPercent
	}
	percent := int(math.Min(100, math.Max(0, math.Floor(percentValue))))
	selected, err := SelectOldestPercentSkippingPendingRestore(all, float64(percent), codexHome)
	if err != nil {
		return PolicySelection{}, err
	}
	bytes := int64(0)
	for _, candidate := range selected {
		bytes += candidate.Bytes
	}
	return PolicySelection{
		ArchivedBytes: archivedBytes,
		Percent:       percent,
		Count:         len(selected),
		Bytes:         bytes,
		Digest:        ComputePreviewDigest(selected, float64(percent)),
	}, nil
}
