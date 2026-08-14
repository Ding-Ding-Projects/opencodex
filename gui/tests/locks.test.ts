/**
 * The lock records themselves — creation, independence between locks, session
 * duration semantics, rate limiting, and history recording that never leaks a
 * credential.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  applyLockedOnLaunch, attemptUnlock, createLock, findLock, findLockById, isUnlocked,
  lockHasCredential, rateLimitState, readLocks, relock, removeLock, removeLocks,
  updateLockSettings,
} from "../src/shell/locks";
import { hasCredential } from "../src/shell/credential-vault";
import { readRevisions } from "../src/shell/revisions";
import { randomBase32Secret, totpCode, base32Decode } from "../src/shell/credential-vault";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

describe("creating a lock", () => {
  test("stores the record and a credential together", async () => {
    const record = await createLock({
      kind: "element", targetId: "navRail", label: "Navigation rail",
      credential: { method: "password", password: "hunter2" },
      duration: "close", lockedOnLaunch: true,
    });
    expect(record.method).toBe("password");
    expect(findLockById(record.id)).toEqual(record);
    expect(lockHasCredential(record.id)).toBe(true);
  });

  test("a property-scoped lock and a whole-element lock on the same target are different locks", async () => {
    const whole = await createLock({
      kind: "element", targetId: "navRail", label: "Navigation rail",
      credential: { method: "password", password: "a" }, duration: "close", lockedOnLaunch: true,
    });
    const property = await createLock({
      kind: "element", targetId: "navRail", property: "color", label: "Navigation rail — Color",
      credential: { method: "password", password: "b" }, duration: "close", lockedOnLaunch: true,
    });
    expect(whole.id).not.toBe(property.id);
    expect(findLock("element", "navRail")).toEqual(whole);
    expect(findLock("element", "navRail", "color")).toEqual(property);
    expect(readLocks().length).toBe(2);
  });

  test("creating again on the same (kind, targetId, property) replaces the credential rather than adding a second lock", async () => {
    const first = await createLock({
      kind: "element", targetId: "card", label: "Cards",
      credential: { method: "password", password: "old" }, duration: "close", lockedOnLaunch: true,
    });
    const second = await createLock({
      kind: "element", targetId: "card", label: "Cards",
      credential: { method: "password", password: "new" }, duration: "close", lockedOnLaunch: true,
    });
    expect(second.id).toBe(first.id);
    expect(readLocks().length).toBe(1);
    expect(await attemptUnlock(first.id, { password: "old" }, "here")).toBe("wrong");
    expect(await attemptUnlock(first.id, { password: "new" }, "here")).toBe("ok");
  });
});

describe("independent credentials", () => {
  test("two locks never share a credential, even with identical passwords typed for both", async () => {
    const a = await createLock({
      kind: "element", targetId: "a", label: "A",
      credential: { method: "password", password: "same" }, duration: "here", lockedOnLaunch: true,
    });
    const b = await createLock({
      kind: "element", targetId: "b", label: "B",
      credential: { method: "password", password: "same" }, duration: "here", lockedOnLaunch: true,
    });
    // Unlocking A does not unlock B.
    expect(await attemptUnlock(a.id, { password: "same" }, "here")).toBe("ok");
    expect(isUnlocked(a.id)).toBe(true);
    expect(isUnlocked(b.id)).toBe(false);
  });

  test("a group lock does not unlock its members", async () => {
    // Modelled here as two independent locks under different targetIds, which
    // is exactly the point: there is no relationship the code understands
    // between a "group" lock and a "tab" lock beyond what the caller chooses
    // to create — nothing cascades.
    const group = await createLock({
      kind: "group", targetId: "grp1", label: "Group: Work",
      credential: { method: "password", password: "grp" }, duration: "here", lockedOnLaunch: true,
    });
    const tab = await createLock({
      kind: "tab", targetId: "tab1", label: "Tab: Providers",
      credential: { method: "password", password: "tab" }, duration: "here", lockedOnLaunch: true,
    });
    expect(await attemptUnlock(group.id, { password: "grp" }, "here")).toBe("ok");
    expect(isUnlocked(tab.id)).toBe(false);
  });

  test("removing one lock leaves a sibling untouched", async () => {
    const a = await createLock({
      kind: "element", targetId: "a", label: "A",
      credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
    });
    const b = await createLock({
      kind: "element", targetId: "b", label: "B",
      credential: { method: "password", password: "y" }, duration: "here", lockedOnLaunch: true,
    });
    removeLock(a.id);
    expect(findLockById(a.id)).toBeUndefined();
    expect(hasCredential(a.id)).toBe(false);
    expect(findLockById(b.id)).toEqual(b);
    expect(hasCredential(b.id)).toBe(true);
  });
});

describe("duration semantics", () => {
  test("\"here\" is never unlocked for another lock and does not persist across a fresh session read", async () => {
    const record = await createLock({
      kind: "element", targetId: "x", label: "X",
      credential: { method: "password", password: "p" }, duration: "here", lockedOnLaunch: true,
    });
    expect(await attemptUnlock(record.id, { password: "p" }, "here")).toBe("ok");
    expect(isUnlocked(record.id)).toBe(true);
    // "here" never touches sessionStorage at all.
    expect(sessionStorage.getItem("ocx-m3:lock-sessions")).toBeNull();
  });

  test("a numeric-minute unlock expires and reports locked again afterwards", async () => {
    const record = await createLock({
      kind: "element", targetId: "y", label: "Y",
      credential: { method: "password", password: "p" }, duration: 1, lockedOnLaunch: true,
    });
    const t0 = Date.now();
    expect(await attemptUnlock(record.id, { password: "p" }, 1, t0)).toBe("ok");
    // isUnlocked reads Date.now() internally for the numeric-expiry branch;
    // fake it forward by writing an already-expired session directly rather
    // than sleeping the test.
    const raw = JSON.parse(sessionStorage.getItem("ocx-m3:lock-sessions")!);
    raw[record.id].expiresAt = t0 - 1;
    sessionStorage.setItem("ocx-m3:lock-sessions", JSON.stringify(raw));
    expect(isUnlocked(record.id)).toBe(false);
  });

  test("\"close\" has no expiry and stays unlocked until relock() or applyLockedOnLaunch()", async () => {
    const record = await createLock({
      kind: "element", targetId: "z", label: "Z",
      credential: { method: "password", password: "p" }, duration: "close", lockedOnLaunch: true,
    });
    expect(await attemptUnlock(record.id, { password: "p" }, "close")).toBe("ok");
    expect(isUnlocked(record.id)).toBe(true);
    relock(record.id);
    expect(isUnlocked(record.id)).toBe(false);
  });

  test("applyLockedOnLaunch drops a surviving session unlock for a lock configured to lock on launch, and leaves one that opted out", async () => {
    const locksOnLaunch = await createLock({
      kind: "element", targetId: "p1", label: "P1",
      credential: { method: "password", password: "a" }, duration: "close", lockedOnLaunch: true,
    });
    const staysOpen = await createLock({
      kind: "element", targetId: "p2", label: "P2",
      credential: { method: "password", password: "b" }, duration: "close", lockedOnLaunch: false,
    });
    await attemptUnlock(locksOnLaunch.id, { password: "a" }, "close");
    await attemptUnlock(staysOpen.id, { password: "b" }, "close");
    expect(isUnlocked(locksOnLaunch.id)).toBe(true);
    expect(isUnlocked(staysOpen.id)).toBe(true);

    applyLockedOnLaunch();

    expect(isUnlocked(locksOnLaunch.id)).toBe(false);
    expect(isUnlocked(staysOpen.id)).toBe(true);
  });
});

describe("TOTP end to end through attemptUnlock", () => {
  test("a correct code unlocks, a wrong one does not", async () => {
    const secret = randomBase32Secret();
    const record = await createLock({
      kind: "element", targetId: "otp", label: "OTP element",
      credential: { method: "totp", secret }, duration: "here", lockedOnLaunch: true,
    });
    const now = Date.now();
    const code = await totpCode(base32Decode(secret), now, 30, 6, "SHA-1");
    expect(await attemptUnlock(record.id, { code: "000000" }, "here", now)).toBe("wrong");
    expect(await attemptUnlock(record.id, { code }, "here", now)).toBe("ok");
  });
});

describe("rate limiting", () => {
  test("the first three wrong attempts are free, the fourth is rate-limited", async () => {
    const record = await createLock({
      kind: "element", targetId: "rl", label: "RL",
      credential: { method: "password", password: "correct" }, duration: "here", lockedOnLaunch: true,
    });
    const t0 = 1_000_000;
    expect(await attemptUnlock(record.id, { password: "no" }, "here", t0)).toBe("wrong");
    expect(await attemptUnlock(record.id, { password: "no" }, "here", t0 + 1)).toBe("wrong");
    expect(await attemptUnlock(record.id, { password: "no" }, "here", t0 + 2)).toBe("wrong");
    // Fourth attempt: rate-limited even though the password this time is correct.
    expect(await attemptUnlock(record.id, { password: "correct" }, "here", t0 + 3)).toBe("rate-limited");
    expect(rateLimitState(record.id, t0 + 3).limited).toBe(true);
    // After the backoff window, the correct password succeeds.
    const state = rateLimitState(record.id, t0 + 3);
    expect(await attemptUnlock(record.id, { password: "correct" }, "here", t0 + 3 + state.waitMs)).toBe("ok");
  });

  test("a successful unlock clears the wrong-attempt count", async () => {
    const record = await createLock({
      kind: "element", targetId: "rl2", label: "RL2",
      credential: { method: "password", password: "correct" }, duration: "here", lockedOnLaunch: true,
    });
    await attemptUnlock(record.id, { password: "no" }, "here");
    await attemptUnlock(record.id, { password: "correct" }, "here");
    relock(record.id);
    // Two more wrong attempts after a successful unlock — still within the
    // free allowance, proving the earlier wrong attempt was forgotten.
    expect(await attemptUnlock(record.id, { password: "no" }, "here")).toBe("wrong");
    expect(await attemptUnlock(record.id, { password: "no" }, "here")).toBe("wrong");
    expect(rateLimitState(record.id).limited).toBe(false);
  });
});

describe("bulk removal", () => {
  test("removes every id that exists and reports only those", async () => {
    const a = await createLock({
      kind: "element", targetId: "ba", label: "BA",
      credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
    });
    const b = await createLock({
      kind: "element", targetId: "bb", label: "BB",
      credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
    });
    const removed = removeLocks([a.id, "does-not-exist", b.id]);
    expect(removed.sort()).toEqual([a.id, b.id].sort());
    expect(readLocks().length).toBe(0);
  });
});

describe("settings updates", () => {
  test("updateLockSettings changes duration/lockedOnLaunch without touching the credential", async () => {
    const record = await createLock({
      kind: "element", targetId: "s1", label: "S1",
      credential: { method: "password", password: "p" }, duration: "here", lockedOnLaunch: true,
    });
    updateLockSettings(record.id, { duration: 15, lockedOnLaunch: false });
    const updated = findLockById(record.id)!;
    expect(updated.duration).toBe(15);
    expect(updated.lockedOnLaunch).toBe(false);
    expect(await attemptUnlock(record.id, { password: "p" }, "here")).toBe("ok");
  });
});

describe("history recording never leaks a credential", () => {
  test("created, changed and removed each record a revision, none containing the password", async () => {
    const record = await createLock({
      kind: "element", targetId: "hist", label: "History element",
      credential: { method: "password", password: "top-secret-value" }, duration: "here", lockedOnLaunch: true,
    });
    await createLock({
      kind: "element", targetId: "hist", label: "History element",
      credential: { method: "password", password: "second-top-secret" }, duration: "here", lockedOnLaunch: true,
    });
    updateLockSettings(record.id, { duration: 30 });
    removeLock(record.id);

    const revisions = readRevisions();
    const serialized = JSON.stringify(revisions);
    expect(serialized.includes("top-secret-value")).toBe(false);
    expect(serialized.includes("second-top-secret")).toBe(false);
    expect(revisions.filter(r => r.label === "History element").length).toBeGreaterThanOrEqual(4);
  });
});
