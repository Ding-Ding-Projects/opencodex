/**
 * The "Lock this element…" wizard, end to end: both credential methods, the
 * TOTP arm-before-activate confirm step, and that the resulting `LockRecord`
 * actually carries a working credential.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { LockWizard } from "../src/shell/LockWizard";
import { TestProviders } from "./helpers/providers";
import { byLabel, buttonWithText, clickUntil, setInputValue } from "./helpers/dom-interact";
import {
  attemptUnlock, findLock, readLocks,
} from "../src/shell/locks";
import { base32Decode, totpCode } from "../src/shell/credential-vault";

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

/** Thin wrappers binding the shared DOM helpers to this file's `testWindow`. */
const click = (el: Element, until?: () => boolean | Promise<boolean>) => clickUntil(testWindow, el, until);
const setValue = (input: HTMLInputElement, value: string) => setInputValue(testWindow, input, value);
const label = (container: HTMLElement, text: string) => byLabel(testWindow, container, text);

test("creating a password lock walks all three steps and produces a working credential", async () => {
  const { container } = await mount(
    <LockWizard
      anchor={null}
      kind="element"
      targetId="navRail"
      targetLabel="Navigation rail"
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );

  // Step 1: method (password is the default), then Next.
  expect(container.textContent).toContain("Navigation rail");
  await click(buttonWithText(container, "Next"));

  // Step 2: credential.
  const password = label(container, "Password") as HTMLInputElement;
  const confirm = label(container, "Confirm password") as HTMLInputElement;
  await setValue(password, "correct horse battery");
  await setValue(confirm, "correct horse battery");
  expect(container.textContent).toContain("Looks good.");
  await click(buttonWithText(container, "Next"));

  // Step 3: duration & disclosure, then create.
  expect(container.textContent).toContain("This is just for fun");
  await click(buttonWithText(container, "Create lock"), () => findLock("element", "navRail") !== undefined);

  // The record now exists and its credential actually verifies.
  const record = findLock("element", "navRail");
  expect(record).toBeDefined();
  expect(record!.method).toBe("password");
  expect(await attemptUnlock(record!.id, { password: "correct horse battery" }, "here")).toBe("ok");
});

test("Next is disabled on the credential step until the passwords are valid and match", async () => {
  const { container } = await mount(
    <LockWizard anchor={null} kind="element" targetId="card" targetLabel="Cards" onClose={() => {}} onSaved={() => {}} />,
  );
  await click(buttonWithText(container, "Next"));
  const next = buttonWithText(container, "Next");
  expect(next.disabled).toBe(true);

  const password = label(container, "Password") as HTMLInputElement;
  const confirm = label(container, "Confirm password") as HTMLInputElement;
  await setValue(password, "short");
  await setValue(confirm, "short");
  // Too short (below the minimum) — still disabled.
  expect(buttonWithText(container, "Next").disabled).toBe(true);

  await setValue(password, "long enough password");
  await setValue(confirm, "not the same");
  expect(buttonWithText(container, "Next").disabled).toBe(true);

  await setValue(confirm, "long enough password");
  expect(buttonWithText(container, "Next").disabled).toBe(false);
});

test("a property-scoped lock is a different record from a whole-element lock on the same target", async () => {
  const { container } = await mount(
    <LockWizard
      anchor={null} kind="element" targetId="navRail" property="color" targetLabel="Navigation rail"
      onClose={() => {}} onSaved={() => {}}
    />,
  );
  expect(container.textContent).toContain("only the \"color\" property");
  await click(buttonWithText(container, "Next"));
  await setValue(label(container, "Password") as HTMLInputElement, "a password long enough");
  await setValue(label(container, "Confirm password") as HTMLInputElement, "a password long enough");
  await click(buttonWithText(container, "Next"));
  await click(buttonWithText(container, "Create lock"), () => findLock("element", "navRail", "color") !== undefined);

  expect(findLock("element", "navRail")).toBeUndefined();
  expect(findLock("element", "navRail", "color")).toBeDefined();
});

test("a TOTP lock requires confirming a real code before it can be created", async () => {
  const { container } = await mount(
    <LockWizard anchor={null} kind="element" targetId="otpTarget" targetLabel="OTP target" onClose={() => {}} onSaved={() => {}} />,
  );
  await click([...container.querySelectorAll("input[type=radio]")][1] as HTMLInputElement);
  await click(buttonWithText(container, "Next"));

  const secretField = label(container, "Secret (enter this into your authenticator app)") as HTMLInputElement;
  const secret = secretField.value;
  expect(secret.length).toBeGreaterThan(0);

  const codeField = label(container, "Current code") as HTMLInputElement;
  await setValue(codeField, "000000");
  await click(buttonWithText(container, "Confirm code"), () => (container.textContent ?? "").includes("did not match"));
  expect(container.textContent).toContain("did not match");
  expect(buttonWithText(container, "Next").disabled).toBe(true);

  const real = await totpCode(base32Decode(secret), Date.now(), 30, 6, "SHA-1");
  await setValue(codeField, real);
  await click(buttonWithText(container, "Confirm code"), () => (container.textContent ?? "").includes("Confirmed"));
  expect(container.textContent).toContain("Confirmed");
  expect(buttonWithText(container, "Next").disabled).toBe(false);

  await click(buttonWithText(container, "Next"));
  await click(buttonWithText(container, "Create lock"), () => findLock("element", "otpTarget") !== undefined);

  const record = findLock("element", "otpTarget")!;
  expect(record.method).toBe("totp");
  expect(await attemptUnlock(record.id, { code: real }, "here")).toBe("ok");
});

test("re-opening the wizard on an already-locked target offers \"Save credential\" and replaces the old credential", async () => {
  const { container } = await mount(
    <LockWizard anchor={null} kind="element" targetId="dup" targetLabel="Dup" onClose={() => {}} onSaved={() => {}} />,
  );
  await click(buttonWithText(container, "Next"));
  await setValue(label(container, "Password") as HTMLInputElement, "first password value");
  await setValue(label(container, "Confirm password") as HTMLInputElement, "first password value");
  await click(buttonWithText(container, "Next"));
  await click(buttonWithText(container, "Create lock"), () => findLock("element", "dup") !== undefined);
  const first = findLock("element", "dup")!;

  const { container: container2 } = await mount(
    <LockWizard anchor={null} kind="element" targetId="dup" targetLabel="Dup" onClose={() => {}} onSaved={() => {}} />,
  );
  await click(buttonWithText(container2, "Next"));
  await setValue(label(container2, "Password") as HTMLInputElement, "second password value");
  await setValue(label(container2, "Confirm password") as HTMLInputElement, "second password value");
  await click(buttonWithText(container2, "Next"));
  expect(() => buttonWithText(container2, "Create lock")).toThrow();
  // Poll on the raw vault entry actually changing rather than on
  // `attemptUnlock` — calling that as the poll predicate would itself record
  // wrong attempts against the *old* credential on every failed poll, right up
  // until rate limiting made the real assertions below unreachable.
  const vaultBefore = localStorage.getItem("ocx-m3:lock-vault");
  await click(buttonWithText(container2, "Save credential"), () => localStorage.getItem("ocx-m3:lock-vault") !== vaultBefore);

  expect(readLocks().length).toBe(1);
  const second = findLock("element", "dup")!;
  expect(second.id).toBe(first.id);
  expect(await attemptUnlock(second.id, { password: "first password value" }, "here")).toBe("wrong");
  expect(await attemptUnlock(second.id, { password: "second password value" }, "here")).toBe("ok");
});
