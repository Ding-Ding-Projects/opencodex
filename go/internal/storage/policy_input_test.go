package storage

import (
	"testing"
)

const fixedNow = float64(1700000000000)

func parseInput(t *testing.T, raw string, previous *StorageCleanupPolicy) (StorageCleanupPolicy, string) {
	t.Helper()
	decoded, ok := decodeSingleJSONDocument([]byte(raw))
	if !ok {
		t.Fatalf("%s did not decode", raw)
	}
	return ParseStorageCleanupPolicyInput(decoded, previous, fixedNow)
}

// Criteria 25-28, 37 and 38: the PUT boundary REJECTS what normalization would
// have quietly absorbed, because the user just sent it.
func TestPutRejectionMessages(t *testing.T) {
	for name, test := range map[string]struct {
		body string
		want string
	}{
		"array body":   {`[]`, "body must be a JSON object"},
		"string body":  {`"policy"`, "body must be a JSON object"},
		"null body":    {`null`, "body must be a JSON object"},
		"enabled text": {`{"enabled":"true"}`, "enabled must be a boolean"},
		"bad mode":     {`{"mode":"x"}`, "mode must be quarantine or permanent"},
		"bad schedule": {`{"schedule":"hourly"}`,
			"schedule must be startup, daily, weekly, or manual"},
		"trigger array": {`{"trigger":[]}`, "trigger must be an object"},
		// A null trigger is a malformed request, NOT a request to clear it.
		"trigger null": {`{"trigger":null}`, "trigger must be an object"},
		"bad bytes": {`{"trigger":{"archivedBytesOver":-1}}`,
			"trigger.archivedBytesOver must be a non-negative integer"},
		"bad target": {`{"target":{}}`,
			"target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)"},
		// Same for the target: it decides how much gets deleted.
		"target null": {`{"target":null}`,
			"target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseInput(t, test.body, nil)
			if err != test.want {
				t.Fatalf("error = %q, want %q", err, test.want)
			}
		})
	}
}

// Criterion 28 contrasted with normalization: the same malformed target that
// silently disables a persisted policy is an ERROR on the wire.
func TestABadTargetIsSilentOnDiskButLoudOnTheWire(t *testing.T) {
	if policy := normalizeJSON(t, `{"enabled":true,"target":{}}`); policy.Enabled {
		t.Fatal("normalization should have disabled it silently")
	}
	if _, err := parseInput(t, `{"target":{}}`, nil); err == "" {
		t.Fatal("the wire boundary must report it instead")
	}
}

