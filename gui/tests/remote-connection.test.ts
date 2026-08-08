import { describe, expect, test } from "bun:test";
import { pageUrlForOrigin } from "../src/app-routing";
import { buildRemoteEndpoint, DEFAULT_REMOTE_PORT } from "../src/remote-connection";
import { openRemoteDashboard } from "../src/remote-navigation";

describe("manual remote endpoint validation", () => {
  test("uses the standard port and builds a credential-free HTTP origin", () => {
    expect(DEFAULT_REMOTE_PORT).toBe(10100);
    expect(buildRemoteEndpoint("192.168.1.50", String(DEFAULT_REMOTE_PORT))).toEqual({
      ok: true,
      host: "192.168.1.50",
      port: 10100,
      url: "http://192.168.1.50:10100",
    });
  });

  test("builds the exact dashboard navigation URL from the route owner", () => {
    const endpoint = buildRemoteEndpoint("192.168.1.50", "10100");
    expect(endpoint.ok && pageUrlForOrigin(endpoint.url, "dashboard")).toBe(
      "http://192.168.1.50:10100/#/dashboard",
    );
  });

  test("opens only the credential-free dashboard URL in a protected new tab", () => {
    const calls: unknown[][] = [];
    const result = openRemoteDashboard(
      "http://remote.example.test:12345",
      (...args) => { calls.push(args); return {} as Window; },
    );
    expect(result).toEqual({
      url: "http://remote.example.test:12345/#/dashboard",
      opened: true,
    });
    expect(calls).toEqual([[
      "http://remote.example.test:12345/#/dashboard",
      "_blank",
      "noopener,noreferrer",
    ]]);
    expect(result.url).not.toContain("@");
    expect(result.url).not.toContain("token");
  });

  test("reports a blocked popup without changing the exact attempted URL", () => {
    expect(openRemoteDashboard("http://remote.example.test:10100", () => null)).toEqual({
      url: "http://remote.example.test:10100/#/dashboard",
      opened: false,
    });
  });

  test("accepts DNS host names and canonicalizes their case and port", () => {
    expect(buildRemoteEndpoint("Remote.Example.Test", "00123")).toEqual({
      ok: true,
      host: "remote.example.test",
      port: 123,
      url: "http://remote.example.test:123",
    });
    expect(buildRemoteEndpoint("localhost", "20100")).toEqual({
      ok: true,
      host: "localhost",
      port: 20100,
      url: "http://localhost:20100",
    });
  });

  test("accepts bracketed or bare IPv6 and emits one canonical bracket pair", () => {
    expect(buildRemoteEndpoint("2001:0DB8:0:0:0:0:0:1", "10100")).toEqual({
      ok: true,
      host: "[2001:db8::1]",
      port: 10100,
      url: "http://[2001:db8::1]:10100",
    });
    expect(buildRemoteEndpoint("[::ffff:192.168.1.1]", "10100")).toEqual({
      ok: true,
      host: "[::ffff:c0a8:101]",
      port: 10100,
      url: "http://[::ffff:c0a8:101]:10100",
    });
  });

  test("rejects schemes, paths, queries, fragments, userinfo, whitespace, and backslashes", () => {
    for (const host of [
      "https://example.test",
      "example.test/path",
      "example.test?x=1",
      "example.test#section",
      "user@example.test",
      " example.test",
      "example.test ",
      "example\\test",
    ]) {
      expect(buildRemoteEndpoint(host, "10100")).toEqual({ ok: false, error: "host" });
    }
  });

  test("rejects ambiguous and malformed IPv4 forms", () => {
    expect(buildRemoteEndpoint("010.000.000.001", "10100")).toEqual({
      ok: false,
      error: "ipv4-leading-zero",
    });
    expect(buildRemoteEndpoint("0177.0.0.1", "10100")).toEqual({
      ok: false,
      error: "ipv4-leading-zero",
    });
    for (const host of [
      "192.168.1.999",
      "127.1",
      "2130706433",
      "1.2.3.4.",
      "0x7f000001",
      "0x7f.1",
    ]) {
      expect(buildRemoteEndpoint(host, "10100")).toEqual({ ok: false, error: "host" });
    }
  });

  test("enforces DNS label and total-length limits", () => {
    const label63 = "a".repeat(63);
    const valid253 = [label63, label63, label63, "a".repeat(61)].join(".");
    expect(valid253).toHaveLength(253);
    expect(buildRemoteEndpoint(valid253, "10100").ok).toBe(true);

    expect(buildRemoteEndpoint(`${"a".repeat(64)}.test`, "10100")).toEqual({
      ok: false,
      error: "host",
    });
    expect(buildRemoteEndpoint(`${valid253}a`, "10100")).toEqual({
      ok: false,
      error: "host",
    });
    expect(buildRemoteEndpoint("-remote.test", "10100")).toEqual({ ok: false, error: "host" });
    expect(buildRemoteEndpoint("remote-.test", "10100")).toEqual({ ok: false, error: "host" });
  });

  test("rejects malformed IPv6 brackets and zone identifiers", () => {
    for (const host of ["[::1", "::1]", "[example.test]", "fe80::1%eth0", "2001:::1"]) {
      expect(buildRemoteEndpoint(host, "10100")).toEqual({ ok: false, error: "host" });
    }
  });

  test("accepts only decimal ports from 1 through 65535", () => {
    expect(buildRemoteEndpoint("example.test", "1").ok).toBe(true);
    expect(buildRemoteEndpoint("example.test", "65535").ok).toBe(true);
    for (const port of ["", " 10100", "10100 ", "0", "65536", "1e4", "+80", "80.0"]) {
      expect(buildRemoteEndpoint("example.test", port)).toEqual({ ok: false, error: "port" });
    }
  });
});
