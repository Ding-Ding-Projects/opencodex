package storage

import (
	"math"
)

// The opt-in cleanup policy, ported from src/storage/policy.ts.
//
// This policy can delete a user's sessions on a timer, so every ambiguity in
// it resolves toward doing nothing. Normalization never turns the policy on,
// and a persisted target it cannot understand turns it off rather than falling
// back to a default that deletes.

const defaultArchivedBytesOver = 5 * 1024 * 1024 * 1024
const defaultRemoveOldestPercent = 25

// PolicySchedule is when the policy runs.
type PolicySchedule string

// PolicyTrigger is the condition that makes a run worth doing.
type PolicyTrigger struct {
	ArchivedBytesOver float64 `json:"archivedBytesOver"`
}

// PolicyTarget says how much to remove. Exactly one field is ever set.
type PolicyTarget struct {
	ReduceToBytes       *float64 `json:"reduceToBytes,omitempty"`
	RemoveOldestPercent *float64 `json:"removeOldestPercent,omitempty"`
}

// PolicyLastRun records what the previous run accomplished.
type PolicyLastRun struct {
	At         float64 `json:"at"`
	FreedBytes float64 `json:"freedBytes"`
	Removed    float64 `json:"removed"`
}

// StorageCleanupPolicy is the persisted and wire shape.
//
// The json tags are required rather than cosmetic: Go would otherwise write
// `Enabled`, and the TypeScript runtime reading that file would find no
// `enabled` key and normalize the policy to disabled.
type StorageCleanupPolicy struct {
	Enabled  bool           `json:"enabled"`
	Trigger  PolicyTrigger  `json:"trigger"`
	Target   PolicyTarget   `json:"target"`
	Schedule PolicySchedule `json:"schedule"`
	Mode     string         `json:"mode"`
	// Absent rather than null when unset, matching the oracle's optional
	// properties.
	LastRun *PolicyLastRun `json:"lastRun,omitempty"`
	NextRun *float64       `json:"nextRun,omitempty"`
}

// DefaultStorageCleanupPolicy is the canonical off state.
func DefaultStorageCleanupPolicy() StorageCleanupPolicy {
	percent := float64(defaultRemoveOldestPercent)
	return StorageCleanupPolicy{
		Enabled:  false,
		Trigger:  PolicyTrigger{ArchivedBytesOver: defaultArchivedBytesOver},
		Target:   PolicyTarget{RemoveOldestPercent: &percent},
		Schedule: "manual",
		Mode:     "quarantine",
	}
}

// isFiniteNonNegInt and isFinitePositiveInt mirror the oracle's numeric tests.
//
// They take float64 because the oracle's `number` does: a fractional value has
// to be expressible in order to be rejected, and an int64 parameter could not
// carry 1.5 to the check at all.
func isFiniteNonNegInt(value float64, ok bool) bool {
	return ok && !math.IsNaN(value) && !math.IsInf(value, 0) &&
		value >= 0 && math.Floor(value) == value
}

func isFinitePositiveInt(value float64, ok bool) bool {
	return ok && !math.IsNaN(value) && !math.IsInf(value, 0) &&
		value > 0 && math.Floor(value) == value
}

// IsValidPolicyTarget requires EXACTLY one of the two fields.
//
// Neither means the policy says nothing about how much to delete; both means
// it says two contradictory things. Either way there is no safe reading, which
// is why the caller disables rather than picking one.
func IsValidPolicyTarget(raw any) bool {
	object, ok := raw.(map[string]any)
	if !ok {
		return false
	}
	reduce, hasReduce := object["reduceToBytes"]
	percent, hasPercent := object["removeOldestPercent"]
	if hasReduce == hasPercent {
		return false
	}
	if hasReduce {
		return isFiniteNonNegInt(jsonNumberValue(reduce))
	}
	// Deliberately NOT an integer test: a fractional percent is valid input
	// and gets floored on adoption.
	value, isNumber := jsonNumberValue(percent)
	return isNumber && !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0 && value <= 100
}

// NormalizeStorageCleanupPolicy turns anything into a complete policy.
//
// It never flips `enabled` on. It can flip it OFF, and that is the whole point
// of the target branch below.
func NormalizeStorageCleanupPolicy(raw any) StorageCleanupPolicy {
	base := DefaultStorageCleanupPolicy()
	object, ok := raw.(map[string]any)
	if !ok {
		return base
	}

	// Only a literal true. A truthy string or 1 is a malformed config, not
	// consent to delete sessions on a timer.
	enabled, _ := object["enabled"].(bool)

	trigger := base.Trigger
	if triggerObject, ok := object["trigger"].(map[string]any); ok {
		if value, numeric := jsonNumberValue(triggerObject["archivedBytesOver"]); isFiniteNonNegInt(value, numeric) {
			trigger.ArchivedBytesOver = value
		}
		// An unusable trigger falls back to the default WITHOUT disabling the
		// policy: a wrong threshold cannot widen a deletion, so there is
		// nothing to fail closed about.
	}

	target := base.Target
	if rawTarget, present := object["target"]; present {
		if IsValidPolicyTarget(rawTarget) {
			target = adoptTarget(rawTarget.(map[string]any))
		} else {
			// Fail closed. A persisted target this code cannot read must not
			// quietly become "delete the oldest 25%" — the user never asked
			// for that.
			enabled = false
		}
	}

	schedule := base.Schedule
	switch value := object["schedule"]; value {
	case "startup", "daily", "weekly", "manual":
		schedule = PolicySchedule(value.(string))
	}

	// Permanent deletion is opt-in by exact spelling; everything else
	// quarantines.
	mode := "quarantine"
	if object["mode"] == "permanent" {
		mode = "permanent"
	}

	policy := StorageCleanupPolicy{
		Enabled:  enabled,
		Trigger:  trigger,
		Target:   target,
		Schedule: schedule,
		Mode:     mode,
		LastRun:  adoptLastRun(object["lastRun"]),
	}
	if value, numeric := jsonNumberValue(object["nextRun"]); isFinitePositiveInt(value, numeric) {
		policy.NextRun = &value
	}
	return policy
}

// adoptTarget applies the clamp the oracle applies on adoption.
//
// Validation allows a fractional percent; adoption floors it and pulls it into
// 1..100, so 0.5 becomes 1 rather than a no-op and 99.9 becomes 99.
func adoptTarget(object map[string]any) PolicyTarget {
	if _, hasReduce := object["reduceToBytes"]; hasReduce {
		value, _ := jsonNumberValue(object["reduceToBytes"])
		return PolicyTarget{ReduceToBytes: &value}
	}
	value, _ := jsonNumberValue(object["removeOldestPercent"])
	clamped := math.Min(100, math.Max(1, math.Floor(value)))
	return PolicyTarget{RemoveOldestPercent: &clamped}
}

// adoptLastRun takes the record only when all three fields check out.
//
// A partially valid record would misreport what the last run did, and the
// scheduler reads it to decide what to do next.
func adoptLastRun(raw any) *PolicyLastRun {
	object, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	at, atOK := jsonNumberValue(object["at"])
	freed, freedOK := jsonNumberValue(object["freedBytes"])
	removed, removedOK := jsonNumberValue(object["removed"])
	if !isFinitePositiveInt(at, atOK) ||
		!isFiniteNonNegInt(freed, freedOK) ||
		!isFiniteNonNegInt(removed, removedOK) {
		return nil
	}
	return &PolicyLastRun{At: at, FreedBytes: freed, Removed: removed}
}
