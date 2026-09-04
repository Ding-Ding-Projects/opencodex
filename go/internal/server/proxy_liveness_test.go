package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestProbeHostnameAndHealthIdentityCompatibility(t *testing.T) {
	if ProbeHostname("0.0.0.0") != "127.0.0.1" || ProbeHostname("::1") != "[::1]" || ProbeHostname("gateway.local") != "gateway.local" {
		t.Fatal("probe hostname normalization mismatch")
	}
	version, uptime := "legacy", 12.0
	if !IsOpenCodexHealthIdentity(&HealthIdentity{Service: "opencodex"}) || !IsOpenCodexHealthIdentity(&HealthIdentity{Status: "ok", Version: &version, Uptime: &uptime}) || IsOpenCodexHealthIdentity(&HealthIdentity{Status: "ok"}) {
		t.Fatal("health identity compatibility mismatch")
	}
}

func TestFindLiveProxyPrefersIdentityCheckedRuntimeRecord(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"service":"opencodex","status":"ok","version":"test","uptime":1,"pid":42}`)
	}))
	defer server.Close()
	host, port := testServerAddress(t, server.URL)
	proxy := FindLiveProxy(context.Background(), ProxyLivenessIO{
		ReadPID: func() int { return 42 },
		ReadRuntime: func(pid int) *ProxyRuntimeRecord {
			if pid == 42 {
				return &ProxyRuntimeRecord{PID: 42, Port: port, Hostname: host}
			}
			return nil
		},
		VerifyPID: func(int) bool { return false },
		Config:    func() (string, int) { return "127.0.0.1", 1 },
		Timeout:   time.Second,
	})
	if proxy == nil || proxy.PID != 42 || proxy.Port != port {
		t.Fatalf("proxy = %#v", proxy)
	}
}

func TestFindLiveProxyNeverPromotesLegacyOrphanRecordPID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"status":"ok","version":"legacy","uptime":1}`)
	}))
	defer server.Close()
	host, port := testServerAddress(t, server.URL)
	proxy := FindLiveProxy(context.Background(), ProxyLivenessIO{
		ReadRuntime: func(pid int) *ProxyRuntimeRecord {
			if pid == 0 {
				return &ProxyRuntimeRecord{PID: 99, Port: port, Hostname: host}
			}
			return nil
		},
		Config:  func() (string, int) { return "127.0.0.1", 1 },
		Timeout: time.Second,
	})
	if proxy == nil || proxy.PID != 0 || proxy.Port != port {
		t.Fatalf("legacy proxy = %#v", proxy)
	}
}

func TestProxyIdentityRejectsForeignAndMismatchedProcesses(t *testing.T) {
	tests := []struct {
		body        string
		expectedPID int
	}{
		{body: `{"status":"ok"}`},
		{body: `{"service":"foreign","status":"ok","version":"x","uptime":1}`},
		{body: `{"service":"opencodex","pid":43}`, expectedPID: 42},
	}
	for _, test := range tests {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = fmt.Fprint(w, test.body) }))
		host, port := testServerAddress(t, server.URL)
		_, ok := ProxyIdentityAt(context.Background(), server.Client(), port, host, test.expectedPID, time.Second)
		server.Close()
		if ok {
			t.Fatalf("accepted identity %s", test.body)
		}
	}
}

func testServerAddress(t *testing.T, raw string) (string, int) {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	return host, port
}
