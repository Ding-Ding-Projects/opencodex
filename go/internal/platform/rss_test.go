package platform

import (
	"runtime"
	"testing"
)

// The probe has to report the process's real residency. A constant, a zero, or
// runtime.MemStats.Sys would all satisfy "returns a number", so the assertions
// below check the properties that distinguish a real measurement.
func TestResidentSetSizeReportsLiveProcessMemory(t *testing.T) {
	resident, ok := ResidentSetSize()
	if !ok {
		t.Skipf("no resident-memory probe on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	if resident == 0 {
		t.Fatal("resident set size reported as 0 bytes for a running process")
	}
	// A Go process that has reached its own test binary holds more than a page
	// and, on any machine this can run on, far less than a terabyte.
	if minimum := uint64(1 << 20); resident < minimum {
		t.Fatalf("resident set size = %d bytes, implausibly small (< %d)", resident, minimum)
	}
	if maximum := uint64(1) << 40; resident > maximum {
		t.Fatalf("resident set size = %d bytes, implausibly large (> %d)", resident, maximum)
	}
}

// Sys counts address space the runtime reserved and does not shrink; residency
// moves with what the process actually touches. Allocating and writing to a
// large buffer must be visible, which is what proves this is not a constant.
func TestResidentSetSizeTracksTouchedMemory(t *testing.T) {
	before, ok := ResidentSetSize()
	if !ok {
		t.Skipf("no resident-memory probe on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	const bytes = 64 << 20
	ballast := make([]byte, bytes)
	// Touch every page: an untouched allocation may never become resident.
	for index := 0; index < len(ballast); index += 4096 {
		ballast[index] = 1
	}
	after, _ := ResidentSetSize()
	// Keep the allocation alive across the measurement.
	runtime.KeepAlive(ballast)
	if after <= before {
		t.Fatalf("resident set size did not grow after touching %d bytes: before=%d after=%d", bytes, before, after)
	}
}
