package cursor

import "testing"

// Cursor answers 502 "Invalid time zone specified: Local" when the env carries Go's
// unnamed local zone, so the request must always carry a real IANA name.
func TestRuntimeTimeZoneNeverReportsLocal(t *testing.T) {
	t.Setenv("TZ", "Asia/Seoul")
	if got := runtimeTimeZone(); got != "Asia/Seoul" {
		t.Fatalf("TZ zone = %q, want Asia/Seoul", got)
	}
	t.Setenv("TZ", "")
	if got := runtimeTimeZone(); got == "" || got == "Local" {
		t.Fatalf("resolved zone = %q, want an IANA name", got)
	}
}
