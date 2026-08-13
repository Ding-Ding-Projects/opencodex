/**
 * "Show emojis in dialogs and message boxes."
 *
 * The contract this setting owes is drawn in three places at once, and each one
 * is a distinct way to get it wrong: the toggle must be a real, reachable,
 * persisted control (not a setting that changes nothing — the inert-control
 * defect this project explicitly forbids); the words a dialog or a snackbar
 * shows must never move when the mark is added or removed, only the decoration
 * around them; and the mark itself must never reach a button, an action label,
 * or anything counted toward an accessible name — a screen reader must not
 * announce "warning sign, Exit OpenCodex" just because the sighted reader sees
 * one.
 *
 * `message-emoji.tsx`'s `decorateMessage` draws that last line by nesting the
 * glyph in its own `aria-hidden="true"` span *inside* the labelled element,
 * which real browsers exclude from that element's accessible-name computation
 * (the same mechanism `<IconRefresh aria-hidden="true" /> {t(...)}` already
 * relies on for a button's own name in `Settings.tsx`). happy-dom does not
 * compute a live accessibility tree, so these tests check the DOM shape that
 * makes that exclusion correct instead: everything outside the `aria-hidden`
 * node equals the original, undecorated text.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { TestLanguageProvider } from "./helpers/providers";
import { ConfirmProvider } from "../src/shell/confirm";
import { useConfirm, usePrompt, type ConfirmRequest } from "../src/shell/confirm-context";
import { NotificationsProvider } from "../src/shell/notifications";
import { useNotifications } from "../src/shell/notifications-context";
import SnackbarHost from "../src/shell/SnackbarHost";
import LanguageVoice from "../src/pages/LanguageVoice";
import { PREFS_KEY, readPrefs } from "../src/theme/prefs-context";
import { useSettingsDrafts } from "../src/settings-drafts-context";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // happy-dom does not implement the top-layer methods the native <dialog> uses.
  const proto = testWindow.HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (proto) {
    proto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    proto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(node: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  return { container, root };
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click(); });
}

/** The text a screen reader would compute for `el`'s name, once `aria-hidden`
 * descendants are excluded — which is the DOM-level stand-in happy-dom's lack
 * of a real accessibility tree calls for. */
function visibleText(el: Element): string {
  return [...el.childNodes]
    .filter(node => !(node.nodeType === 1 && (node as Element).getAttribute("aria-hidden") === "true"))
    .map(node => node.textContent ?? "")
    .join("")
    .trim();
}

/* ------------------------------------------------------- confirm / prompt -- */

function Opener({ answers, request }: { answers: (boolean | "pending")[]; request: ConfirmRequest }) {
  const confirm = useConfirm();
  return (
    <button type="button" onClick={() => {
      const slot = answers.push("pending") - 1;
      void confirm(request).then(answer => { answers[slot] = answer; });
    }}>
      Open
    </button>
  );
}

function TextOpener({ answers }: { answers: (string | null | "pending")[] }) {
  const prompt = usePrompt();
  return (
    <button type="button" onClick={() => {
      const slot = answers.push("pending") - 1;
      void prompt({ title: "Set a display name", label: "Display name", confirmLabel: "Save" })
        .then(answer => { answers[slot] = answer; });
    }}>
      Open prompt
    </button>
  );
}

function dialogOf(container: HTMLElement): HTMLDialogElement | null {
  return container.querySelector("dialog");
}

function buttonLabelled(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("dialog button")].find(node => node.textContent === text);
  if (!match) throw new Error(`no dialog button labelled ${text}`);
  return match as HTMLButtonElement;
}

function mountConfirmProvider(children: React.ReactNode, showEmojis: boolean) {
  // `readPrefs()` runs inside `SettingsDraftProvider`'s initial `useState`, so
  // the profile has to be on disk before the tree is ever rendered.
  if (showEmojis) testWindow.localStorage.setItem(PREFS_KEY, JSON.stringify({ showEmojis: true }));
  return mount(<TestLanguageProvider><ConfirmProvider>{children}</ConfirmProvider></TestLanguageProvider>);
}

test("off by default: an unmodified profile shows the confirm title with no decoration at all", async () => {
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountConfirmProvider(
    <Opener answers={answers} request={{ title: "Exit OpenCodex", confirmLabel: "Exit", tone: "danger" }} />,
    false,
  );
  await click(container.querySelector("button")!);

  const titleId = dialogOf(container)!.getAttribute("aria-labelledby")!;
  const titleEl = container.ownerDocument.getElementById(titleId)!;
  expect(titleEl.textContent).toBe("Exit OpenCodex");
  expect(titleEl.querySelector('[aria-hidden="true"]')).toBeNull();

  await act(async () => { root.unmount(); });
});

