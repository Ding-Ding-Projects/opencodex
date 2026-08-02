/**
 * 429 failover when the keys live in environment variables.
 *
 * `"apiKey": "${XAI_API_KEY}"` is the documented form for a secret, and the pool
 * stores exactly that text. The router expands it before use — `route.provider
 * .apiKey = resolveEnvValue(provider.apiKey)` — so the value callers hand back
 * as `attemptedKey` is the *expanded* secret while the pool still holds the
 * placeholder.
 *
 * `pool.find(e => e.key === failedKey)` therefore never matched, and three
 * things followed from that one miss: nothing was cooled, the "lost the race"
 * branch returned the same un-rotated key, and the retry went upstream as
 * `Authorization: Bearer ${XAI_API_KEY}` — those twelve literal characters. A
 * recoverable 429 became a 401, and the second key was never tried at all.
 *
 * `tests/key-failover.test.ts` covers the same paths with literal keys, which is
 * why this went unnoticed: every assertion there passes either way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearKeyCooldowns, getKeyCooldownUntil, rotateKeyOn429 } from "../src/providers/key-failover";
import type { OcxConfig } from "../src/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-keyfail-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  process.env.KEY_A = "sk-real-aaaa";
  process.env.KEY_B = "sk-real-bbbb";
  clearKeyCooldowns();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KEY_A;
  delete process.env.KEY_B;
  clearKeyCooldowns();
});

/** A provider whose pool holds env references, as the docs describe. */
function envConfig(): OcxConfig {
  return {
    providers: {
      xai: {
        apiKey: "${KEY_A}",
        apiKeyPool: [
          { id: "a", key: "${KEY_A}" },
          { id: "b", key: "${KEY_B}" },
        ],
      },
    },
  } as unknown as OcxConfig;
}

describe("a 429 on an env-referenced key", () => {
  test("cools the key that actually failed", () => {
    const config = envConfig();
    // What the caller has is the expanded secret — that is what it sent.
    rotateKeyOn429(config, "xai", null, Date.now(), "sk-real-aaaa");
    expect(getKeyCooldownUntil("xai", "a")).not.toBeNull();
  });

  test("rotates to the other key instead of returning the same one", () => {
    const config = envConfig();
    const rotated = rotateKeyOn429(config, "xai", null, Date.now(), "sk-real-aaaa");
    expect(rotated).not.toBeNull();
    // Either spelling of key B is correct here; what must NOT happen is key A.
    expect([rotated!.apiKey, process.env.KEY_B]).toContain("${KEY_B}");
    expect(rotated!.apiKey).not.toBe("${KEY_A}");
  });

  test("does not cool the key it rotated TO", () => {
    const config = envConfig();
    rotateKeyOn429(config, "xai", null, Date.now(), "sk-real-aaaa");
    expect(getKeyCooldownUntil("xai", "b")).toBeNull();
  });

  test("returns null once every key has failed, rather than looping", () => {
    const config = envConfig();
    const now = Date.now();
    rotateKeyOn429(config, "xai", null, now, "sk-real-aaaa");
    rotateKeyOn429(config, "xai", null, now, "sk-real-bbbb");
    expect(rotateKeyOn429(config, "xai", null, now, "sk-real-bbbb")).toBeNull();
  });
});

describe("literal keys still behave exactly as before", () => {
  const literal = (): OcxConfig => ({
    providers: {
      xai: {
        apiKey: "k1",
        apiKeyPool: [{ id: "a", key: "k1" }, { id: "b", key: "k2" }],
      },
    },
  }) as unknown as OcxConfig;

  test("cools the failed key and rotates", () => {
    const config = literal();
    const rotated = rotateKeyOn429(config, "xai", null, Date.now(), "k1");
    expect(rotated?.apiKey).toBe("k2");
    expect(getKeyCooldownUntil("xai", "a")).not.toBeNull();
  });
});

describe("the last key in the pool is reachable", () => {
  test("an unknown failed key can still rotate onto the final entry", () => {
    // With the failed key absent from the pool the search used to start at index
    // -1 and walk 1..length-1, covering 0..length-2 — so the last entry was
    // never offered. With a two-key pool that is half the pool.
    const config = {
      providers: {
        xai: {
          apiKey: "gone",
          apiKeyPool: [{ id: "a", key: "k1" }, { id: "b", key: "k2" }],
        },
      },
    } as unknown as OcxConfig;
    const now = Date.now();
    // Cool the first entry so only the last one is eligible.
    rotateKeyOn429(config, "xai", null, now, "k1");
    clearKeyCooldowns("xai");
    rotateKeyOn429(config, "xai", null, now, "k1");

    const rotated = rotateKeyOn429(config, "xai", null, now, "not-in-the-pool");
    expect(rotated).not.toBeNull();
  });
});
