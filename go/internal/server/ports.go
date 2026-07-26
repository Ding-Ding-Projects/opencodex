package server

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// IsAddrInUse limits ephemeral-port fallback to the one bind failure where a
// retry is safe. Configuration and permission failures must remain visible.
func IsAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, syscall.EADDRINUSE) || strings.Contains(strings.ToLower(err.Error()), "eaddrinuse") || strings.Contains(strings.ToLower(err.Error()), "address already in use")
}

// IsPortAvailable reports whether an address can currently be bound.
func IsPortAvailable(host string, port int) bool {
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}

// WaitForPortAvailable polls until the configured address can be rebound.
func WaitForPortAvailable(host string, port int, timeout, interval time.Duration) bool {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	for {
		if IsPortAvailable(host, port) {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(interval)
	}
}

// FindAvailablePort returns preferred when possible, otherwise an OS-selected port.
func FindAvailablePort(host string, preferred int, allowFallback bool) (int, error) {
	if preferred > 0 && IsPortAvailable(host, preferred) {
		return preferred, nil
	}
	if !allowFallback {
		return 0, fmt.Errorf("port %d on %s is unavailable", preferred, host)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	return port, nil
}