test("a destructive confirmation marks its headline, and the mark never reaches the button or the name", async () => {
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountConfirmProvider(
    <Opener answers={answers} request={{ title: "Exit OpenCodex", confirmLabel: "Exit", tone: "danger" }} />,
    true,
  );
  await click(container.querySelector("button")!);

  const titleId = dialogOf(container)!.getAttribute("aria-labelledby")!;
  const titleEl = container.ownerDocument.getElementById(titleId)!;

  const mark = titleEl.querySelector('[aria-hidden="true"]');
  expect(mark).not.toBeNull();
  expect(mark!.textContent).toBe("⚠️");
  // Once the hidden node is excluded, what remains is exactly the original,
  // undecorated title — never "⚠️ Exit OpenCodex" with the glyph baked in as
  // plain text a screen reader would read aloud.
  expect(visibleText(titleEl)).toBe("Exit OpenCodex");

  // Buttons carry no mark, ever — confirmLabel/cancelLabel are untouched.
  const exit = buttonLabelled(container, "Exit");
  const cancel = buttonLabelled(container, "Cancel");
  expect(exit.textContent).toBe("Exit");
  expect(cancel.textContent).toBe("Cancel");
  expect(exit.querySelector(".m3-emoji")).toBeNull();
  expect(cancel.querySelector(".m3-emoji")).toBeNull();

  await click(exit);
  expect(answers).toEqual([true]);
  await act(async () => { root.unmount(); });
});

test("a non-destructive confirmation earns a different mark from a destructive one", async () => {
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountConfirmProvider(
    <Opener answers={answers} request={{ title: "Restore this snapshot", confirmLabel: "Restore" }} />,
    true,
  );
  await click(container.querySelector("button")!);

  const titleId = dialogOf(container)!.getAttribute("aria-labelledby")!;
  const titleEl = container.ownerDocument.getElementById(titleId)!;
  expect(titleEl.querySelector('[aria-hidden="true"]')!.textContent).toBe("❓");
  expect(visibleText(titleEl)).toBe("Restore this snapshot");

  await act(async () => { root.unmount(); });
});

test("a prompt dialog gets its own mark, and the field's label is untouched", async () => {
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountConfirmProvider(<TextOpener answers={answers} />, true);
  await click(container.querySelector("button")!);

  const titleId = dialogOf(container)!.getAttribute("aria-labelledby")!;
  const titleEl = container.ownerDocument.getElementById(titleId)!;
  expect(titleEl.querySelector('[aria-hidden="true"]')!.textContent).toBe("✏️");
  expect(visibleText(titleEl)).toBe("Set a display name");

  // The field's own label — a genuinely separate accessible name from the
  // dialog's — carries nothing either.
  const input = container.querySelector("dialog input") as HTMLInputElement;
  const label = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
  expect(label.textContent).toBe("Display name");

  await act(async () => { root.unmount(); });
});

/* ---------------------------------------------------------------- snackbar -- */

function NotifyHarness() {
  const { notify } = useNotifications();
  return (
    <div>
      <button type="button" aria-label="info" onClick={() => notify({ tone: "info", title: "Proxy port changed" })} />
      <button type="button" aria-label="success" onClick={() => notify({ tone: "success", title: "Export finished" })} />
      <button type="button" aria-label="warn" onClick={() => notify({ tone: "warn", title: "Storage nearing its limit" })} />
      <button type="button" aria-label="error" onClick={() => notify({ tone: "error", title: "Could not reach the proxy" })} />
      <SnackbarHost />
    </div>
  );
}

function mountSnackbars(showEmojis: boolean) {
  if (showEmojis) testWindow.localStorage.setItem(PREFS_KEY, JSON.stringify({ showEmojis: true }));
  return mount(<TestLanguageProvider><NotificationsProvider><NotifyHarness /></NotificationsProvider></TestLanguageProvider>);
}

function fire(container: HTMLElement, label: string): Promise<void> {
  return click(container.querySelector(`button[aria-label='${label}']`) as HTMLButtonElement);
}

test("off by default: a snackbar shows its title with no decoration", async () => {
  const { container, root } = await mountSnackbars(false);
  await fire(container, "success");

  const title = container.querySelector(".m3-snack-title")!;
  expect(title.textContent).toBe("Export finished");
  expect(title.querySelector(".m3-emoji")).toBeNull();

  await act(async () => { root.unmount(); });
});

