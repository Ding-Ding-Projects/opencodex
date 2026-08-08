/**
 * QR pairing.
 *
 * The claim endpoint is unauthenticated by necessity — a phone that has never
 * paired has nothing to present — so every property that makes it safe lives in
 * the token, and every one of them is a case below. If any single one regresses,
 * an unauthenticated endpoint starts handing out working credentials.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  PAIRED_KEY_NAME,
  PAIRING_TTL_MS,
  cancelPairing,
  claimPairingToken,
  createPairingToken,
  peekPairing,
  resetPairingForTests,
} from "../src/lib/pairing";
import type { OcxConfig } from "../src/types";

function emptyConfig(): OcxConfig {
  return { port: 10100, providers: {} } as unknown as OcxConfig;
}

beforeEach(() => resetPairingForTests());

describe("what a pairing token is worth", () => {
  test("a correct claim yields a data-plane key and nothing more", () => {
    const config = emptyConfig();
    const offer = createPairingToken();

    const result = claimPairingToken(offer.token, config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A key the phone can use the proxy with — never an admin token, which
    // would let a paired phone reconfigure the host it just joined.
    expect(result.key.startsWith("ocx_")).toBe(true);
    expect(config.apiKeys).toHaveLength(1);
    expect(config.apiKeys?.[0].name).toBe(PAIRED_KEY_NAME);
  });

  test("the token is single use", () => {
    // This is the property that makes showing a QR on a screen acceptable: by
    // the time anyone else photographs it, the intended phone has spent it.
    const config = emptyConfig();
    const offer = createPairingToken();

    expect(claimPairingToken(offer.token, config).ok).toBe(true);
    const second = claimPairingToken(offer.token, config);

    expect(second.ok).toBe(false);
    expect(config.apiKeys).toHaveLength(1);
  });

  test("it expires", () => {
    // A QR left on a monitor after a meeting is not a standing invitation.
    const config = emptyConfig();
    let clock = 1_000_000;
    const offer = createPairingToken(() => clock);

    clock += PAIRING_TTL_MS + 1;
    const result = claimPairingToken(offer.token, config, () => clock);

    expect(result.ok).toBe(false);
    expect(config.apiKeys ?? []).toHaveLength(0);
  });

  test("an expired claim says so, rather than reporting no pairing at all", () => {
    // These are different situations with different fixes — "your code aged
    // out, mint another" versus "nobody has started pairing here". Sending
    // someone whose code merely expired off to open a pairing panel that is
    // already open is the kind of advice that reads as the feature being broken.
    const config = emptyConfig();
    let clock = 1_000_000;
    const offer = createPairingToken(() => clock);

    clock += PAIRING_TTL_MS + 1;

    expect(claimPairingToken(offer.token, config, () => clock))
      .toEqual({ ok: false, reason: "expired" });
  });

  test("it is still claimable a moment before expiry", () => {
    // The boundary in the other direction: an off-by-one here would make
    // pairing fail intermittently near the end of the window, which reads as
    // "the QR sometimes does not work" rather than as an expiry bug.
    const config = emptyConfig();
    let clock = 1_000_000;
    const offer = createPairingToken(() => clock);

    clock += PAIRING_TTL_MS - 1;

    expect(claimPairingToken(offer.token, config, () => clock).ok).toBe(true);
  });
});

describe("what a wrong claim cannot do", () => {
  test("a wrong token does not consume the outstanding one", () => {
    // Otherwise anyone who can reach the endpoint cancels a legitimate pairing
    // by guessing once — a denial of service that needs no secret at all.
    const config = emptyConfig();
    const offer = createPairingToken();

    expect(claimPairingToken("not-the-token", config).ok).toBe(false);
    expect(claimPairingToken(offer.token, config).ok).toBe(true);
  });

  test("a wrong token mints nothing", () => {
    const config = emptyConfig();
    createPairingToken();

    claimPairingToken("wrong", config);
    claimPairingToken("", config);
    claimPairingToken("x".repeat(43), config);

    expect(config.apiKeys ?? []).toHaveLength(0);
  });

  test("claiming with no pairing outstanding is refused, not an error", () => {
    const config = emptyConfig();
    const result = claimPairingToken("anything", config);
    expect(result).toEqual({ ok: false, reason: "no-pairing" });
  });
});

describe("only one secret is ever live", () => {
  test("minting replaces the previous token", () => {
    // A user who opens the pairing panel three times should leave one live
    // secret behind, not three.
    const config = emptyConfig();
    const first = createPairingToken();
    const second = createPairingToken();

    expect(claimPairingToken(first.token, config).ok).toBe(false);
    expect(claimPairingToken(second.token, config).ok).toBe(true);
  });

  test("cancelling forgets it", () => {
    const config = emptyConfig();
    const offer = createPairingToken();
    cancelPairing();
    expect(claimPairingToken(offer.token, config).ok).toBe(false);
  });

  test("peek never reports an expired offer", () => {
    let clock = 0;
    createPairingToken(() => clock);
    expect(peekPairing(() => clock)).not.toBeNull();
    clock += PAIRING_TTL_MS;
    expect(peekPairing(() => clock)).toBeNull();
  });
});

describe("the token itself", () => {
  test("is 256 bits of randomness, and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(createPairingToken().token);
    expect(seen.size).toBe(200);
    // base64url of 32 bytes, unpadded.
    for (const token of seen) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
