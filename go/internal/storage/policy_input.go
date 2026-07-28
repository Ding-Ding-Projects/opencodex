package storage

import (
	"encoding/json"
	"math"
	"strconv"
)

// The policy PUT boundary, ported from src/storage/policy.ts.
//
// Normalization and this parser disagree on purpose. Normalization reads
// whatever is already on disk and quietly disables a policy it cannot
// understand; this reads what the user just typed and tells them it was wrong.

const dayMS = 24 * 60 * 60 * 1000

// ComputeNextRun is the plain offset the oracle uses, with no alignment to any
// clock boundary.
func ComputeNextRun(schedule PolicySchedule, nowMS float64) *float64 {
	switch schedule {
	case "daily":
		next := nowMS + dayMS
		return &next
	case "weekly":
		next := nowMS + 7*dayMS
		return &next
	}
	return nil
}

// ParseStorageCleanupPolicyInput merges a PUT body over the existing policy.
//
// The clock is a parameter because the schedule recompute needs one, and a
// hidden time.Now would make the result untestable at the boundary that
// decides when a user's sessions get deleted.
//
// Returns the merged policy and an empty string, or the zero policy and the
// oracle's exact error text.
func ParseStorageCleanupPolicyInput(
	raw any,
	previous *StorageCleanupPolicy,
	nowMS float64,
) (StorageCleanupPolicy, string) {
	object, ok := raw.(map[string]any)
	if !ok {
		return StorageCleanupPolicy{}, "body must be a JSON object"
	}
	prev := DefaultStorageCleanupPolicy()
	if previous != nil {
		prev = *previous
	}

	if value, present := object["enabled"]; present {
		if _, isBool := value.(bool); !isBool {
			return StorageCleanupPolicy{}, "enabled must be a boolean"
		}
	}
	if value, present := object["mode"]; present {
		if value != "quarantine" && value != "permanent" {
			return StorageCleanupPolicy{}, "mode must be quarantine or permanent"
		}
	}
	if value, present := object["schedule"]; present {
		switch value {
		case "startup", "daily", "weekly", "manual":
		default:
			return StorageCleanupPolicy{}, "schedule must be startup, daily, weekly, or manual"
		}
	}

	// These two decide how much gets deleted, so a null is a malformed request
	// rather than a request to clear them. Only the run metadata below clears
	// on null.
	rawTrigger, triggerSent := object["trigger"]
	if triggerSent {
		triggerObject, isObject := rawTrigger.(map[string]any)
		if !isObject {
			return StorageCleanupPolicy{}, "trigger must be an object"
		}
		if value, numeric := jsonNumberValue(triggerObject["archivedBytesOver"]); !isFiniteNonNegInt(value, numeric) {
			return StorageCleanupPolicy{}, "trigger.archivedBytesOver must be a non-negative integer"
		}
	}
	rawTarget, targetSent := object["target"]
	if targetSent && !IsValidPolicyTarget(rawTarget) {
		return StorageCleanupPolicy{},
			"target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)"
	}

	merged := mergePolicyBody(object, prev, triggerSent, rawTrigger, targetSent, rawTarget)
	policy := NormalizeStorageCleanupPolicy(merged)

	_, nextRunSent := object["nextRun"]
	rawSchedule, scheduleSent := object["schedule"]

	// Recompute only when the schedule is timed, the client did not supply a
	// next run, and either none survived or the schedule actually changed.
	// Recomputing on every PUT would push the next run further out each time
	// the user saved an unrelated setting.
	if policy.Schedule == "daily" || policy.Schedule == "weekly" {
		scheduleChanged := scheduleSent && PolicySchedule(rawSchedule.(string)) != prev.Schedule
		if !nextRunSent && (policy.NextRun == nil || scheduleChanged) {
			policy.NextRun = ComputeNextRun(policy.Schedule, nowMS)
		}
	}
	if policy.Schedule == "manual" || policy.Schedule == "startup" {
		if !nextRunSent {
			policy.NextRun = nil
		}
	}
	return policy, ""
}

// mergePolicyBody lays the body over the previous policy.
//
// Presence, not value, decides: a field the client omitted keeps its old
// value, and a field sent as null overwrites with null, which normalization
// then drops. Collapsing Go's nil into "absent" would silently keep a stale
// next run the user asked to clear.
func mergePolicyBody(
	object map[string]any,
	prev StorageCleanupPolicy,
	triggerSent bool, rawTrigger any,
	targetSent bool, rawTarget any,
) map[string]any {
	merged := map[string]any{
		"enabled":  prev.Enabled,
		"schedule": string(prev.Schedule),
		"mode":     prev.Mode,
	}
	for key, value := range object {
		merged[key] = value
	}

	if triggerSent {
		merged["trigger"] = rawTrigger
	} else {
		merged["trigger"] = map[string]any{
			"archivedBytesOver": jsonNumberOf(prev.Trigger.ArchivedBytesOver),
		}
	}
	if targetSent {
		merged["target"] = rawTarget
	} else {
		merged["target"] = targetAsMap(prev.Target)
	}

	if _, sent := object["lastRun"]; !sent {
		if prev.LastRun == nil {
			delete(merged, "lastRun")
		} else {
			merged["lastRun"] = map[string]any{
				"at":         jsonNumberOf(prev.LastRun.At),
				"freedBytes": jsonNumberOf(prev.LastRun.FreedBytes),
				"removed":    jsonNumberOf(prev.LastRun.Removed),
			}
		}
	}
	if _, sent := object["nextRun"]; !sent {
		if prev.NextRun == nil {
			delete(merged, "nextRun")
		} else {
			merged["nextRun"] = jsonNumberOf(*prev.NextRun)
		}
	}
	return merged
}

func targetAsMap(target PolicyTarget) map[string]any {
	if target.ReduceToBytes != nil {
		return map[string]any{"reduceToBytes": jsonNumberOf(*target.ReduceToBytes)}
	}
	if target.RemoveOldestPercent != nil {
		return map[string]any{"removeOldestPercent": jsonNumberOf(*target.RemoveOldestPercent)}
	}
	// Neither set is not a shape the oracle produces, but normalization has to
	// see something, and an empty object correctly fails validation.
	return map[string]any{}
}

// jsonNumberOf re-encodes a numeric field so the merged map looks exactly like
// a freshly parsed body.
//
// Normalization reads numbers through jsonNumberValue, which expects the
// json.Number a decoder produces. Handing it a bare float64 would make every
// carried-over field fail its type check and silently reset to a default.
func jsonNumberOf(value float64) json.Number {
	if math.Floor(value) == value && !math.IsInf(value, 0) && !math.IsNaN(value) {
		return json.Number(strconv.FormatInt(int64(value), 10))
	}
	return json.Number(strconv.FormatFloat(value, 'g', -1, 64))
}
