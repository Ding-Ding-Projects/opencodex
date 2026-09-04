package claude

import "testing"

func TestDesktopHealthStatusTransitions(t *testing.T) {
	tracker := NewDesktopHealthTracker()
	initial := tracker.Status()
	if initial.LastRequestAt != nil || initial.RequestCount != 0 || initial.ErrorCount != 0 {
		t.Fatalf("initial health = %#v", initial)
	}
	tracker.RecordRequest()
	afterRequest := tracker.Status()
	if afterRequest.LastRequestAt == nil || afterRequest.RequestCount != 1 || afterRequest.ErrorCount != 0 {
		t.Fatalf("after request = %#v", afterRequest)
	}
	tracker.RecordError()
	afterError := tracker.Status()
	if afterError.RequestCount != 1 || afterError.ErrorCount != 1 {
		t.Fatalf("after error = %#v", afterError)
	}
}
