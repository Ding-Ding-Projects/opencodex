/**
 * The Locks page: the enumerable list of every toy lock, its search, its bulk
 * actions, and the embedded Support Tickets desk underneath it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import LocksPage from "../src/pages/Locks";
import { TestProviders } from "./helpers/providers";
import { buttonWithText, clickUntil, setInputValue } from "./helpers/dom-interact";
import { createLock, findLockById, isUnlocked, readLocks } from "../src/shell/locks";
import { readTickets } from "../src/shell/support-tickets";

// `CustomEvent` matters here specifically, and it did not in the other
// toy-lock test files: `locks.ts` and `support-tickets.ts` both notify their
// subscribers with `window.dispatchEvent(new CustomEvent(...))`, using
// whatever `CustomEvent` the *global* scope resolves to. Left as Bun's native
// class while `window` is happy-dom's own `Window`, happy-dom's
// `dispatchEvent` rejects the event as "not an instance of Event" — a
// cross-realm mismatch, not an app bug — and the surrounding `try/catch`
// (there to swallow a `localStorage` quota error) swallows that too, so the
// write still lands but no subscriber is ever told. `LocksPage` and
// `SupportTickets` read their lists into local state, so unnoticed here the
// symptom would have been a UI that never updates after its own actions.
// Overriding the global to `testWindow`'s own `CustomEvent` puts the
// dispatch back in the one realm it needs to be in.
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    CustomEvent: { configurable: true, value: testWindow.CustomEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // The page calls `scrollIntoView` when routing to Support Tickets; happy-dom
  // does not implement layout, so this is a no-op stand-in rather than a throw.
  Object.defineProperty(testWindow.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<TestProviders><LocksPage /></TestProviders>);
  });
  return { container, root };
}

const click = (el: Element, until?: () => boolean | Promise<boolean>) => clickUntil(testWindow, el, until);
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => setInputValue(testWindow, input, value);

function lastButtonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const matches = [...container.querySelectorAll("button")].filter(b => (b.textContent ?? "").trim() === text);
  if (!matches.length) throw new Error(`no button "${text}"`);
  return matches.at(-1) as HTMLButtonElement;
}

test("an empty locks list shows the empty state, not a bare list", async () => {
  const { container } = await mount();
  expect(container.textContent).toContain("No toy locks yet");
});

test("an existing lock renders with its kind, method and creation time", async () => {
  await createLock({
    kind: "element", targetId: "navRail", label: "Navigation rail",
    credential: { method: "password", password: "hunter2" }, duration: "close", lockedOnLaunch: true,
  });
  const { container } = await mount();
  const row = container.querySelector('[data-lock-row]')!;
  expect(row.textContent).toContain("Navigation rail");
  expect(row.textContent).toContain("Element");
  expect(row.textContent).toContain("Password");
});

test("a property-scoped lock renders with the combined \"target — property\" label", async () => {
  await createLock({
    kind: "element", targetId: "card", property: "color", label: "Cards",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount();
  expect(container.textContent).toContain("Cards — color");
});

test("search narrows the list to matching locks and reports no match honestly", async () => {
  await createLock({
    kind: "element", targetId: "a", label: "Alpha element",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  await createLock({
    kind: "tab", targetId: "b", label: "Beta tab",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount();
  const search = container.querySelector('input[aria-label="Search locks"]') as HTMLInputElement;

  await setValue(search, "Alpha");
  expect(container.textContent).toContain("Alpha element");
  expect(container.textContent).not.toContain("Beta tab");

  await setValue(search, "nothing matches this");
  expect(container.textContent).toContain("No lock matches that search.");
});

test("unlocking a locked row from its embedded UnlockPrompt actually unlocks that lock", async () => {
  const lock = await createLock({
    kind: "element", targetId: "u1", label: "U1",
    credential: { method: "password", password: "the-password" }, duration: "close", lockedOnLaunch: true,
  });
  const { container } = await mount();
  const row = container.querySelector('[data-lock-row]')!;
  const passwordField = row.querySelector('input[type="password"]') as HTMLInputElement;
  await setValue(passwordField, "the-password");
  await click(buttonWithText(row as HTMLElement, "Unlock"), () => isUnlocked(lock.id));
  expect(isUnlocked(lock.id)).toBe(true);
});

test("removing a single lock asks for confirmation and then actually removes it", async () => {
  await createLock({
    kind: "element", targetId: "r1", label: "Removable",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount();
  expect(readLocks().length).toBe(1);

  await click(buttonWithText(container, "Remove"));
  // The confirm dialog's own action button carries the same label — the last
  // "Remove" in the document at this point is the one inside the dialog.
  await click(lastButtonWithText(container, "Remove"), () => readLocks().length === 0);

  expect(readLocks().length).toBe(0);
  // Not just the storage layer: the row itself must actually disappear from
  // the rendered list, and the empty state must take its place — proving the
  // page's own subscription to lock changes actually re-renders it rather
  // than only agreeing with a storage read taken from outside React.
  //
  // Asserted by count, not `toBeNull()` on the query result: a `toBeNull()`
  // against a real DOM node prints the whole happy-dom tree as a failure
  // diff, which reads as a hang rather than a failure if this ever regresses.
  expect(container.querySelectorAll('[data-lock-row]').length).toBe(0);
  expect(container.textContent).toContain("No toy locks yet");
});

test("bulk-selecting and removing several locks removes exactly the selected ones", async () => {
  const a = await createLock({
    kind: "element", targetId: "ba", label: "BulkA",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  const b = await createLock({
    kind: "element", targetId: "bb", label: "BulkB",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  await createLock({
    kind: "element", targetId: "bc", label: "BulkC",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount();

  const checkbox = (label: string) => {
    const row = [...container.querySelectorAll('[data-lock-row]')].find(r => r.textContent?.includes(label))!;
    return row.querySelector('input[type="checkbox"]') as HTMLInputElement;
  };
  await click(checkbox("BulkA"));
  await click(checkbox("BulkB"));

  await click(buttonWithText(container, "Remove locks"));
  await click(lastButtonWithText(container, "Remove locks"), () => readLocks().length === 1);

  expect(findLockById(a.id)).toBeUndefined();
  expect(findLockById(b.id)).toBeUndefined();
  expect(readLocks().length).toBe(1);
  expect(readLocks()[0]!.label).toBe("BulkC");

  // And the rendered list itself, not only the two independent storage reads
  // above: exactly one row left, and it is the one that was not selected.
  const rows = [...container.querySelectorAll('[data-lock-row]')];
  expect(rows.length).toBe(1);
  expect(rows[0]!.textContent).toContain("BulkC");
});

test("the hand-written inventory of what this build can and cannot lock is on the page", async () => {
  const { container } = await mount();
  expect(container.textContent).toContain("What this build can lock");
  expect(container.textContent).toContain("Lock this element…");
});

test("Support Tickets is on the same page, and \"Forgotten your password?\" routes to it with the lock named", async () => {
  await createLock({
    kind: "element", targetId: "forgotten1", label: "Forgotten target",
    credential: { method: "password", password: "x" }, duration: "here", lockedOnLaunch: true,
  });
  const { container } = await mount();
  expect(container.textContent).toContain("Support Tickets");
  // Always-true disclosure, present even before any ticket is filed.
  expect(container.textContent).toContain("Nothing here is sent anywhere");

  await click(buttonWithText(container, "Forgotten your password?"));

  const description = container.querySelector('#support-tickets-title')!.closest("section")!
    .querySelector("textarea") as HTMLTextAreaElement;
  expect(description.value).toContain("Forgotten target");
});

test("filing a ticket in Support Tickets, advancing it to resolved, shows the no-desktop-bridge fallback (this test has no Electron bridge)", async () => {
  const { container } = await mount();
  const section = container.querySelector('#support-tickets-title')!.closest("section")!;
  const description = section.querySelector("textarea") as HTMLTextAreaElement;
  await setValue(description, "I forgot everything");
  await click(buttonWithText(container, "Submit ticket"));

  expect(readTickets().length).toBe(1);
  expect(section.textContent).toContain("Ticket #");
  expect(section.textContent).toContain("Open");

  await click(buttonWithText(container, "Check status"));
  expect(section.textContent).toContain("Under review");
  expect(section.textContent).toContain("Thank you for contacting support");

  await click(buttonWithText(container, "Check status"));
  expect(section.textContent).toContain("Resolved");
  expect(section.textContent).toContain("Resolution");
  // No `window.opencodexDesktop` bridge exists in this test, so the browser
  // fallback copy renders rather than an "Open the data folder" button.
  expect(section.textContent).toContain("no file manager to open here");
});
