/**
 * The unlock gate a locked surface shows instead of teleporting past it —
 * wrong-credential feedback, rate limiting, "Lock again", and the
 * "Forgotten your password?" route to Support Tickets.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { UnlockPrompt } from "../src/shell/UnlockPrompt";
import { TestProviders } from "./helpers/providers";
import { buttonWithText, clickUntil, setInputValue } from "./helpers/dom-interact";
import { createLock, isUnlocked } from "../src/shell/locks";
import { randomBase32Secret, totpCode, base32Decode } from "../src/shell/credential-vault";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(node: ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<TestProviders>{node}</TestProviders>);
  });
  return { container, root };
}

const click = (el: Element, until?: () => boolean | Promise<boolean>) => clickUntil(testWindow, el, until);
const setValue = (input: HTMLInputElement, value: string) => setInputValue(testWindow, input, value);

function passwordField(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="password"]') as HTMLInputElement;
}
function codeField(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
}

test("a wrong password is rejected with an honest message, and never unlocks", async () => {
  const lock = await createLock({
    kind: "element", targetId: "t1", label: "T1",
    credential: { method: "password", password: "correct-password" },
    duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount(<UnlockPrompt lock={lock} />);

  await setValue(passwordField(container), "wrong");
  await click(buttonWithText(container, "Unlock"), () => (container.textContent ?? "").includes("did not match"));

  expect(container.textContent).toContain("did not match");
  expect(isUnlocked(lock.id)).toBe(false);
});

test("the correct password unlocks, shows the unlocked state, and Lock again relocks it", async () => {
  const lock = await createLock({
    kind: "element", targetId: "t2", label: "T2",
    credential: { method: "password", password: "correct-password" },
    duration: "close", lockedOnLaunch: true,
  });
  const { container } = await mount(<UnlockPrompt lock={lock} />);

  await setValue(passwordField(container), "correct-password");
  await click(buttonWithText(container, "Unlock"), () => isUnlocked(lock.id));

  expect(container.textContent).toContain("Unlocked");
  expect(isUnlocked(lock.id)).toBe(true);

  await click(buttonWithText(container, "Lock again"));
  expect(isUnlocked(lock.id)).toBe(false);
  expect(container.textContent).toContain("is locked");
});

test("a correct TOTP code unlocks", async () => {
  const secret = randomBase32Secret();
  const lock = await createLock({
    kind: "element", targetId: "t3", label: "T3",
    credential: { method: "totp", secret },
    duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount(<UnlockPrompt lock={lock} />);
  const code = await totpCode(base32Decode(secret), Date.now(), 30, 6, "SHA-1");

  await setValue(codeField(container), code);
  await click(buttonWithText(container, "Unlock"), () => isUnlocked(lock.id));

  expect(isUnlocked(lock.id)).toBe(true);
});

test("rate limiting kicks in after repeated wrong attempts and reports an honest wait", async () => {
  const lock = await createLock({
    kind: "element", targetId: "t4", label: "T4",
    credential: { method: "password", password: "correct-password" },
    duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount(<UnlockPrompt lock={lock} />);

  for (let i = 0; i < 3; i++) {
    await setValue(passwordField(container), `wrong-${i}`);
    await click(buttonWithText(container, "Unlock"), () => (container.textContent ?? "").includes("did not match"));
  }

  // The fourth attempt, even with the RIGHT password, is rate-limited.
  await setValue(passwordField(container), "correct-password");
  await click(buttonWithText(container, "Unlock"), () => (container.textContent ?? "").includes("Too many wrong tries"));

  expect(container.textContent).toContain("Too many wrong tries");
  expect(isUnlocked(lock.id)).toBe(false);
});

test("\"Forgotten your password?\" calls the caller's handler rather than doing nothing", async () => {
  const lock = await createLock({
    kind: "element", targetId: "t5", label: "T5",
    credential: { method: "password", password: "x" },
    duration: "here", lockedOnLaunch: true,
  });
  let forgotten = false;
  const { container } = await mount(<UnlockPrompt lock={lock} onForgotten={() => { forgotten = true; }} />);

  await click(buttonWithText(container, "Forgotten your password?"));
  expect(forgotten).toBe(true);
});

test("the disclosure line is present every time the prompt is locked — it is not a security boundary", async () => {
  const lock = await createLock({
    kind: "element", targetId: "t6", label: "T6",
    credential: { method: "password", password: "x" },
    duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount(<UnlockPrompt lock={lock} />);
  expect(container.textContent).toContain("not a security boundary");
});
