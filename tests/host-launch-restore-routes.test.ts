import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { addCustomDataPlaneKey, DebugSandboxMintError } from "../src/lib/host-control";
import { startServer } from "../src/server";
import { isDraining, registerTurn, setDraining, unregisterTurn } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * The dashboard's local-machine controls: the launcher, one-click restore, and the
 * graceful Exit.
 *
 * Two properties matter more than the happy paths here, and both are what these
 * tests pin:
 *
 * 1. **A refusal must not leave the proxy drained.** Restore and exit stop admitting
 *    traffic *before* they act, so every early return has to put that back. Miss one
 *    and the proxy answers 503 forever with no error anyone can see — it looks like a
 *    hang, not a failed request.
 * 2. **Live sessions are reported, never dropped.** With work in flight and no
 *    `force`, both routes answer 409 with the real count instead of cutting requests
 *    off, so the user decides.
 *
 * `POST /api/host/exit` with a drained server is deliberately NOT exercised: it calls
 * process.exit, which would take the test runner with it. The 409 branch is the one
 * with logic worth testing; the teardown it shares with POST /api/stop is covered there.
 */

/** A config that actually validates, so the server under test is not silently using defaults. */
function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
      },
    },
  } as unknown as OcxConfig;
}

let testDir: string;
let previousHome: string | undefined;
let previousSandbox: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousSandbox = process.env.OPENCODEX_DEBUG_SANDBOX;
  isolatedCodexHome = installIsolatedCodexHome("ocx-host-routes-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-host-routes-"));
  process.env.OPENCODEX_HOME = testDir;
  delete process.env.OPENCODEX_DEBUG_SANDBOX;
});

afterEach(() => {
  // A test that asserts a draining state must never leak it into the next file.
  setDraining(false);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousSandbox === undefined) delete process.env.OPENCODEX_DEBUG_SANDBOX;
  else process.env.OPENCODEX_DEBUG_SANDBOX = previousSandbox;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTempDir(testDir);
});

describe("debug-sandbox custom data-plane keys", () => {
  test("the library backstop throws before mutating config", () => {
    process.env.OPENCODEX_DEBUG_SANDBOX = "1";
    const config = baseConfig();

    expect(() => addCustomDataPlaneKey(config, "phone", "custom-test-key-123456"))
      .toThrow(DebugSandboxMintError);
    expect(config.apiKeys ?? []).toEqual([]);
  });

  test("both custom-key host routes reject without mutating, persisting, or echoing the key", async () => {
    saveConfig(baseConfig());
    process.env.OPENCODEX_DEBUG_SANDBOX = "1";
    const server = startServer(0);
    const suppliedKey = "custom-test-key-123456";
    try {
      for (const body of [
        { newKeyName: "phone", customKeyValue: suppliedKey },
        { exposed: true, hostname: "0.0.0.0", newKeyName: "phone", customKeyValue: suppliedKey },
      ]) {
        const res = await fetch(new URL("/api/host", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(409);
        const responseText = await res.text();
        expect(responseText).not.toContain(suppliedKey);

        const host = await fetch(new URL("/api/host", server.url)).then(response => response.json()) as {
          credentialConfigured: boolean;
        };
        expect(host.credentialConfigured).toBe(false);
        expect(loadConfig().apiKeys ?? []).toEqual([]);
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET/POST /api/launch", () => {
  test("lists every target with whether it is installed, and never a local path", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/launch", server.url)).then(r => r.json()) as {
        targets: { id: string; label: string; kind: string; available: boolean; installUrl: string }[];
      };
      const ids = body.targets.map(target => target.id);
      expect(ids).toContain("codex-cli");
      expect(ids).toContain("claude-cli");
      expect(ids).toContain("grok-cli");
      expect(ids).toContain("claude-desktop");
      for (const target of body.targets) {
        expect(typeof target.available).toBe("boolean");
        expect(["cli", "desktop"]).toContain(target.kind);
        // The response tells the dashboard where to GET a missing app. It must never
        // hand back a filesystem path — that would leak the machine's layout to any
        // holder of the admin token.
        expect(target.installUrl.startsWith("https://")).toBe(true);
        expect(JSON.stringify(target)).not.toContain("\\");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("an id outside the catalog is refused without spawning anything", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      for (const id of ["../../evil.exe", "cmd.exe", "totally-made-up"]) {
        const res = await fetch(new URL("/api/launch", server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, error: "unknown launch target" });
      }
      // Missing id is a bad request, not an unknown target.
      const empty = await fetch(new URL("/api/launch", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

describe("POST /api/host/restore", () => {
  test("a rejected commit is a 400 and leaves the proxy serving", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      // No history exists in this temp home, and the ref is not a hash anyway. Either
      // way nothing was written, so draining must be lifted again.
      const res = await fetch(new URL("/api/host/restore", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: "HEAD~1" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { success: boolean; touchedDisk: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.touchedDisk).toBe(false);
      expect(isDraining()).toBe(false);
    } finally {
      setDraining(false);
      await server.stop(true);
    }
  });

  test("a missing commit is rejected before anything is quiesced", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/host/restore", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "commit is required" });
      expect(isDraining()).toBe(false);
    } finally {
      setDraining(false);
      await server.stop(true);
    }
  });

  test("in-flight work is reported, not cut off, and serving resumes", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    const inFlight = new AbortController();
    registerTurn(inFlight);
    try {
      // drainMs 0 so the hand-off window expires immediately with the turn still open.
      const res = await fetch(new URL("/api/host/restore", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: "abc1234", drainMs: 0 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { reason: string; activeTurnCount: number };
      expect(body.reason).toBe("sessions-in-progress");
      expect(body.activeTurnCount).toBe(1);
      // The turn was never aborted — the point is that the user decides.
      expect(inFlight.signal.aborted).toBe(false);
      // ...and the proxy is serving again rather than stuck at 503.
      expect(isDraining()).toBe(false);
    } finally {
      unregisterTurn(inFlight);
      setDraining(false);
      await server.stop(true);
    }
  });
});

describe("POST /api/host/exit", () => {
  test("refuses to exit while a session is running, and keeps serving", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    const inFlight = new AbortController();
    registerTurn(inFlight);
    try {
      const res = await fetch(new URL("/api/host/exit", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drainMs: 0 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { success: boolean; reason: string; activeTurnCount: number };
      expect(body.success).toBe(false);
      expect(body.reason).toBe("sessions-in-progress");
      expect(body.activeTurnCount).toBe(1);
      expect(inFlight.signal.aborted).toBe(false);
      expect(isDraining()).toBe(false);
    } finally {
      unregisterTurn(inFlight);
      setDraining(false);
      await server.stop(true);
    }
  });
});

describe("GET /api/host/history", () => {
  test("reports addressable entries alongside the display lines", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const body = await fetch(new URL("/api/host/history", server.url)).then(r => r.json()) as {
        snapshots: string[];
        entries: { hash: string; short: string; subject: string; at: string }[];
      };
      // A fresh home has no history repo yet; both shapes must still be arrays, or the
      // dashboard cannot tell "empty" from "failed".
      expect(Array.isArray(body.snapshots)).toBe(true);
      expect(Array.isArray(body.entries)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
