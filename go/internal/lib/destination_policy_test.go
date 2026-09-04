package lib

import (
	"context"
	"net"
	"strings"
	"testing"
)

type fixedResolver []net.IPAddr

func (r fixedResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) { return r, nil }

func TestDestinationPolicyLiteralAndResolved(t *testing.T) {
	if got := ProviderDestinationConfigError("http://169.254.169.254/latest", DestinationOptions{AllowPrivateNetwork: true}); !strings.Contains(got, "metadata") {
		t.Fatalf("metadata error = %q", got)
	}
	if got := ProviderDestinationConfigError("http://127.0.0.1:11434", DestinationOptions{}); !strings.Contains(got, "loopback") {
		t.Fatalf("loopback error = %q", got)
	}
	if got := ProviderDestinationConfigError("http://127.0.0.1:11434", DestinationOptions{AllowPrivateNetwork: true}); got != "" {
		t.Fatalf("allowed local error = %q", got)
	}
	got := ProviderDestinationResolvedError(context.Background(), "https://provider.example/v1", DestinationOptions{}, fixedResolver{{IP: net.ParseIP("10.0.0.4")}})
	if !strings.Contains(got, "private-network") {
		t.Fatalf("resolved error = %q", got)
	}
}
