package server

import (
	"net"
	"testing"
	"time"
)

func TestFindAvailablePortFallsBack(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	busy := listener.Addr().(*net.TCPAddr).Port
	port, err := FindAvailablePort("127.0.0.1", busy, true)
	if err != nil {
		t.Fatal(err)
	}
	if port == 0 || port == busy {
		t.Fatalf("fallback port = %d", port)
	}
}

func TestFindAvailablePortRetriesPreferredAndPersistenceDecision(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	preferred := listener.Addr().(*net.TCPAddr).Port
	go func() {
		time.Sleep(25 * time.Millisecond)
		_ = listener.Close()
	}()
	selected, err := FindAvailablePortWithOptions("127.0.0.1", preferred, FindAvailablePortOptions{PreferRetry: time.Second, PreferRetryInterval: 5 * time.Millisecond})
	if err != nil || selected != preferred || !ShouldPersistSelectedPort(0, selected, preferred) || ShouldPersistSelectedPort(preferred, selected, preferred) {
		t.Fatalf("selected=%d preferred=%d err=%v", selected, preferred, err)
	}
}
