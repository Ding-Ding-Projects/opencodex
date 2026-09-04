package cli

import "testing"

func TestGracefulStopHostAndDashboardURL(t *testing.T) {
	tests := []struct{ input, stop, dashboard string }{
		{"", "127.0.0.1", "http://localhost:10100"},
		{"0.0.0.0", "127.0.0.1", "http://localhost:10100"},
		{"::1", "::1", "http://[::1]:10100"},
		{"192.168.1.2", "192.168.1.2", "http://192.168.1.2:10100"},
	}
	for _, test := range tests {
		if got := gracefulStopHost(test.input); got != test.stop {
			t.Errorf("gracefulStopHost(%q) = %q, want %q", test.input, got, test.stop)
		}
		if got := dashboardURL(test.input, 10100); got != test.dashboard {
			t.Errorf("dashboardURL(%q) = %q, want %q", test.input, got, test.dashboard)
		}
	}
}
