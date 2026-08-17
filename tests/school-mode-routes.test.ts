/**
 * `/api/school-mode*` end to end through `handleManagementAPI`, exactly the
 * way the GUI reaches it.
 *
 * Every test points `OPENCODEX_SCHOOL_MODE_DIR` at a throwaway temp
 * directory and resets the store's in-memory caches — this suite must never
 * touch the real shared location on the machine running it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { resetSchoolModeWatchForTests } from "../src/server/management/school-mode-routes";
import { resetSchoolModeStoreForTests } from "../src/school-mode/store";
import type { OcxConfig } from "../src/types";

function baseConfig(): OcxConfig {
  return {
    port: 10123,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    },
  } as OcxConfig;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    // Bun's `Request` does not always surface a synthesized `Host` header for
    // an in-process (non-socket) request the way it does for one dispatched
    // through a real `Bun.serve()` round trip — observed to vary by process
    // state in this Bun version. `managementRequestOrigin` (auth-cors.ts)
    // requires one, so it is set explicitly rather than relying on that.
    headers: { Host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), baseConfig());
  if (!res) throw new Error(`unrouted: ${method} ${path}`);
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, json };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-school-mode-routes-"));
  process.env.OPENCODEX_SCHOOL_MODE_DIR = dir;
  resetSchoolModeStoreForTests();
  resetSchoolModeWatchForTests();
});

afterEach(() => {
  resetSchoolModeWatchForTests();
  delete process.env.OPENCODEX_SCHOOL_MODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/school-mode", () => {
  test("the never-configured state is off, with no credential and a readable/watchable record", async () => {
    const { status, json } = await call("GET", "/api/school-mode");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      enabled: false,
      hasCustomName: false,
      customName: null,
      hasCredential: false,
      recordReadable: true,
      recordWatchable: true,
    });
    expect(typeof json.recordDir).toBe("string");
  });

  test("never echoes a credential", async () => {
    await call("POST", "/api/school-mode/credential", { newSecret: "first-pin-1234" });
    const { json } = await call("GET", "/api/school-mode");
    expect(JSON.stringify(json)).not.toContain("first-pin-1234");
    expect(json.credential).toBeUndefined();
  });
});

describe("POST /api/school-mode/enable", () => {
  test("is refused before any credential exists", async () => {
    const { status, json } = await call("POST", "/api/school-mode/enable");
    expect(status).toBe(409);
    expect(json.error).toBe("no-credential");
    const after = await call("GET", "/api/school-mode");
    expect(after.json.enabled).toBe(false);
  });

  test("succeeds once a credential is set", async () => {
    await call("POST", "/api/school-mode/credential", { newSecret: "abcd1234" });
    const { status, json } = await call("POST", "/api/school-mode/enable");
    expect(status).toBe(200);
    expect(json.enabled).toBe(true);
  });

  test("is idempotent — enabling twice is not an error", async () => {
    await call("POST", "/api/school-mode/credential", { newSecret: "abcd1234" });
    await call("POST", "/api/school-mode/enable");
    const { status, json } = await call("POST", "/api/school-mode/enable");
    expect(status).toBe(200);
    expect(json.enabled).toBe(true);
  });
});

describe("POST /api/school-mode/disable", () => {
  async function enabledWithSecret(secret: string) {
    await call("POST", "/api/school-mode/credential", { newSecret: secret });
    await call("POST", "/api/school-mode/enable");
  }

  test("refuses a wrong credential and leaves the mode on", async () => {
    await enabledWithSecret("right-pin-1");
    const { status, json } = await call("POST", "/api/school-mode/disable", { secret: "wrong-pin" });
    expect(status).toBe(401);
    expect(json.error).toBe("invalid-credential");
    const after = await call("GET", "/api/school-mode");
    expect(after.json.enabled).toBe(true);
  });

  test("succeeds with the right credential", async () => {
    await enabledWithSecret("right-pin-1");
    const { status, json } = await call("POST", "/api/school-mode/disable", { secret: "right-pin-1" });
    expect(status).toBe(200);
    expect(json.enabled).toBe(false);
  });

  test("turning off never deletes the credential — the same PIN turns it back on", async () => {
    await enabledWithSecret("right-pin-1");
    await call("POST", "/api/school-mode/disable", { secret: "right-pin-1" });
    const afterOff = await call("GET", "/api/school-mode");
    expect(afterOff.json.hasCredential).toBe(true);
    const reEnable = await call("POST", "/api/school-mode/enable");
    expect(reEnable.status).toBe(200);
    expect(reEnable.json.enabled).toBe(true);
  });

  test("is a no-op when already off", async () => {
    const { status, json } = await call("POST", "/api/school-mode/disable", { secret: "anything" });
    expect(status).toBe(200);
    expect(json.enabled).toBe(false);
  });
});

describe("POST /api/school-mode/credential", () => {
  test("sets the first credential with no prior secret required", async () => {
    const { status, json } = await call("POST", "/api/school-mode/credential", { newSecret: "abcd1234" });
    expect(status).toBe(200);
    expect(json.hasCredential).toBe(true);
  });

  test("refuses a secret shorter than the minimum", async () => {
    const { status, json } = await call("POST", "/api/school-mode/credential", { newSecret: "ab" });
    expect(status).toBe(400);
    expect(json.error).toBe("too-short");
  });

  test("changing an existing credential requires the current one", async () => {
    await call("POST", "/api/school-mode/credential", { newSecret: "abcd1234" });
    const wrong = await call("POST", "/api/school-mode/credential", { newSecret: "newnewnew", currentSecret: "not-it" });
    expect(wrong.status).toBe(401);

    const right = await call("POST", "/api/school-mode/credential", { newSecret: "newnewnew", currentSecret: "abcd1234" });
    expect(right.status).toBe(200);

    // The old secret no longer unlocks; the new one does.
    await call("POST", "/api/school-mode/enable");
    const oldFails = await call("POST", "/api/school-mode/disable", { secret: "abcd1234" });
    expect(oldFails.status).toBe(401);
    const newWorks = await call("POST", "/api/school-mode/disable", { secret: "newnewnew" });
    expect(newWorks.status).toBe(200);
  });
});

describe("POST /api/school-mode/rename", () => {
  test("sets a custom name", async () => {
    const { status, json } = await call("POST", "/api/school-mode/rename", { name: "Focus mode" });
    expect(status).toBe(200);
    expect(json.hasCustomName).toBe(true);
    expect(json.customName).toBe("Focus mode");
  });

  test("null clears back to the shipped default name", async () => {
    await call("POST", "/api/school-mode/rename", { name: "Focus mode" });
    const { json } = await call("POST", "/api/school-mode/rename", { name: null });
    expect(json.hasCustomName).toBe(false);
    expect(json.customName).toBeNull();
  });

  test("refuses an empty or oversized name", async () => {
    const empty = await call("POST", "/api/school-mode/rename", { name: "   " });
    expect(empty.status).toBe(400);
    const oversized = await call("POST", "/api/school-mode/rename", { name: "x".repeat(200) });
    expect(oversized.status).toBe(400);
  });

  test("does not require the credential — renaming is not the security-relevant action", async () => {
    await call("POST", "/api/school-mode/credential", { newSecret: "abcd1234" });
    await call("POST", "/api/school-mode/enable");
    const { status } = await call("POST", "/api/school-mode/rename", { name: "Quiet time" });
    expect(status).toBe(200);
  });
});
