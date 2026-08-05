/**
 * The HTTP surface of QR pairing.
 *
 * `tests/pairing.test.ts` pins the token itself — 256 bits, single use, five
 * minutes, one at a time, never an admin token. This file pins the thing that
 * makes those properties reachable: three routes, with the claim deliberately
 * answering WITHOUT a credential because receiving a credential is its purpose.
 *
 * The claim's token-bound validation is the reason this file exists. The
 * management plane is intentionally open, while `POST /api/host/pair/claim`
 * still has its own 400/429/413 contract and never treats a malformed scan as
 * an authentication failure.
 *
 * Every request below goes over a real socket through the real server, because
 * route dispatch and the HTTP status contract are part of the behavior under
 * test; calling a handler directly would skip that wiring.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, saveConfig } from "../src/config";
import { PAIRED_KEY_NAME, PAIRING_TTL_MS, resetPairingForTests } from "../src/lib/pairing";
import { CLAIM_ATTEMPTS_PER_WINDOW, resetPairingRateLimitForTests } from "../src/lib/pairing-rate-limit";
import { MAX_CLAIM_BODY_BYTES } from "../src/server/management/host-routes";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { managementFetch } from "./helpers/management-auth";
import { removeTempDir } from "./helpers/temp-dir";

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
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-pairing-routes-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-pairing-routes-"));
  process.env.OPENCODEX_HOME = testDir;
  // Both are process-wide, so a case that mints a token or spends the claim
  // budget would otherwise decide the next one. The budget matters more than it
  // looks: it is only ten attempts per minute, and a file with a dozen claim
  // cases would start answering 429 partway through for no stated reason.
  resetPairingForTests();
  resetPairingRateLimitForTests();
});

afterEach(() => {
  // Undo any clock travel before the next case reads Date.now().
  setSystemTime();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTempDir(testDir);
});

/** Mint through the management route, the way the dashboard does. */
async function mintToken(base: string): Promise<{ token: string; expiresAt: number }> {
  const res = await managementFetch(new URL("/api/host/pair", base), { method: "POST" });
  expect(res.status).toBe(200);
  return await res.json() as { token: string; expiresAt: number };
}

/**
 * Claim with NO credential of any kind — `globalThis.fetch`, not the management
 * helper. If this ever needs a header, pairing is broken for the only client
 * that will ever call it.
 */