// Criterion 29: run metadata survives a PUT that does not mention it.
func TestOmittedRunMetadataIsPreserved(t *testing.T) {
	next := float64(999)
	prev := DefaultStorageCleanupPolicy()
	prev.Schedule = "daily"
	prev.NextRun = &next
	prev.LastRun = &PolicyLastRun{At: 5, FreedBytes: 6, Removed: 7}

	policy, err := parseInput(t, `{"enabled":true}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.LastRun == nil || policy.LastRun.At != 5 {
		t.Fatalf("lastRun = %+v, want it carried over", policy.LastRun)
	}
	if policy.NextRun == nil || *policy.NextRun != 999 {
		t.Fatalf("nextRun = %v, want it carried over untouched", policy.NextRun)
	}
}

// Criterion 30: an unchanged schedule must not push the next run further out
// every time the user saves an unrelated setting.
func TestAnUnchangedScheduleDoesNotRecomputeNextRun(t *testing.T) {
	next := float64(999)
	prev := DefaultStorageCleanupPolicy()
	prev.Schedule = "daily"
	prev.NextRun = &next

	policy, err := parseInput(t, `{"schedule":"daily","enabled":true}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.NextRun == nil || *policy.NextRun != 999 {
		t.Fatalf("nextRun = %v, want the stored value untouched", policy.NextRun)
	}
}

// Criteria 31, 31b and 32: recompute when the schedule newly becomes timed, or
// when it changes between timed values even though a next run already exists.
func TestNextRunRecomputation(t *testing.T) {
	t.Run("manual becomes daily", func(t *testing.T) {
		prev := DefaultStorageCleanupPolicy()
		policy, err := parseInput(t, `{"schedule":"daily"}`, &prev)
		if err != "" {
			t.Fatalf("error = %q", err)
		}
		if policy.NextRun == nil || *policy.NextRun != fixedNow+dayMS {
			t.Fatalf("nextRun = %v, want now + 1 day", policy.NextRun)
		}
	})

	// The discriminating case: a next run ALREADY exists, so only the
	// schedule-changed disjunct can trigger the recompute. An implementation
	// using AND, or comparing against the merged schedule, fails here.
	t.Run("daily becomes weekly with a stored next run", func(t *testing.T) {
		next := float64(999)
		prev := DefaultStorageCleanupPolicy()
		prev.Schedule = "daily"
		prev.NextRun = &next

		policy, err := parseInput(t, `{"schedule":"weekly"}`, &prev)
		if err != "" {
			t.Fatalf("error = %q", err)
		}
		if policy.NextRun == nil || *policy.NextRun != fixedNow+7*dayMS {
			t.Fatalf("nextRun = %v, want now + 7 days", policy.NextRun)
		}
	})

	t.Run("timed with no stored next run", func(t *testing.T) {
		prev := DefaultStorageCleanupPolicy()
		prev.Schedule = "weekly"
		policy, err := parseInput(t, `{"enabled":true}`, &prev)
		if err != "" {
			t.Fatalf("error = %q", err)
		}
		if policy.NextRun == nil || *policy.NextRun != fixedNow+7*dayMS {
			t.Fatalf("nextRun = %v, want it computed", policy.NextRun)
		}
	})
}

// Criteria 33 and 34: an untimed schedule drops the next run, unless the
// client explicitly sent one.
func TestUntimedSchedulesClearTheNextRun(t *testing.T) {
	next := float64(999)
	prev := DefaultStorageCleanupPolicy()
	prev.Schedule = "daily"
	prev.NextRun = &next

	policy, err := parseInput(t, `{"schedule":"manual"}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.NextRun != nil {
		t.Fatalf("nextRun = %v, want it cleared", *policy.NextRun)
	}

	policy, err = parseInput(t, `{"schedule":"manual","nextRun":1700000000001}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.NextRun == nil || *policy.NextRun != 1700000000001 {
		t.Fatalf("nextRun = %v, want the explicit value kept", policy.NextRun)
	}
}

// Criteria 35 and 36: null is SENT, not absent. It overwrites the previous
// value and, for nextRun, suppresses the recompute that would otherwise fire.
func TestAnExplicitNullClearsRunMetadata(t *testing.T) {
	next := float64(999)
	prev := DefaultStorageCleanupPolicy()
	prev.Schedule = "daily"
	prev.NextRun = &next
	prev.LastRun = &PolicyLastRun{At: 5, FreedBytes: 6, Removed: 7}

	policy, err := parseInput(t, `{"nextRun":null}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.NextRun != nil {
		t.Fatalf("nextRun = %v; null must clear it AND suppress the recompute",
			*policy.NextRun)
	}

	policy, err = parseInput(t, `{"lastRun":null}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.LastRun != nil {
		t.Fatalf("lastRun = %+v, want it cleared", policy.LastRun)
	}
}

// A PUT that omits enabled must not turn the policy on by itself.
func TestAPutDoesNotImplicitlyEnable(t *testing.T) {
	prev := DefaultStorageCleanupPolicy()
	policy, err := parseInput(t, `{"schedule":"daily"}`, &prev)
	if err != "" {
		t.Fatalf("error = %q", err)
	}
	if policy.Enabled {
		t.Fatal("a PUT that never mentions enabled must leave it off")
	}
}
