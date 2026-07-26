package server

import (
	"net"
	"strconv"
	"strings"
)

type TCPQuad struct {
	LocalAddr  string
	LocalPort  int
	RemoteAddr string
	RemotePort int
	State      string
}

type WindowsTCPDropResult struct {
	Dropped     int
	SkippedIPv6 int
}

// ParseTCPQuadsForLocalPort extracts only rows whose local endpoint owns port.
// It intentionally retains IPv6 rows so the Windows implementation can count
// and skip them instead of coercing them into an unrelated IPv4 wildcard row.
func ParseTCPQuadsForLocalPort(output string, port int) []TCPQuad {
	rows := make([]TCPQuad, 0)
	for _, raw := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		fields := strings.Fields(strings.TrimSpace(raw))
		if len(fields) < 4 || !strings.EqualFold(fields[0], "TCP") {
			continue
		}
		localHost, localPort, localOK := splitNetstatEndpoint(fields[1])
		if !localOK || localPort != port {
			continue
		}
		remoteHost, remotePort, remoteOK := splitNetstatEndpoint(fields[2])
		if !remoteOK {
			continue
		}
		rows = append(rows, TCPQuad{LocalAddr: localHost, LocalPort: localPort, RemoteAddr: remoteHost, RemotePort: remotePort, State: fields[3]})
	}
	return rows
}

func splitNetstatEndpoint(endpoint string) (string, int, bool) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "*:*" {
		return "0.0.0.0", 0, true
	}
	if host, portText, err := net.SplitHostPort(endpoint); err == nil {
		port, parseErr := strconv.Atoi(portText)
		return normalizeNetstatHost(host), port, parseErr == nil && port >= 0 && port <= 65535
	}
	colon := strings.LastIndexByte(endpoint, ':')
	if colon <= 0 || colon == len(endpoint)-1 {
		return "", 0, false
	}
	port, err := strconv.Atoi(endpoint[colon+1:])
	if err != nil || port < 0 || port > 65535 {
		return "", 0, false
	}
	return normalizeNetstatHost(endpoint[:colon]), port, true
}

func normalizeNetstatHost(host string) string {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	host = strings.TrimPrefix(strings.ToLower(host), "::ffff:")
	if host == "" || host == "*" {
		return "0.0.0.0"
	}
	return host
}

func isBareIPv6Address(address string) bool {
	host := normalizeNetstatHost(address)
	return strings.Contains(host, ":") && net.ParseIP(host) != nil && net.ParseIP(host).To4() == nil
}

func windowsIPv4DWORD(address string) (uint32, bool) {
	host := normalizeNetstatHost(address)
	if host == "0.0.0.0" {
		return 0, true
	}
	ip := net.ParseIP(host).To4()
	if ip == nil {
		return 0, false
	}
	return uint32(ip[0]) | uint32(ip[1])<<8 | uint32(ip[2])<<16 | uint32(ip[3])<<24, true
}

func windowsPortDWORD(port int) uint32 {
	return uint32((port&0xff)<<8 | (port>>8)&0xff)
}
