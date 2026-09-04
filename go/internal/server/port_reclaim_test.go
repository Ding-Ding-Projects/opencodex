package server

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestParseListenPIDsFromLocalizedNetstat(t *testing.T) {
	output := "  TCP    0.0.0.0:10100    0.0.0.0:0    ABHÖREN    42\r\n" +
		"tcp6  0  0 :::10100  :::*  LISTEN  77/ocx\n" +
		"TCP 127.0.0.1:99 127.0.0.1:10100 ESTABLISHED 900\n" +
		"TCP [::1]:10100 [::]:0 LISTENING 42\n"
	if got, want := ParseListenPIDsFromNetstat(output, 10100), []int{42, 77}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pids = %v, want %v", got, want)
	}
}

func TestReclaimListenPortNeverKillsAfterFailedScan(t *testing.T) {
	var availability, kills, drops atomic.Int32
	ok := ReclaimListenPort(context.Background(), "127.0.0.1", 10100, ReclaimListenPortOptions{
		Timeout:         time.Second,
		Interval:        time.Millisecond,
		ScanInterval:    time.Nanosecond,
		KillHolders:     true,
		OnlyKillPIDs:    []int{42},
		DropTCPRows:     true,
		Scan:            func(context.Context, int) ListenPIDScan { return ListenPIDScan{Error: "probe unavailable"} },
		IsAlive:         func(int) bool { return true },
		VerifyOpenCodex: func(int) bool { return true },
		Kill:            func(context.Context, int) error { kills.Add(1); return nil },
		DropTCP:         func(int) error { drops.Add(1); return nil },
		IsAvailable:     func(string, int) bool { return availability.Add(1) >= 4 },
		Sleep:           func(context.Context, time.Duration) error { return nil },
	})
	if !ok || kills.Load() != 0 || drops.Load() != 0 {
		t.Fatalf("ok=%v kills=%d drops=%d", ok, kills.Load(), drops.Load())
	}
}

func TestReclaimListenPortKillsOnlyRevalidatedAllowlistedOpenCodex(t *testing.T) {
	var availability, kills, drops atomic.Int32
	alive := atomic.Bool{}
	alive.Store(true)
	ok := ReclaimListenPort(context.Background(), "127.0.0.1", 10100, ReclaimListenPortOptions{
		Timeout:         time.Second,
		Interval:        time.Millisecond,
		ScanInterval:    time.Nanosecond,
		KillHolders:     true,
		OnlyKillPIDs:    []int{42},
		DropTCPRows:     true,
		Scan:            func(context.Context, int) ListenPIDScan { return ListenPIDScan{OK: true, PIDs: []int{42}} },
		IsAlive:         func(pid int) bool { return pid == 42 && alive.Load() },
		VerifyOpenCodex: func(pid int) bool { return pid == 42 },
		Kill: func(_ context.Context, pid int) error {
			if pid != 42 {
				return errors.New("unexpected pid")
			}
			kills.Add(1)
			alive.Store(false)
			return nil
		},
		DropTCP:     func(int) error { drops.Add(1); return nil },
		IsAvailable: func(string, int) bool { return availability.Add(1) >= 2 },
		Sleep:       func(context.Context, time.Duration) error { return nil },
	})
	if !ok || kills.Load() != 1 || drops.Load() != 1 {
		t.Fatalf("ok=%v kills=%d drops=%d", ok, kills.Load(), drops.Load())
	}
}

func TestIsAddrInUseRecognizesWrappedSyscall(t *testing.T) {
	if !IsAddrInUse(errors.Join(errors.New("bind failed"), syscall.EADDRINUSE)) || IsAddrInUse(errors.New("permission denied")) {
		t.Fatal("address-in-use classification mismatch")
	}
}
