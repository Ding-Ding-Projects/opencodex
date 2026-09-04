package storage

import (
	"encoding/json"
	"strings"
	"testing"
)

func normalizeJSON(t *testing.T, raw string) StorageCleanupPolicy {
	t.Helper()
	decoded, ok := decodeSingleJSONDocument([]byte(raw))
	if !ok {
		t.Fatalf("%s did not decode", raw)
	}
	return NormalizeStorageCleanupPolicy(decoded)
}

// Criteria 1 and 2: anything unusable yields the canonical off state.
func TestNormalizeFallsBackToTheDisabledDefault(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `"policy"`, `7`, `true`, `{}`} {
		policy := normalizeJSON(t, raw)
		if policy.Enabled {
			t.Fatalf("%s produced an ENABLED policy", raw)
		}
		if policy.Trigger.ArchivedBytesOver != defaultArchivedBytesOver ||
			policy.Schedule != "manual" || policy.Mode != "quarantine" {
			t.Fatalf("%s = %+v, want the defaults", raw, policy)
		}
		if policy.Target.RemoveOldestPercent == nil || *policy.Target.RemoveOldestPercent != 25 {
			t.Fatalf("%s target = %+v", raw, policy.Target)
		}
	}
}

// Criteria 3 and 4: only a literal true enables. A truthy value is a malformed
// config, not consent to delete sessions on a timer.
func TestOnlyAnExplicitTrueEnables(t *testing.T) {
	if policy := normalizeJSON(t, `{"enabled":true}`); !policy.Enabled {
		t.Fatal("an explicit true must enable")
	}
	for _, raw := range []string{`{"enabled":"true"}`, `{"enabled":1}`, `{"enabled":null}`} {
		if policy := normalizeJSON(t, raw); policy.Enabled {
			t.Fatalf("%s enabled the policy", raw)
		}
	}
}

// Criteria 5-8 and 10 and 12: a target the code cannot read DISABLES the
// policy rather than falling back to the delete-oldest default.
func TestAMalformedTargetDisablesThePolicy(t *testing.T) {
	for name, raw := range map[string]string{
		"neither field":        `{"enabled":true,"target":{}}`,
		"both fields":          `{"enabled":true,"target":{"reduceToBytes":1,"removeOldestPercent":2}}`,
		"target is null":       `{"enabled":true,"target":null}`,
		"target is an array":   `{"enabled":true,"target":[]}`,
		"target is a string":   `{"enabled":true,"target":"x"}`,
		"negative reduce":      `{"enabled":true,"target":{"reduceToBytes":-1}}`,
		"fractional reduce":    `{"enabled":true,"target":{"reduceToBytes":1.5}}`,
		"percent zero":         `{"enabled":true,"target":{"removeOldestPercent":0}}`,
		"percent over hundred": `{"enabled":true,"target":{"removeOldestPercent":101}}`,
		"percent negative":     `{"enabled":true,"target":{"removeOldestPercent":-5}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if policy := normalizeJSON(t, raw); policy.Enabled {
				t.Fatal("a target this code cannot read must fail closed")
			}
		})
	}
}

// Criteria 9, 11, 13 and 14: validation admits a fractional percent, and
// adoption floors it into 1..100.
func TestValidTargetsAreAdoptedAndClamped(t *testing.T) {
	if policy := normalizeJSON(t, `{"target":{"reduceToBytes":0}}`); policy.Target.ReduceToBytes == nil ||
		*policy.Target.ReduceToBytes != 0 {
		t.Fatalf("target = %+v, want zero bytes adopted", policy.Target)
	}
	for raw, want := range map[string]float64{
		`{"target":{"removeOldestPercent":100}}`: 100,
		`{"target":{"removeOldestPercent":1}}`:   1,
		// Fractions are VALID and get floored, so 0.5 becomes 1 rather than
		// being rejected or becoming a no-op zero.
		`{"target":{"removeOldestPercent":0.5}}`:  1,
		`{"target":{"removeOldestPercent":99.9}}`: 99,
	} {
		policy := normalizeJSON(t, raw)
		if policy.Target.RemoveOldestPercent == nil || *policy.Target.RemoveOldestPercent != want {
			t.Fatalf("%s = %+v, want %v", raw, policy.Target, want)
		}
	}
}

// Criteria 15 and 16: the trigger is NOT fail-closed, and the difference is
// the point — a wrong threshold cannot widen a deletion.
func TestAMalformedTriggerFallsBackWithoutDisabling(t *testing.T) {
	for _, raw := range []string{
		`{"enabled":true,"trigger":{"archivedBytesOver":-1}}`,
		`{"enabled":true,"trigger":{"archivedBytesOver":1.5}}`,
		`{"enabled":true,"trigger":"x"}`,
		`{"enabled":true,"trigger":null}`,
	} {
		policy := normalizeJSON(t, raw)
		if !policy.Enabled {
			t.Fatalf("%s disabled the policy; only a bad TARGET does that", raw)
		}
		if policy.Trigger.ArchivedBytesOver != defaultArchivedBytesOver {
			t.Fatalf("%s trigger = %v, want the default", raw, policy.Trigger.ArchivedBytesOver)
		}
	}
}

// Criteria 17 and 18.
func TestScheduleAndMode(t *testing.T) {
	for _, valid := range []string{"startup", "daily", "weekly", "manual"} {
		if policy := normalizeJSON(t, `{"schedule":"`+valid+`"}`); string(policy.Schedule) != valid {
			t.Fatalf("schedule %s = %s", valid, policy.Schedule)
		}
	}
	for _, raw := range []string{`{"schedule":"hourly"}`, `{"schedule":7}`, `{}`} {
		if policy := normalizeJSON(t, raw); policy.Schedule != "manual" {
			t.Fatalf("%s schedule = %s, want manual", raw, policy.Schedule)
		}
	}

	if policy := normalizeJSON(t, `{"mode":"permanent"}`); policy.Mode != "permanent" {
		t.Fatal("permanent must be adoptable")
	}
	// Permanent deletion is opt-in by exact spelling.
	for _, raw := range []string{`{"mode":"PERMANENT"}`, `{"mode":"other"}`, `{}`} {
		if policy := normalizeJSON(t, raw); policy.Mode != "quarantine" {
			t.Fatalf("%s mode = %s, want quarantine", raw, policy.Mode)
		}
	}
}

// Criteria 19-21b: the run record is all or nothing, and zero is valid for
// both non-negative fields.
func TestLastRunIsAllOrNothing(t *testing.T) {
	policy := normalizeJSON(t, `{"lastRun":{"at":1,"freedBytes":0,"removed":0}}`)
	if policy.LastRun == nil || policy.LastRun.At != 1 ||
		policy.LastRun.FreedBytes != 0 || policy.LastRun.Removed != 0 {
		t.Fatalf("lastRun = %+v; zero is valid for both non-negative fields", policy.LastRun)
	}

	for name, raw := range map[string]string{
		"at is zero":          `{"lastRun":{"at":0,"freedBytes":0,"removed":0}}`,
		"at is negative":      `{"lastRun":{"at":-1,"freedBytes":0,"removed":0}}`,
		"at is fractional":    `{"lastRun":{"at":1.5,"freedBytes":0,"removed":0}}`,
		"at is missing":       `{"lastRun":{"freedBytes":0,"removed":0}}`,
		"freed is negative":   `{"lastRun":{"at":1,"freedBytes":-1,"removed":0}}`,
		"freed is fraction":   `{"lastRun":{"at":1,"freedBytes":1.5,"removed":0}}`,
		"freed is missing":    `{"lastRun":{"at":1,"removed":0}}`,
		"removed is negative": `{"lastRun":{"at":1,"freedBytes":0,"removed":-1}}`,
		"removed is fraction": `{"lastRun":{"at":1,"freedBytes":0,"removed":1.5}}`,
		"removed is missing":  `{"lastRun":{"at":1,"freedBytes":0}}`,
		"not an object":       `{"lastRun":"x"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if policy := normalizeJSON(t, raw); policy.LastRun != nil {
				t.Fatalf("lastRun = %+v, want nothing at all", policy.LastRun)
			}
		})
	}
}

