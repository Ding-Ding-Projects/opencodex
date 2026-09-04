package platform

import (
	"os"
	"testing"
)

func TestProcessExistsRejectsInvalidAndProtectsCurrentProcess(t *testing.T) {
	for _, pid := range []int{-1, 0} {
		if ProcessExists(pid) {
			t.Fatalf("invalid pid %d reported as existing", pid)
		}
	}
	if !ProcessExists(os.Getpid()) {
		t.Fatal("current process reported absent")
	}
}
