package lib

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
)

var blockedMetadataHosts = map[string]bool{"instance-data.ec2.internal": true, "metadata.azure.internal": true, "metadata.google.internal": true}
var blockedMetadataIPs = map[string]bool{"100.100.100.200": true, "169.254.169.254": true, "169.254.170.2": true, "fd00:ec2::254": true}

type DestinationOptions struct {
	AllowPrivateNetwork          bool
	RegistryAllowsPrivateNetwork bool
}

type IPResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

func ProviderDestinationConfigError(baseURL string, options DestinationOptions) string {
	host, kind, detail, ok := assessDestination(baseURL)
	_ = host
	if !ok {
		return "baseUrl is not a valid HTTP(S) URL"
	}
	if kind == "public" || kind == "hostname" {
		return ""
	}
	if kind == "metadata" {
		return "baseUrl targets a blocked metadata endpoint"
	}
	if options.AllowPrivateNetwork || options.RegistryAllowsPrivateNetwork {
		return ""
	}
	return fmt.Sprintf("baseUrl points to a %s; set allowPrivateNetwork:true only for intentionally local/self-hosted providers", detail)
}

func ProviderDestinationResolvedError(ctx context.Context, baseURL string, options DestinationOptions, resolver IPResolver) string {
	if syncError := ProviderDestinationConfigError(baseURL, options); syncError != "" {
		return syncError
	}
	host, kind, _, ok := assessDestination(baseURL)
	if !ok || kind != "hostname" || options.AllowPrivateNetwork || options.RegistryAllowsPrivateNetwork {
		return ""
	}
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return ""
	}
	for _, address := range addresses {
		kind, detail := classifyIP(address.IP)
		if kind == "public" {
			continue
		}
		if kind == "metadata" {
			return fmt.Sprintf("baseUrl hostname %s resolves to a blocked metadata endpoint (%s)", host, address.IP)
		}
		return fmt.Sprintf("baseUrl hostname %s resolves to a %s (%s); set allowPrivateNetwork:true only for intentionally local/self-hosted providers", host, detail, address.IP)
	}
	return ""
}

func assessDestination(baseURL string) (string, string, string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil {
		return "", "", "", false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if blockedMetadataHosts[host] {
		return host, "metadata", "blocked metadata endpoint", true
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return host, "localhost", "localhost destination", true
	}
	if ip := net.ParseIP(host); ip != nil {
		kind, detail := classifyIP(ip)
		return host, kind, detail, true
	}
	return host, "hostname", "hostname destination", true
}

func classifyIP(ip net.IP) (string, string) {
	canonical := strings.ToLower(ip.String())
	if blockedMetadataIPs[canonical] {
		return "metadata", "blocked metadata endpoint"
	}
	if ip.IsLoopback() {
		return "loopback", "loopback address"
	}
	if ip.IsUnspecified() {
		return "unspecified", "unspecified address"
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return "link-local", "link-local address"
	}
	if ip.IsPrivate() {
		return "private", "private-network address"
	}
	if ip4 := ip.To4(); ip4 != nil {
		a, b, c := ip4[0], ip4[1], ip4[2]
		if a == 100 && b >= 64 && b <= 127 {
			return "private", "private-network address"
		}
		if a == 192 && b == 0 && (c == 0 || c == 2) || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100) || a == 203 && b == 0 && c == 113 || a >= 224 {
			return "private", "reserved address"
		}
	}
	return "public", "public IP"
}
