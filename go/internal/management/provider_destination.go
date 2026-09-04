package management

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

type ProviderDNSLookup func(context.Context, string) ([]net.IP, error)

func (a *API) providerDestinationResolvedError(ctx context.Context, name string, provider config.ProviderConfig, allowBenchmark bool) error {
	if provider.AllowPrivateNetwork || registryAllowsPrivateNetwork(name) {
		return nil
	}
	parsed, err := url.Parse(strings.TrimSpace(provider.BaseURL))
	if err != nil || parsed.Hostname() == "" {
		return nil
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return fmt.Errorf("baseUrl points to a localhost destination; set allowPrivateNetwork:true only for intentionally local/self-hosted providers")
	}
	if literal := net.ParseIP(host); literal != nil {
		return rejectedProviderIP(host, literal, allowBenchmark)
	}
	lookup := a.providerDNSLookup
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip", host)
		}
	}
	addresses, err := lookup(ctx, host)
	if err != nil {
		return nil // advisory at config-write time; offline DNS is not malicious
	}
	for _, address := range addresses {
		if err := rejectedProviderIP(host, address, allowBenchmark); err != nil {
			return fmt.Errorf("baseUrl hostname %s resolves to a %s", host, err.Error())
		}
	}
	return nil
}

func registryAllowsPrivateNetwork(name string) bool {
	for _, entry := range registry.Providers {
		if entry.ID == name {
			return entry.AllowPrivateNetworkByDefault
		}
	}
	return false
}

func rejectedProviderIP(host string, ip net.IP, allowBenchmark bool) error {
	if ip == nil {
		return nil
	}
	if isMetadataAddress(host, ip) {
		return fmt.Errorf("blocked metadata endpoint (%s)", ip.String())
	}
	if isBenchmarkIPv4(ip) {
		if allowBenchmark {
			return nil
		}
		return fmt.Errorf("benchmark address (%s); set allowPrivateNetwork:true only for intentionally local/self-hosted providers", ip.String())
	}
	detail := ""
	switch {
	case ip.IsLoopback():
		detail = "loopback address"
	case ip.IsPrivate():
		detail = "private-network address"
	case ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast():
		detail = "link-local address"
	case ip.IsUnspecified():
		detail = "unspecified address"
	case ip.IsMulticast():
		detail = "multicast/reserved address"
	case isReservedDocumentationIP(ip):
		detail = "reserved address"
	}
	if detail == "" {
		return nil
	}
	return fmt.Errorf("%s (%s); set allowPrivateNetwork:true only for intentionally local/self-hosted providers", detail, ip.String())
}

func isMetadataAddress(host string, ip net.IP) bool {
	switch host {
	case "instance-data.ec2.internal", "metadata.azure.internal", "metadata.google.internal":
		return true
	}
	for _, raw := range []string{"100.100.100.200", "169.254.169.254", "169.254.170.2", "fd00:ec2::254"} {
		if ip.Equal(net.ParseIP(raw)) {
			return true
		}
	}
	return false
}

func isBenchmarkIPv4(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 198 && (v4[1] == 18 || v4[1] == 19)
}

func isReservedDocumentationIP(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	return v4[0] == 192 && v4[1] == 0 && (v4[2] == 0 || v4[2] == 2) ||
		v4[0] == 198 && v4[1] == 51 && v4[2] == 100 ||
		v4[0] == 203 && v4[1] == 0 && v4[2] == 113 || v4[0] >= 240
}
