import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeHost, handleHostCommand, hasDataPlaneCredential } from "../src/cli/host";
import { verifyAdminTokenAgainstProxy } from "../src/lib/host-control";
import { getDefaultConfig } from "../src/config";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * `ocx host` is the only supported way to expose the proxy beyond loopback, so
 * its refusals are the feature. Every test here pins a case where it must NOT
 * write an exposed bind.
 */

function configWith(patch: Partial<OcxConfig>): OcxConfig {
  return { ...getDefaultConfig(), ...patch } as OcxConfig;
}

describe("describeHost", () => {
  test("loopback is not exposed and advertises no URLs", () => {
    const status = describeHost(configWith({ hostname: "127.0.0.1", port: 10100 }));
    expect(status.exposed).toBe(false);
    expect(status.urls).toEqual([]);
  });

  test("a missing hostname is treated as loopback, not as a wildcard bind", () => {
    const status = describeHost(configWith({ hostname: undefined, port: 10100 }));
    expect(status.hostname).toBe("127.0.0.1");
    expect(status.exposed).toBe(false);
  });

  test("a specific non-loopback bind is exposed and advertises exactly that host", () => {
    const status = describeHost(configWith({ hostname: "192.168.1.50", port: 8080 }));
    expect(status.exposed).toBe(true);
    expect(status.urls).toEqual(["http://192.168.1.50:8080/"]);
  });

  test("a wildcard bind is exposed", () => {
    expect(describeHost(configWith({ hostname: "0.0.0.0", port: 10100 })).exposed).toBe(true);
    expect(describeHost(configWith({ hostname: "::", port: 10100 })).exposed).toBe(true);
  });
});

describe("hasDataPlaneCredential", () => {
  const realToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  afterEach(() => {
    if (realToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = realToken;
  });

  test("no keys and no env token means no credential", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    expect(hasDataPlaneCredential(configWith({ apiKeys: [] }))).toBe(false);
  });

  test("a blank key does not count as a credential", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    const config = configWith({ apiKeys: [{ id: "a", name: "n", key: "   ", createdAt: "" }] });
    expect(hasDataPlaneCredential(config)).toBe(false);
  });

  test("a real key or an env token counts", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    expect(hasDataPlaneCredential(configWith({ apiKeys: [{ id: "a", name: "n", key: "ocx_x", createdAt: "" }] }))).toBe(true);
    process.env.OPENCODEX_API_AUTH_TOKEN = "tok";
    expect(hasDataPlaneCredential(configWith({ apiKeys: [] }))).toBe(true);
  });
});

