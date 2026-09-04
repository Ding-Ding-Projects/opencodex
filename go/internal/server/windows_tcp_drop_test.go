package server

import "testing"

func TestParseTCPQuadsForLocalPortPreservesIPv6ForSafeSkip(t *testing.T) {
	output := "TCP 127.0.0.1:10100 127.0.0.1:55001 ESTABLISHED 7\r\n" +
		"TCP [::1]:10100 [2001:db8::1]:443 CLOSE_WAIT 7\r\n" +
		"TCP 127.0.0.1:99 127.0.0.1:10100 ESTABLISHED 8\r\n"
	rows := ParseTCPQuadsForLocalPort(output, 10100)
	if len(rows) != 2 || rows[0].LocalAddr != "127.0.0.1" || rows[1].LocalAddr != "::1" || !isBareIPv6Address(rows[1].RemoteAddr) {
		t.Fatalf("rows = %#v", rows)
	}
	if value, ok := windowsIPv4DWORD("127.0.0.1"); !ok || value != 0x0100007f {
		t.Fatalf("IPv4 DWORD = %#x, ok=%v", value, ok)
	}
	if windowsPortDWORD(10100) != 0x7427 {
		t.Fatalf("network port = %#x", windowsPortDWORD(10100))
	}
}
