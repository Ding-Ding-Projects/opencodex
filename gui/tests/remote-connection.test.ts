import { expect, test } from "bun:test";
import { buildRemoteEndpoint, DEFAULT_REMOTE_PORT } from "../src/remote-connection";

test("fills and accepts the standard remote port", () => {
  expect(DEFAULT_REMOTE_PORT).toBe(10100);
  expect(buildRemoteEndpoint("192.168.1.50", String(DEFAULT_REMOTE_PORT))).toEqual({
    ok: true,
    host: "192.168.1.50",
    port: 10100,
    url: "http://192.168.1.50:10100",
  });
});

test("manual host input uses the same endpoint shape as discovery", () => {
  expect(buildRemoteEndpoint(" remote.example.test ", "12345")).toEqual({
    ok: true,
    host: "remote.example.test",
    port: 12345,
    url: "http://remote.example.test:12345",
  });
  expect(buildRemoteEndpoint("2001:db8::1", "10100")).toEqual({
    ok: true,
    host: "[2001:db8::1]",
    port: 10100,
    url: "http://[2001:db8::1]:10100",
  });
});

test("rejects malformed or unsafe hosts and ports", () => {
  expect(buildRemoteEndpoint("", "10100")).toEqual({ ok: false, error: "host" });
  expect(buildRemoteEndpoint("192.168.1.999", "10100")).toEqual({ ok: false, error: "host" });
  expect(buildRemoteEndpoint("https://example.test", "10100")).toEqual({ ok: false, error: "host" });
  expect(buildRemoteEndpoint("example.test", "0")).toEqual({ ok: false, error: "port" });
  expect(buildRemoteEndpoint("example.test", "65536")).toEqual({ ok: false, error: "port" });
  expect(buildRemoteEndpoint("example.test", "1e4")).toEqual({ ok: false, error: "port" });
});
