package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HealthIdentity struct {
	Service string   `json:"service"`
	Status  string   `json:"status"`
	Version *string  `json:"version"`
	Uptime  *float64 `json:"uptime"`
	PID     *int     `json:"pid"`
}

type ProxyRuntimeRecord struct {
	PID      int
	Port     int
	Hostname string
}

type LiveProxy struct {
	PID      int
	Port     int
	Hostname string
}

type ProxyLivenessIO struct {
	Client      *http.Client
	ReadPID     func() int
	VerifyPID   func(int) bool
	ReadRuntime func(pid int) *ProxyRuntimeRecord
	Config      func() (hostname string, port int)
	Timeout     time.Duration
}

func ProbeHostname(hostname string) string {
	hostname = strings.TrimSpace(hostname)
	if hostname == "" || hostname == "0.0.0.0" || hostname == "::" || hostname == "[::]" {
		return "127.0.0.1"
	}
	if strings.HasPrefix(hostname, "[") && strings.HasSuffix(hostname, "]") {
		return hostname
	}
	if strings.Contains(hostname, ":") {
		return "[" + hostname + "]"
	}
	return hostname
}

func IsOpenCodexHealthIdentity(identity *HealthIdentity) bool {
	if identity == nil {
		return false
	}
	if identity.Service == "opencodex" {
		return true
	}
	return identity.Service == "" && identity.Status == "ok" && identity.Version != nil && identity.Uptime != nil
}

// ProxyIdentityAt accepts the legacy identity shape for update compatibility,
// but an explicit mismatching PID always rejects the candidate.
func ProxyIdentityAt(ctx context.Context, client *http.Client, port int, hostname string, expectedPID int, timeout time.Duration) (*HealthIdentity, bool) {
	if port <= 0 || port > 65535 {
		return nil, false
	}
	if timeout <= 0 {
		timeout = 750 * time.Millisecond
	}
	probeContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	host := strings.Trim(ProbeHostname(hostname), "[]")
	endpoint := (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, fmt.Sprint(port)), Path: "/healthz"}).String()
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, false
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, false
	}
	var identity HealthIdentity
	decoder := json.NewDecoder(io.LimitReader(response.Body, 64<<10))
	if decoder.Decode(&identity) != nil || !IsOpenCodexHealthIdentity(&identity) {
		return nil, false
	}
	if expectedPID > 0 && identity.PID != nil && *identity.PID != expectedPID {
		return nil, false
	}
	return &identity, true
}

// FindLiveProxy checks the PID-bound runtime record first, then an orphan
// runtime record, and only then the configured port. PIDs from files are never
// returned to destructive callers unless health or VerifyPID confirms them.
func FindLiveProxy(ctx context.Context, input ProxyLivenessIO) *LiveProxy {
	timeout := input.Timeout
	if timeout <= 0 {
		timeout = 750 * time.Millisecond
	}
	readRuntime := input.ReadRuntime
	verify := input.VerifyPID
	trustedPID := func(candidate int) int {
		if candidate > 0 && verify != nil && verify(candidate) {
			return candidate
		}
		return 0
	}
	pid := 0
	if input.ReadPID != nil {
		pid = input.ReadPID()
	}
	probedPort := 0
	if pid > 0 && readRuntime != nil {
		if record := readRuntime(pid); record != nil && record.Port > 0 {
			probedPort = record.Port
			if identity, ok := ProxyIdentityAt(ctx, input.Client, record.Port, record.Hostname, pid, timeout); ok {
				confirmed := trustedPID(pid)
				if identity.PID != nil && *identity.PID == pid {
					confirmed = pid
				}
				return &LiveProxy{PID: confirmed, Port: record.Port, Hostname: record.Hostname}
			}
		}
	}
	if readRuntime != nil {
		if record := readRuntime(0); record != nil && record.Port > 0 && record.Port != probedPort {
			if identity, ok := ProxyIdentityAt(ctx, input.Client, record.Port, record.Hostname, record.PID, timeout); ok {
				confirmed := 0
				if identity.PID != nil {
					confirmed = *identity.PID
				}
				return &LiveProxy{PID: confirmed, Port: record.Port, Hostname: record.Hostname}
			}
		}
	}
	host, port := "127.0.0.1", 10100
	if input.Config != nil {
		host, port = input.Config()
	}
	if identity, ok := ProxyIdentityAt(ctx, input.Client, port, host, 0, timeout); ok {
		confirmed := trustedPID(pid)
		if identity.PID != nil {
			confirmed = *identity.PID
		}
		return &LiveProxy{PID: confirmed, Port: port, Hostname: host}
	}
	return nil
}
