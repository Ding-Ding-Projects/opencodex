import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeHost, handleHostCommand, lanAddresses } from "../src/cli/host";
import { getDefaultConfig, loadConfig, saveConfig, writeRuntimePort } from "../src/config";

let home = "";
let previousHome: string | undefined;
let previousAdmission: string | undefined;
let previousAdmin: string | undefined;
let previousSandbox: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousAdmission = process.env.OPENCODEX_API_AUTH_TOKEN;
  previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  previousSandbox = process.env.OPENCODEX_DEBUG_SANDBOX;
  home = mkdtempSync(join(tmpdir(), "ocx-cli-host-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_DEBUG_SANDBOX;
  saveConfig(getDefaultConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousAdmission === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousAdmission;
  if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
  if (previousSandbox === undefined) delete process.env.OPENCODEX_DEBUG_SANDBOX;
  else process.env.OPENCODEX_DEBUG_SANDBOX = previousSandbox;
  rmSync(home, { recursive: true, force: true });
});

test("host status renders concrete IPv6 addresses as valid bracketed URLs", () => {
  const config = { ...getDefaultConfig(), hostname: "2001:db8::5", port: 10100 };
  expect(describeHost(config).urls).toEqual(["http://[2001:db8::5]:10100/"]);
});

test("host status description advertises an active fallback listener", () => {
  const config = { ...getDefaultConfig(), hostname: "0.0.0.0", port: 10100 };
  const status = describeHost(config, { hostname: "0.0.0.0", port: 49152 });

  expect(status).toMatchObject({ hostname: "0.0.0.0", port: 49152 });
  expect(status.urls).toEqual(lanAddresses().map(address => `http://${address}:49152/`));
});

test("host status prefers the identity-verified runtime port over the configured preference", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ service: "opencodex", status: "ok", pid: process.pid }),
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const config = getDefaultConfig();
    config.port = 10100;
    saveConfig(config);
    writeRuntimePort({ pid: process.pid, port: server.port, hostname: "127.0.0.1" });

    expect(await handleHostCommand(["status", "--json"])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).port).toBe(server.port);
  } finally {
    log.mockRestore();
    server.stop(true);
  }
});

test("host exposure refuses an unreachable config and can generate a one-time data-plane key", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleHostCommand(["enable", "--yes"])).toBe(2);
    expect(loadConfig().hostname).toBeUndefined();

    expect(await handleHostCommand(["enable", "--new-key", "phone", "--yes"])).toBe(0);
    const exposed = loadConfig();
    expect(exposed.hostname).toBe("0.0.0.0");
    expect(exposed.apiKeys).toHaveLength(1);
    expect(exposed.apiKeys?.[0]?.name).toBe("phone");
    expect(log.mock.calls.some(call => String(call[0]).includes("shown once"))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes('key "phone"'))).toBe(true);

    expect(await handleHostCommand(["disable"])).toBe(0);
    expect(loadConfig().hostname).toBe("127.0.0.1");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("host rejects malformed or URL-shaped bind values without changing config", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  process.env.OPENCODEX_API_AUTH_TOKEN = "configured-by-environment";
  try {
    expect(await handleHostCommand(["enable", "--hostname", "--yes"])).toBe(2);
    expect(await handleHostCommand(["enable", "--hostname", "http://192.168.1.5", "--yes"])).toBe(2);
    expect(await handleHostCommand(["enable", "--hostname", "192.168.1.999", "--yes"])).toBe(2);
    expect(await handleHostCommand(["enable", "--new-key", "ocx_looks-like-a-credential", "--yes"])).toBe(2);
    expect(loadConfig().hostname).toBeUndefined();
    expect(loadConfig().apiKeys ?? []).toEqual([]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("host status reports only ADMIN-token presence and documents remote authentication", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "configured-outside-argv";
  try {
    expect(await handleHostCommand(["status", "--json"])).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.managementCredentialConfigured).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("configured-outside-argv");

    log.mockClear();
    expect(await handleHostCommand(["enable"])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("remote dashboard still requires");
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("never pass it in argv");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