describe("ocx host", () => {
  let home: string;
  let logged: string[];
  let errored: string[];
  const realLog = console.log;
  const realError = console.error;
  const realHome = process.env.OPENCODEX_HOME;
  const realToken = process.env.OPENCODEX_API_AUTH_TOKEN;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-host-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    logged = [];
    errored = [];
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { errored.push(args.join(" ")); };
  });

  afterEach(() => {
    console.log = realLog;
    console.error = realError;
    if (realHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = realHome;
    if (realToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = realToken;
    removeTempDir(home);
  });

  test("refuses to expose without a data-plane credential", async () => {
    expect(await handleHostCommand(["enable", "--yes"])).toBe(2);
    expect(errored.join("\n")).toContain("requires a data-plane credential");
    // and the bind must still be loopback
    logged = [];
    await handleHostCommand(["status", "--json"]);
    expect(JSON.parse(logged.join("\n")).exposed).toBe(false);
  });

  test("refuses to expose without --yes even when a credential exists", async () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "tok";
    expect(await handleHostCommand(["enable"])).toBe(2);
    expect(errored.join("\n")).toContain("--yes");
    logged = [];
    await handleHostCommand(["status", "--json"]);
    expect(JSON.parse(logged.join("\n")).exposed).toBe(false);
  });

  test("rejects a loopback --hostname instead of silently doing nothing", async () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "tok";
    expect(await handleHostCommand(["enable", "--hostname", "127.0.0.1", "--yes"])).toBe(2);
    expect(errored.join("\n")).toContain("not reachable by other devices");
  });

  test("--new-key mints a credential, exposes the bind, and prints the key once", async () => {
    expect(await handleHostCommand(["enable", "--new-key", "--yes"])).toBe(0);
    const out = logged.join("\n");
    expect(out).toContain("shown once");
    expect(out).toMatch(/ocx_[A-Za-z0-9_-]{20,}/);

    logged = [];
    await handleHostCommand(["status", "--json"]);
    const status = JSON.parse(logged.join("\n"));
    expect(status.exposed).toBe(true);
    expect(status.hostname).toBe("0.0.0.0");
    expect(status.credentialConfigured).toBe(true);

    // The key is printed once, never echoed back by a later status read.
    logged = [];
    await handleHostCommand(["status"]);
    expect(logged.join("\n")).not.toMatch(/ocx_[A-Za-z0-9_-]{20,}/);
  });

  test("disable returns to loopback", async () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "tok";
    await handleHostCommand(["enable", "--yes"]);
    expect(await handleHostCommand(["disable"])).toBe(0);
    logged = [];
    await handleHostCommand(["status", "--json"]);
    expect(JSON.parse(logged.join("\n")).exposed).toBe(false);
  });

  test("an unknown subcommand is a usage error, not a silent no-op", async () => {
    expect(await handleHostCommand(["expose"])).toBe(2);
    expect(errored.join("\n")).toContain("unknown command");
  });

  test("token is a legacy no-op after the admin gate removal", async () => {
    expect(await handleHostCommand(["token"])).toBe(0);
    expect(logged.join("\n")).toContain("admin-token gate is disabled permanently");
    expect(errored).toEqual([]);
  });

  test("token --json reports the open management plane without a secret", async () => {
    expect(await handleHostCommand(["token", "--json"])).toBe(0);
    expect(JSON.parse(logged.join("\n"))).toEqual({ adminTokenGate: false, managementApi: "open" });
  });
});

/**
 * The verdict itself: only a literal 401 from the live proxy counts as a
 * rejection. Treating a timeout or a 500 as "wrong token" would send users
 * hunting a credential problem they do not have.
 */
describe("verifyAdminTokenAgainstProxy", () => {
  const proxy = async () => ({ port: 10100, hostname: "0.0.0.0" });

  test("401 from the running proxy is a rejection, and names the endpoint probed", async () => {
    const result = await verifyAdminTokenAgainstProxy("ocx_admin_stale", {
      findProxyFn: proxy,
      fetchFn: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    expect(result.state).toBe("rejected");
    // A wildcard bind is probed on loopback, not on "0.0.0.0".
    expect(result).toMatchObject({ endpoint: "http://127.0.0.1:10100/api/host" });
  });

  test("200 means the running proxy accepts it, and the token rides the management header", async () => {
    let seen: string | null = null;
    const result = await verifyAdminTokenAgainstProxy("ocx_admin_good", {
      findProxyFn: proxy,
      fetchFn: (async (_url: string, init: RequestInit) => {
        seen = new Headers(init.headers).get("x-opencodex-api-key");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result.state).toBe("accepted");
    expect(seen).toBe("ocx_admin_good");
  });

  test("404 still proves the credential passed the auth gate (older build, no /api/host)", async () => {
    const result = await verifyAdminTokenAgainstProxy("ocx_admin_good", {
      findProxyFn: proxy,
      fetchFn: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
    });
    expect(result.state).toBe("accepted");
  });

  test("no running proxy, a transport failure, and a 5xx are unverified — never a rejection", async () => {
    const none = await verifyAdminTokenAgainstProxy("t", { findProxyFn: async () => null });
    expect(none).toEqual({ state: "unverified", reason: "no proxy is running on this machine" });

    const threw = await verifyAdminTokenAgainstProxy("t", {
      findProxyFn: proxy,
      fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(threw.state).toBe("unverified");

    const unavailable = await verifyAdminTokenAgainstProxy("t", {
      findProxyFn: proxy,
      fetchFn: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
    });
    expect(unavailable).toMatchObject({ state: "unverified" });

    const broken = await verifyAdminTokenAgainstProxy("t", {
      findProxyFn: proxy,
      fetchFn: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    });
    expect(broken).toMatchObject({ state: "unverified" });
  });
});
