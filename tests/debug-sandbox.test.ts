/**
 * The debug sandbox: the app runs, the machine is left alone.
 *
 * `OPENCODEX_DEBUG_SANDBOX=1` blocks the two things that are awkward to undo —
 * writing `config.json`, and issuing a pairing key that outlives the session it
 * was made to demonstrate.
 *
 * What is pinned here is mostly what the mode must NOT do, because that is where
 * a convenience feature turns into a liability: it must not fake a successful
 * pairing, must not change how a *wrong* token is answered (which would make the
 * refusal an unauthenticated read of the server's mode), and must not stay on
 * when the variable says something that plainly means off.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfigPath, loadConfig, saveConfig } from "../src/config";
import {
  DEBUG_SANDBOX_ENV,
  announceDebugSandboxOnce,
  debugSandboxEnabled,
  resetDebugSandboxAnnouncementForTests,
} from "../src/lib/debug-sandbox";
import { DebugSandboxMintError, describeHost, mintDataPlaneKey } from "../src/lib/host-control";
import { claimPairingToken, createPairingToken, resetPairingForTests } from "../src/lib/pairing";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { managementFetch } from "./helpers/management-auth";
import { removeTempDir } from "./helpers/temp-dir";

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
    },
  } as unknown as OcxConfig;
}

let testDir: string;
let previousHome: string | undefined;
let previousFlag: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousFlag = process.env[DEBUG_SANDBOX_ENV];
  testDir = mkdtempSync(join(tmpdir(), "ocx-debug-sandbox-"));
  process.env.OPENCODEX_HOME = testDir;
  delete process.env[DEBUG_SANDBOX_ENV];
  resetPairingForTests();
  resetDebugSandboxAnnouncementForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousFlag === undefined) delete process.env[DEBUG_SANDBOX_ENV];
  else process.env[DEBUG_SANDBOX_ENV] = previousFlag;
  resetPairingForTests();
  removeTempDir(testDir);
});

describe("reading the flag", () => {
  test("accepts the four spellings people actually use", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(debugSandboxEnabled({ [DEBUG_SANDBOX_ENV]: raw })).toBe(true);
    }
  });

  test("an unset, empty or falsey value leaves it off", () => {
    // The empty string matters: exporting the name with no value in a shell
    // profile must not quietly arm a mode that stops settings saving.
    expect(debugSandboxEnabled({})).toBe(false);
    for (const raw of ["", "0", "false", "no", "off", "maybe"]) {
      expect(debugSandboxEnabled({ [DEBUG_SANDBOX_ENV]: raw })).toBe(false);
    }
  });
});

describe("config writes", () => {
  test("normally saveConfig writes to disk", () => {
    saveConfig(baseConfig());
    expect(existsSync(getConfigPath())).toBe(true);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf-8")).port).toBe(10100);
  });

  test("in the sandbox nothing reaches the disk at all", () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    saveConfig(baseConfig());
    // Not merely "the file is unchanged" — the file, and the directory the save
    // path would have created and ACL-hardened on the way, must not exist.
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("an existing config is left byte-for-byte alone", () => {
    saveConfig(baseConfig());
    const before = readFileSync(getConfigPath(), "utf-8");

    process.env[DEBUG_SANDBOX_ENV] = "1";
    const changed = { ...baseConfig(), hostname: "0.0.0.0", port: 9999 } as OcxConfig;
    saveConfig(changed);

    expect(readFileSync(getConfigPath(), "utf-8")).toBe(before);
    // And a fresh read still sees the original, so the next start is unaffected.
    expect(loadConfig().hostname).toBe("127.0.0.1");
  });

  test("the mode announces itself exactly once", () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    const lines: string[] = [];
    announceDebugSandboxOnce(m => lines.push(m));
    announceDebugSandboxOnce(m => lines.push(m));
    expect(lines).toHaveLength(1);
    // Silence would be indistinguishable from a bug, so the message has to name
    // the variable the reader needs to unset.
    expect(lines[0]).toContain(DEBUG_SANDBOX_ENV);
  });
});

describe("pairing", () => {
  test("normally a correct token mints a key", () => {
    const config = baseConfig();
    const offer = createPairingToken();
    const result = claimPairingToken(offer.token, config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key).toStartWith("ocx_");
  });

  test("in the sandbox a correct token is refused, and no key is minted", () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    const config = baseConfig();
    const offer = createPairingToken();

    const result = claimPairingToken(offer.token, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("sandbox");
    // The refusal is the point: no credential exists to leak or to forget to
    // revoke afterwards.
    expect(config.apiKeys ?? []).toHaveLength(0);
  });

  test("the refused token is not consumed, so the same code behaves the same twice", () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    const config = baseConfig();
    const offer = createPairingToken();

    for (const _ of [0, 1]) {
      const again = claimPairingToken(offer.token, config);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.reason).toBe("sandbox");
    }

    // And the code is still live: leaving the sandbox pairs it for real without
    // the user having to generate another one.
    delete process.env[DEBUG_SANDBOX_ENV];
    expect(claimPairingToken(offer.token, config).ok).toBe(true);
  });

  test("a WRONG token still answers mismatch, exactly as it would outside the sandbox", () => {
    // If the sandbox answered "sandbox" here, the refusal would depend on nothing
    // but the mode — handing an unauthenticated caller a way to ask whether the
    // desktop is in debug mode. The mode must only be observable to someone who
    // already holds the live code.
    process.env[DEBUG_SANDBOX_ENV] = "1";
    const config = baseConfig();
    createPairingToken();

    const result = claimPairingToken("not-the-token", config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mismatch");
  });

  test("with no pairing outstanding the answer is unchanged too", () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    const result = claimPairingToken("anything", baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-pairing");
  });
});

describe("no credential is issued by any route", () => {
  // Found by RUNNING the sandboxed build, not by reading it: enabling remote
  // access from the dashboard handed out a real `ocx_…` key captioned "shown
  // once, store it now". It was live against the running process and gone at the
  // next start, so a mode promising to issue no keys quietly issued one AND told
  // the user to save something worthless. The guard covered `claimPairingToken`
  // and nothing else.

  test("mintDataPlaneKey itself refuses — the backstop no future caller can slip past", () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    expect(() => mintDataPlaneKey(baseConfig(), "network")).toThrow(DebugSandboxMintError);
  });

  test("and mints normally when the sandbox is off", () => {
    const config = baseConfig();
    expect(mintDataPlaneKey(config, "network")).toStartWith("ocx_");
    expect(config.apiKeys ?? []).toHaveLength(1);
  });

  test("enabling remote access mints nothing and still reaches the exposed state", async () => {
    // Both halves matter. Minting nothing is the fix; still reaching the exposed
    // state is the point of the mode — the credential gate is waived here
    // precisely so the screen this mode exists to look at stays reachable.
    process.env[DEBUG_SANDBOX_ENV] = "1";
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true, mintKeyIfMissing: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { mintedKey?: string | null; exposed?: boolean; debugSandbox?: boolean };
      expect(body.mintedKey ?? null).toBeNull();
      expect(body.exposed).toBe(true);
      expect(body.debugSandbox).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("an explicit --new-key style request mints nothing either", async () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true, newKeyName: "network" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { mintedKey?: string | null }).mintedKey ?? null).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("outside the sandbox the same request still mints, so the fix did not break the feature", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true, mintKeyIfMissing: true }),
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { mintedKey?: string }).mintedKey).toStartWith("ocx_");
    } finally {
      await server.stop(true);
    }
  });
});

describe("the two paths that bypass the funnels", () => {
  // Both found by auditing every writer and every minter rather than the two the
  // guard already covered. Each reaches its effect without going through
  // `saveConfig` or `mintDataPlaneKey`, so neither backstop would have caught it.

  test("POST /api/keys mints its own key format, and is refused too", async () => {
    process.env[DEBUG_SANDBOX_ENV] = "1";
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/keys", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { key?: string; error?: string };
      expect(body.key).toBeUndefined();
      expect(body.error).toContain(DEBUG_SANDBOX_ENV);
    } finally {
      await server.stop(true);
    }
  });

  test("POST /api/host/restore writes state files directly, and is refused before it drains", async () => {
    // The dangerous one: a restore rewrites config on disk without touching
    // `saveConfig`, so in the sandbox it would be the single action that really
    // did change the machine.
    process.env[DEBUG_SANDBOX_ENV] = "1";
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/host/restore", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: "deadbeef" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain(DEBUG_SANDBOX_ENV);
    } finally {
      await server.stop(true);
    }
  });
});

describe("the dashboard is told", () => {
  test("describeHost reports the sandbox so the UI can say so", () => {
    expect(describeHost(baseConfig()).debugSandbox).toBe(false);
    process.env[DEBUG_SANDBOX_ENV] = "1";
    expect(describeHost(baseConfig()).debugSandbox).toBe(true);
  });
});