// Criteria 22 and 23.
func TestNextRunAndUnrelatedOverflow(t *testing.T) {
	if policy := normalizeJSON(t, `{"nextRun":1700000000000}`); policy.NextRun == nil ||
		*policy.NextRun != 1700000000000 {
		t.Fatalf("nextRun = %v", policy.NextRun)
	}
	for _, raw := range []string{
		`{"nextRun":null}`, `{"nextRun":0}`, `{"nextRun":-1}`,
		`{"nextRun":1.5}`, `{"nextRun":"soon"}`, `{}`,
	} {
		if policy := normalizeJSON(t, raw); policy.NextRun != nil {
			t.Fatalf("%s nextRun = %v, want absent", raw, *policy.NextRun)
		}
	}
	// An overflowing unrelated field must not cost the whole document.
	if policy := normalizeJSON(t, `{"enabled":true,"junk":1e400}`); !policy.Enabled {
		t.Fatal("an unrelated overflow discarded the policy")
	}
}

// Criterion 24: the persisted shape is what the other runtime reads. Untagged
// Go fields would write `Enabled`, and TypeScript would find no `enabled` key
// and normalize the policy to disabled.
func TestTheMarshalledShapeUsesTheOracleKeys(t *testing.T) {
	percent := float64(25)
	withPercent := StorageCleanupPolicy{
		Enabled:  true,
		Trigger:  PolicyTrigger{ArchivedBytesOver: 1},
		Target:   PolicyTarget{RemoveOldestPercent: &percent},
		Schedule: "daily",
		Mode:     "quarantine",
		LastRun:  &PolicyLastRun{At: 1, FreedBytes: 2, Removed: 3},
	}
	encoded, err := json.Marshal(withPercent)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		`"enabled"`, `"trigger"`, `"archivedBytesOver"`, `"target"`,
		`"removeOldestPercent"`, `"schedule"`, `"mode"`,
		`"lastRun"`, `"at"`, `"freedBytes"`, `"removed"`,
	} {
		if !strings.Contains(string(encoded), key) {
			t.Fatalf("%s is missing %s", encoded, key)
		}
	}
	// nextRun was unset, so the key must be absent rather than null.
	if strings.Contains(string(encoded), `"nextRun"`) {
		t.Fatalf("%s carries an unset nextRun", encoded)
	}

	bytes := float64(99)
	withReduce := withPercent
	withReduce.Target = PolicyTarget{ReduceToBytes: &bytes}
	withReduce.LastRun = nil
	encoded, err = json.Marshal(withReduce)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"reduceToBytes"`) {
		t.Fatalf("%s is missing reduceToBytes", encoded)
	}
	if strings.Contains(string(encoded), `"lastRun"`) {
		t.Fatalf("%s carries an unset lastRun", encoded)
	}
}