test("each notification tone earns its own mark, and the dismiss button stays plain", async () => {
  const { container, root } = await mountSnackbars(true);
  await fire(container, "info");
  await fire(container, "success");
  await fire(container, "warn");
  await fire(container, "error");

  const titles = [...container.querySelectorAll(".m3-snack-title")];
  expect(titles).toHaveLength(4);
  const marks = titles.map(t => t.querySelector('[aria-hidden="true"]')?.textContent);
  expect(marks).toEqual(["ℹ️", "✅", "⚠️", "❌"]);
  // Four distinct marks, matching the four distinct tones — never the same
  // glyph doing duty for two different kinds of message.
  expect(new Set(marks).size).toBe(4);

  const texts = titles.map(t => visibleText(t));
  expect(texts).toEqual([
    "Proxy port changed",
    "Export finished",
    "Storage nearing its limit",
    "Could not reach the proxy",
  ]);

  // The dismiss control beside each snack carries an accessible name of its
  // own and no decoration at all.
  const dismiss = container.querySelector(".m3-snack-close") as HTMLButtonElement;
  expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
  expect(dismiss.querySelector(".m3-emoji")).toBeNull();

  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------ the toggle -- */

function SaveHarness() {
  const { prefs, setPrefs, apply } = useSettingsDrafts();
  return (
    <div>
      <button type="button" aria-label="flip" onClick={() => setPrefs({ showEmojis: !prefs.showEmojis })} />
      <button type="button" aria-label="save" onClick={() => { void apply(); }} />
      <span data-value>{String(prefs.showEmojis)}</span>
    </div>
  );
}

test("the toggle stages as a draft, applies on save, and survives a fresh read of storage", async () => {
  const { container, root } = await mount(<TestLanguageProvider><SaveHarness /></TestLanguageProvider>);

  // Nothing written until Save — this is the same draft/apply contract every
  // other appearance setting in `settings-drafts.tsx` follows.
  expect(testWindow.localStorage.getItem(PREFS_KEY)).toBeNull();

  await click(container.querySelector("button[aria-label='flip']")!);
  expect(container.querySelector("[data-value]")?.textContent).toBe("true");
  expect(testWindow.localStorage.getItem(PREFS_KEY)).toBeNull();

  await click(container.querySelector("button[aria-label='save']")!);
  const stored = JSON.parse(testWindow.localStorage.getItem(PREFS_KEY) ?? "{}");
  expect(stored.showEmojis).toBe(true);

  // `readPrefs()` is exactly what a fresh page load calls — this is the
  // "survives a reload" half of the contract, without needing to actually
  // unmount and remount the whole application.
  expect(readPrefs().showEmojis).toBe(true);

  await act(async () => { root.unmount(); });
});

/* --------------------------------------------------------- Language & voice -- */

function mountLanguageVoice(): Promise<{ container: HTMLElement; root: Root }> {
  return mount(
    <TestLanguageProvider>
      <NotificationsProvider>
        <LanguageVoice />
      </NotificationsProvider>
    </TestLanguageProvider>,
  );
}

function findCard(container: HTMLElement, title: string): HTMLElement {
  const card = [...container.querySelectorAll(".m3-card")]
    .find(node => node.querySelector(".m3-card-title")?.textContent === title);
  if (!card) throw new Error(`no card titled ${title}`);
  return card as HTMLElement;
}

test("the card is reachable from Language & voice, and flipping it changes what renders without changing the words", async () => {
  const { container, root } = await mountLanguageVoice();

  const card = findCard(container, "Show emojis in dialogs and message boxes");
  const toggle = card.querySelector('[role="switch"]') as HTMLButtonElement;
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute("aria-label")).toBe("Show emojis in dialogs and message boxes");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(card.querySelector(".m3-emoji")).toBeNull();

  const wordsBefore = visibleText(card).replace(/\s+/g, " ").trim();
  expect(wordsBefore).toContain("Proxy port changed");

  await click(toggle);

  expect(toggle.getAttribute("aria-checked")).toBe("true");
  // A mark now renders — the setting actually changed what is on screen.
  expect(card.querySelectorAll(".m3-emoji").length).toBeGreaterThan(0);
  // ...and the sample sentences read exactly as they did before: voice/marks
  // change, the facts do not.
  const wordsAfter = visibleText(card).replace(/\s+/g, " ").trim();
  expect(wordsAfter).toContain("Proxy port changed");
  expect(wordsAfter).toContain("Export finished");
  expect(wordsAfter).toContain("Storage nearing its limit");
  expect(wordsAfter).toContain("Could not reach the proxy");

  await act(async () => { root.unmount(); });
});

test("the control stays reachable, labelled and operable at a narrow, phone-class width", async () => {
  // happy-dom has no real layout engine, so this cannot assert pixel-level
  // clipping the way a real browser capture would — but the app's own compact
  // regime (`windowClass(width) === "compact"` below 600px, from `theme/m3.ts`)
  // is driven by `window.innerWidth`, and this is the DOM-level guarantee a
  // unit test *can* make: at a phone width, the switch is still present, still
  // carries its full accessible name, and still responds to activation.
  testWindow.innerWidth = 375;
  const { container, root } = await mountLanguageVoice();

  const card = findCard(container, "Show emojis in dialogs and message boxes");
  const toggle = card.querySelector('[role="switch"]') as HTMLButtonElement;
  expect(toggle.getAttribute("aria-label")).toBe("Show emojis in dialogs and message boxes");

  await click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  await act(async () => { root.unmount(); });
});
