/**
 * The Secret & display-name history manager's own password/TOTP gate
 * (`HISTORY_LOCK_ID` in `SecretHistoryDialog.tsx`) is not a new credential
 * system — it is the same `locks.ts`/`credential-vault.ts` machinery every
 * other toy lock in this app already uses.
 *
 * The one thing genuinely specific to this feature is which id the
 * credential actually lives under: `createLock` writes it keyed by the
 * LockRecord's OWN generated `.id`, not by the `(kind, targetId)` pair used
 * to find that record. `HISTORY_LOCK_ID` is only ever a `targetId` — code
 * that calls `attemptUnlock`/`credentialMethod` with the constant itself
 * (instead of `findLock("element", HISTORY_LOCK_ID)!.id`) silently misses
 * the stored credential and reports every password as wrong. This exact bug
 * was caught by the first version of this test file, which asserted against
 * `HISTORY_LOCK_ID` directly and failed — see `SecretHistoryDialog.tsx`'s
 * `Reverify` component doc comment for the fix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  attemptUnlock, isUnlocked, findLock, relock, createLock,
} from "../src/shell/locks";
import { hasCredential, verifyCredential } from "../src/shell/credential-vault";
import { HISTORY_LOCK_ID } from "../src/components/authenticator/SecretHistoryDialog";

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

describe("HISTORY_LOCK_ID — the history manager's own credential", () => {
  test("no LockRecord exists for it before setup", () => {
    expect(findLock("element", HISTORY_LOCK_ID)).toBeUndefined();
  });

  test("createLock keys the credential by the record's own generated id, never by HISTORY_LOCK_ID itself", async () => {
    await createLock({
      kind: "element", targetId: HISTORY_LOCK_ID, label: "Secret & display-name history",
      credential: { method: "password", password: "correct horse battery staple" },
      duration: "here", lockedOnLaunch: true,
    });
    const record = findLock("element", HISTORY_LOCK_ID);
    expect(record).toBeTruthy();
    expect(record!.id).not.toBe(HISTORY_LOCK_ID); // the very distinction this file exists to enforce
    expect(hasCredential(record!.id)).toBe(true);
    expect(hasCredential(HISTORY_LOCK_ID)).toBe(false); // nothing is ever stored under the constant itself
  });

  test("a correct password unlocks (via the record's real id); a wrong one does not, and reports 'wrong' rather than throwing", async () => {
    const record = await createLock({
      kind: "element", targetId: HISTORY_LOCK_ID, label: "Secret & display-name history",
      credential: { method: "password", password: "correct horse battery staple" },
      duration: "here", lockedOnLaunch: true,
    });

    const wrong = await attemptUnlock(record.id, { password: "not it" }, "here");
    expect(wrong).toBe("wrong");
    expect(isUnlocked(record.id)).toBe(false);

    const right = await attemptUnlock(record.id, { password: "correct horse battery staple" }, "here");
    expect(right).toBe("ok");
    expect(isUnlocked(record.id)).toBe(true);

    // Verified independently through credential-vault.ts too, not just via locks.ts's wrapper.
    expect(await verifyCredential(record.id, { password: "not it" })).toBe(false);
    expect(await verifyCredential(record.id, { password: "correct horse battery staple" })).toBe(true);
  });

  test("relocking clears the session, and a subsequent reverify needs the password again", async () => {
    const record = await createLock({
      kind: "element", targetId: HISTORY_LOCK_ID, label: "Secret & display-name history",
      credential: { method: "password", password: "sesame" },
      duration: "close", lockedOnLaunch: true,
    });
    await attemptUnlock(record.id, { password: "sesame" }, "close");
    expect(isUnlocked(record.id)).toBe(true);
    relock(record.id);
    expect(isUnlocked(record.id)).toBe(false);
  });

  test("a credential set here never verifies against, or is confused with, an unrelated lock", async () => {
    const history = await createLock({
      kind: "element", targetId: HISTORY_LOCK_ID, label: "Secret & display-name history",
      credential: { method: "password", password: "history-only-password" },
      duration: "here", lockedOnLaunch: true,
    });
    const other = await createLock({
      kind: "element", targetId: "some-other-toy-lock", label: "Unrelated element",
      credential: { method: "password", password: "unrelated-password" },
      duration: "here", lockedOnLaunch: true,
    });

    expect(await verifyCredential(history.id, { password: "unrelated-password" })).toBe(false);
    expect(await verifyCredential(other.id, { password: "history-only-password" })).toBe(false);
    expect(await verifyCredential(history.id, { password: "history-only-password" })).toBe(true);
  });
});