function claim(base: string, token: unknown): Promise<Response> {
  return globalThis.fetch(new URL("/api/host/pair/claim", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

describe("the unauthenticated claim", () => {
  test("is reachable without a credential on the open management plane", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      // A sibling management route is also open by design; an invalid claim is
      // refused by the pairing handler itself, not by an auth gate.
      const management = await globalThis.fetch(new URL("/api/host", server.url));
      expect(management.status).toBe(200);

      const claimed = await claim(server.url, "no-such-token");
      expect(claimed.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("consumes the token and returns a data-plane key, once", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const offer = await mintToken(server.url);

      const first = await claim(server.url, offer.token);
      expect(first.status).toBe(200);
      const body = await first.json() as { key?: string };
      expect(typeof body.key).toBe("string");
      expect(body.key?.startsWith("ocx_")).toBe(true);

      // Persisted, not merely held in the live config — a key that vanished on
      // restart would work all afternoon and fail tomorrow.
      const saved = loadConfig();
      expect(saved.apiKeys?.some(entry => entry.key === body.key)).toBe(true);
      expect(saved.apiKeys?.find(entry => entry.key === body.key)?.name).toBe(PAIRED_KEY_NAME);

      // The second claim is the property that makes a QR on a screen acceptable:
      // by the time anyone else photographs it, the intended phone has spent it.
      const second = await claim(server.url, offer.token);
      expect(second.status).toBe(400);
      expect(loadConfig().apiKeys ?? []).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("refuses an expired token", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const offer = await mintToken(server.url);

      // Real clock travel rather than a five-minute sleep. The route reads
      // Date.now() with no seam of its own, which is the point: this exercises
      // the expiry the shipping code actually uses.
      setSystemTime(new Date(Date.now() + PAIRING_TTL_MS + 1_000));

      const res = await claim(server.url, offer.token);
      expect(res.status).toBe(400);
      expect((await res.json() as { reason?: string }).reason).toBe("expired");
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a wrong token mints nothing and does not cancel the outstanding one", async () => {
    // Otherwise anyone who can reach this endpoint cancels a legitimate pairing
    // by guessing once — a denial of service that needs no secret at all, on the
    // one route that answers without a credential.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const offer = await mintToken(server.url);

      const wrong = await claim(server.url, "definitely-not-the-token");
      expect(wrong.status).toBe(400);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);

      const right = await claim(server.url, offer.token);
      expect(right.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("never answers 401, whatever is wrong with the request", async () => {
    // A 401 on /api/* is what the dashboard's fetch wrapper reads as "ask for the
    // admin token". Answering a mistyped pairing code with 401 would open an
    // admin-credential dialog on the phone of someone who, by construction, does
    // not have one — a successful design presenting itself as a failed login.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const statuses: number[] = [];
      statuses.push((await claim(server.url, "wrong")).status);
      statuses.push((await claim(server.url, "")).status);
      statuses.push((await claim(server.url, 42)).status);
      statuses.push((await globalThis.fetch(new URL("/api/host/pair/claim", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      })).status);

      expect(statuses).not.toContain(401);
      for (const status of statuses) expect(status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("is rate limited, and says how long to wait", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      for (let i = 0; i < CLAIM_ATTEMPTS_PER_WINDOW; i++) {
        expect((await claim(server.url, `guess-${i}`)).status).toBe(400);
      }

      const limited = await claim(server.url, "one-too-many");
      expect(limited.status).toBe(429);
      // A client that backs off needs a number, not a sentence.
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("draining the budget while nobody is pairing does not refuse the scan that follows", async () => {
    // The attack this pins: the claim route answers without a credential, so
    // anything on the network can spend its allowance. When one global window
    // was shared by everyone, ten requests a minute — 0.17/s, a rate nothing
    // would flag — kept pairing refused indefinitely, and regenerating the code
    // did not help because the counter never belonged to the code.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      // An attacker empties the allowance before the user has done anything.
      for (let i = 0; i < CLAIM_ATTEMPTS_PER_WINDOW; i++) {
        expect((await claim(server.url, `flood-${i}`)).status).toBe(400);
      }
      expect((await claim(server.url, "over")).status).toBe(429);

      // The user now opens the pairing panel. Minting arms a fresh budget, so
      // the very next scan must go through rather than inheriting the refusal.
      const offer = await mintToken(server.url);
      const res = await claim(server.url, offer.token);
      expect(res.status).toBe(200);
      expect((await res.json() as { key?: string }).key).toBeTruthy();
    } finally {
      await server.stop(true);
    }
  });

  test("an oversized body is refused before it is parsed", async () => {
    // Bun's default ceiling is 128 MiB and this is the one route with no
    // credential in front of it, so without a bound of its own an anonymous
    // caller could make the process parse a hundred megabytes and then copy it
    // into a Buffer for a comparison that fails on length anyway.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await globalThis.fetch(new URL("/api/host/pair/claim", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "A".repeat(MAX_CLAIM_BODY_BYTES + 1) }),
      });
      expect(res.status).toBe(413);

      // A normal claim is nowhere near the ceiling — the bound must not be so
      // tight that it refuses real traffic.
      const offer = await mintToken(server.url);
      expect((await claim(server.url, offer.token)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("only POST is a claim handler — the path alone does not create another route", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await globalThis.fetch(new URL("/api/host/pair/claim", server.url), { method: "GET" });
      expect(res.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });
});

describe("minting and cancelling", () => {
  test("both are available on the intentionally open management plane", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const mint = await globalThis.fetch(new URL("/api/host/pair", server.url), { method: "POST" });
      expect(mint.status).toBe(200);
      const cancel = await globalThis.fetch(new URL("/api/host/pair", server.url), { method: "DELETE" });
      expect(cancel.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("a token is 256 bits with an expiry the UI can count down against", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const before = Date.now();
      const offer = await mintToken(server.url);
      // base64url of 32 bytes, unpadded — the shape the QR has to carry.
      expect(offer.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(offer.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_TTL_MS - 1_000);
      expect(offer.expiresAt).toBeLessThanOrEqual(Date.now() + PAIRING_TTL_MS);
    } finally {
      await server.stop(true);
    }
  });

  test("minting replaces the previous token rather than adding one", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const first = await mintToken(server.url);
      const second = await mintToken(server.url);
      expect(second.token).not.toBe(first.token);

      expect((await claim(server.url, first.token)).status).toBe(400);
      expect((await claim(server.url, second.token)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("cancelling makes the outstanding token unclaimable immediately", async () => {
    // The dashboard sends this when the pairing panel closes: a code that was
    // displayed and dismissed should stop working then, not five minutes later.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const offer = await mintToken(server.url);
      const cancel = await managementFetch(new URL("/api/host/pair", server.url), { method: "DELETE" });
      expect(cancel.status).toBe(200);

      const res = await claim(server.url, offer.token);
      expect(res.status).toBe(400);
      expect((await res.json() as { reason?: string }).reason).toBe("no-pairing");
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("neither the token nor the minted key is cacheable", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const mint = await managementFetch(new URL("/api/host/pair", server.url), { method: "POST" });
      expect(mint.headers.get("Cache-Control")).toBe("no-store");
      const offer = await mint.json() as { token: string };

      const claimed = await claim(server.url, offer.token);
      expect(claimed.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      await server.stop(true);
    }
  });
});

describe("one-click remote access", () => {
  test("mintKeyIfMissing generates the credential as part of enabling", async () => {
    // The whole point: enabling used to require inventing a password here and
    // typing it on the phone, so most people did not enable it.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true, mintKeyIfMissing: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { mintedKey?: string; exposed?: boolean; restartRequired?: boolean };
      expect(body.exposed).toBe(true);
      expect(body.mintedKey?.startsWith("ocx_")).toBe(true);
      // Never silently in effect: the socket is still bound where it was.
      expect(body.restartRequired).toBe(true);
      expect(loadConfig().apiKeys ?? []).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("enabling twice does not pile up keys nobody asked for", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const enable = () => managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true, mintKeyIfMissing: true }),
      });
      await enable();
      const second = await enable();
      // Already credentialed, so nothing new — and nothing claimed to be shown
      // once that the user then cannot find.
      expect((await second.json() as { mintedKey?: string | null }).mintedKey).toBeNull();
      expect(loadConfig().apiKeys ?? []).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test("without the opt-in, exposing with no credential is still refused", async () => {
    // The invariant the one-click path must not have weakened: a non-loopback
    // bind with no data-plane credential is a config that kills the next start.
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const res = await managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true }),
      });
      expect(res.status).toBe(409);
      expect(loadConfig().hostname).toBe("127.0.0.1");
    } finally {
      await server.stop(true);
    }
  });

  test("GET reports whether the live socket has caught up with the config", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const before = await managementFetch(new URL("/api/host", server.url)).then(r => r.json()) as { restartPending?: boolean };
      expect(before.restartPending).toBe(false);

      await managementFetch(new URL("/api/host", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed: true, mintKeyIfMissing: true }),
      });

      // The config now says 0.0.0.0; Bun.serve is still on 127.0.0.1 and only a
      // restart moves it. Reporting `exposed` alone would have the dashboard
      // claim a reachability the user cannot verify and a phone cannot use.
      const after = await managementFetch(new URL("/api/host", server.url)).then(r => r.json()) as {
        exposed?: boolean; restartPending?: boolean;
      };
      expect(after.exposed).toBe(true);
      expect(after.restartPending).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
