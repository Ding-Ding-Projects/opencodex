/**
 * B3 security port #2 (upstream 2186e98cb + fc5889e0a + 355b69e5b): OAuth token-expiry
 * math must reject a non-finite (`NaN`/`Infinity`) or negative `expires_in`, and must
 * guard the *computed* expiry timestamp too — `Number.MAX_VALUE` passes
 * `Number.isFinite(expires_in)` but overflows to `Infinity` once multiplied by 1000.
 *
 * Before the fix, `Date.now() + expires_in * 1000` in each of these four modules could
 * produce `NaN` or `Infinity`. Any subsequent expiry comparison (`Date.now() > expires`)
 * is `false` against both — the credential would never be treated as expired and refresh
 * would never fire, or (for a negative `expires_in`) the opposite: an already-past expiry
 * stamped on a token that just arrived, tripping refresh on every request.
 *
 * Every module's own hardened fallback is 3600 real seconds — asserted here as "greater
 * than now" and, where the module's own skew constant is known, within a tolerance band
 * of the exact fallback window, so a test can't pass merely by accident of an unrelated
 * huge value.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { refreshAnthropicToken } from "../src/oauth/anthropic";
import { refreshChatGPTToken } from "../src/oauth/chatgpt";
import { refreshKimiToken } from "../src/oauth/kimi";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// JSON.stringify turns both NaN and Infinity into null, so the malformed-response shape
// that actually reaches JSON.parse as Infinity has to be hand-written: an out-of-range
// numeric literal like 1e999 parses to Infinity, not a JSON error.
const INFINITY_EXPIRES_IN_BODY = (extra: string) => `{"access_token":"at","refresh_token":"rt","expires_in":1e999${extra}}`;
// Number.MAX_VALUE is a perfectly finite, in-range number — it passes Number.isFinite on
// its own — but overflows to Infinity the moment it's multiplied by 1000.
const OVERFLOW_EXPIRES_IN = 1.7976931348623157e308;
const FALLBACK_SECONDS = 3600;
const TOLERANCE_MS = 30_000;

describe("Anthropic OAuth refresh: expires_in guard", () => {
  const SKEW_MS = 5 * 60 * 1000;
  const fallbackMs = FALLBACK_SECONDS * 1000 - SKEW_MS;

  test("a non-finite (Infinity) expires_in falls back to the 3600s window, not NaN", async () => {
    globalThis.fetch = (async () => new Response(INFINITY_EXPIRES_IN_BODY(""), { status: 200 })) as typeof fetch;
    const before = Date.now();
    const cred = await refreshAnthropicToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("an overflowing expires_in (finite input, Infinity once computed) falls back to the 3600s window", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: OVERFLOW_EXPIRES_IN }),
      { status: 200 },
    )) as typeof fetch;
    const before = Date.now();
    const cred = await refreshAnthropicToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("a negative expires_in (already-past expiry) falls back to the 3600s window", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: -1 }),
      { status: 200 },
    )) as typeof fetch;
    const before = Date.now();
    const cred = await refreshAnthropicToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });
});

describe("ChatGPT OAuth refresh: expires_in guard", () => {
  const fallbackMs = FALLBACK_SECONDS * 1000;

  test("a non-finite (Infinity) expires_in falls back to the 3600s window, not NaN", async () => {
    globalThis.fetch = (async () => new Response(INFINITY_EXPIRES_IN_BODY(""), { status: 200 })) as typeof fetch;
    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("a string expires_in falls back to the 3600s window (?? alone would not catch this)", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: "garbage" }),
      { status: 200 },
    )) as typeof fetch;
    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("an overflowing expires_in falls back to the 3600s window", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: OVERFLOW_EXPIRES_IN }),
      { status: 200 },
    )) as typeof fetch;
    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("a negative expires_in falls back to the 3600s window", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: -1 }),
      { status: 200 },
    )) as typeof fetch;
    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });
});

describe("Kimi OAuth refresh: expires_in guard (reject, not silently accept)", () => {
  // Kimi's device-flow refresh has no fallback-window semantics upstream (or here): a
  // malformed expires_in is rejected outright as a malformed token response, rather than
  // silently substituted with a default. Confirm the fork's typeof-only check is exactly
  // the gap the survey named — `typeof NaN === "number"`, so a bare typeof check lets a
  // non-finite value straight through to `Date.now() + NaN * 1000`.
  test("an Infinity expires_in is rejected as malformed, not silently accepted", async () => {
    globalThis.fetch = (async () => new Response(INFINITY_EXPIRES_IN_BODY(''), { status: 200 })) as typeof fetch;
    await expect(refreshKimiToken("old-refresh")).rejects.toThrow("missing required fields");
  });

  test("an overflowing (finite input, Infinity once computed) expires_in is rejected as malformed", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: OVERFLOW_EXPIRES_IN }),
      { status: 200 },
    )) as typeof fetch;
    await expect(refreshKimiToken("old-refresh")).rejects.toThrow("missing required fields");
  });

  test("a negative expires_in (already-past expiry) is rejected as malformed", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: -1 }),
      { status: 200 },
    )) as typeof fetch;
    await expect(refreshKimiToken("old-refresh")).rejects.toThrow("missing required fields");
  });
});

describe("Codex account-store refresh: expires_in guard", () => {
  const fallbackMs = FALLBACK_SECONDS * 1000;

  async function refreshWithBody(id: string, body: string) {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential(id, { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const before = Date.now();
    await getValidCodexToken(id);
    const stored = getCodexAccountCredential(id)!;
    return { stored, before };
  }

  test("a non-finite (Infinity) expires_in falls back to the 3600s window, not NaN", async () => {
    const { stored, before } = await refreshWithBody(
      "b3-expiry-infinity",
      INFINITY_EXPIRES_IN_BODY('').replace('"rt"', '"new-r"').replace('"at"', '"new"'),
    );
    expect(Number.isFinite(stored.expiresAt)).toBe(true);
    expect(stored.expiresAt).toBeGreaterThan(before);
    expect(Math.abs(stored.expiresAt - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("an overflowing expires_in falls back to the 3600s window", async () => {
    const { stored, before } = await refreshWithBody(
      "b3-expiry-overflow",
      JSON.stringify({ access_token: "new", refresh_token: "new-r", expires_in: OVERFLOW_EXPIRES_IN }),
    );
    expect(Number.isFinite(stored.expiresAt)).toBe(true);
    expect(Math.abs(stored.expiresAt - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });

  test("a negative expires_in falls back to the 3600s window", async () => {
    const { stored, before } = await refreshWithBody(
      "b3-expiry-negative",
      JSON.stringify({ access_token: "new", refresh_token: "new-r", expires_in: -1 }),
    );
    expect(Number.isFinite(stored.expiresAt)).toBe(true);
    expect(stored.expiresAt).toBeGreaterThan(before);
    expect(Math.abs(stored.expiresAt - (before + fallbackMs))).toBeLessThan(TOLERANCE_MS);
  });
});
