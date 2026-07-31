/**
 * First-run onboarding wizard.
 *
 * The failure these guard is the one that makes a wizard worse than no wizard:
 * showing up on a profile that has already been used, or on every launch. Every
 * case below is therefore about *when* it appears as much as what it renders —
 * an upgrading user, a proxy that will not answer, and an install that already
 * has a credential all have to end with nothing on screen.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import OnboardingWizard from "../src/shell/OnboardingWizard";
import { resetLaunchLatch } from "../src/shell/onboarding-state";
import { LanguageProvider } from "../src/i18n/provider";
import { NotificationsProvider } from "../src/shell/notifications";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let previousFetch: typeof fetch;
let testWindow: Window;
let fetchCalls: string[];

/** Replaces `/api/providers` with a canned answer; `null` makes the call fail. */
function stubProviders(rows: unknown[] | null): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    if (rows === null) throw new Error("proxy unreachable");
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  previousFetch = globalThis.fetch;
  fetchCalls = [];
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Each case is its own launch.
  resetLaunchLatch();
});

afterEach(() => {
  testWindow.close();
  globalThis.fetch = previousFetch;
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
    root.render(
      <LanguageProvider>
        <NotificationsProvider>
          <OnboardingWizard apiBase="" />
        </NotificationsProvider>
      </LanguageProvider>,
    );
  });
  // The decision is asynchronous: the dialog only appears once the provider
  // probe has answered.
  await act(async () => { await Promise.resolve(); });

  return { container, root };
}

function dialogOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

function buttonWith(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
  });
}

test("opens on a fresh profile with nothing connected, as a labelled modal", async () => {
  stubProviders([]);
  const { container, root } = await mount();

  const dialog = dialogOf(container);
  expect(dialog).toBeTruthy();
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  const titleId = dialog?.getAttribute("aria-labelledby");
  expect(container.querySelector(`#${titleId}`)?.textContent).toBe("Welcome to opencodex");
  // The step counter is announced rather than left as decoration.
  const counter = [...container.querySelectorAll("span")].find(s => s.textContent === "Step 1 of 4");
  expect(counter?.getAttribute("aria-live")).toBe("polite");
  // Focus is moved into the dialog, not left behind it.
  expect(document.activeElement).toBe(dialog as unknown as Element);

  await act(async () => { root.unmount(); });
});

// An upgrading user must never meet this wizard. An existing preferences blob is
// proof the dashboard has been used, and it is checked before anything is fetched.
test("stays shut for a profile that already has preferences, without probing", async () => {
  localStorage.setItem("ocx-m3:v1", JSON.stringify({ theme: "dark" }));
  stubProviders([]);
  const { container, root } = await mount();

  expect(dialogOf(container)).toBeNull();
  expect(fetchCalls).toEqual([]);

  await act(async () => { root.unmount(); });
});

// "Never gate the app": an unreachable proxy closes the wizard rather than
// trapping the user behind a half-loaded one.
test("stays shut when the provider probe fails", async () => {
  stubProviders(null);
  const { container, root } = await mount();

  expect(fetchCalls).toEqual(["/api/providers"]);
  expect(dialogOf(container)).toBeNull();

  await act(async () => { root.unmount(); });
});

test("stays shut when a provider is already configured, and remembers it", async () => {
  stubProviders([{ name: "openai", hasApiKey: true }]);
  const { container, root } = await mount();

  expect(dialogOf(container)).toBeNull();
  expect(JSON.parse(localStorage.getItem("ocx-m3:onboarding") ?? "{}").completed).toBe(true);

  await act(async () => { root.unmount(); });
});

// A listed provider with no credential is not a configured one — that is exactly
// the state the wizard exists for.
test("opens when providers are listed but none carries a credential", async () => {
  stubProviders([{ name: "openai", hasApiKey: false }]);
  const { container, root } = await mount();

  expect(dialogOf(container)).toBeTruthy();

  await act(async () => { root.unmount(); });
});

test("walks all four steps and finishing records the flag", async () => {
  stubProviders([]);
  const { container, root } = await mount();

  const stepText = () => [...container.querySelectorAll("span")].find(s => s.textContent?.startsWith("Step "))?.textContent;
  const heading = () => container.querySelector("#ocx-onboard-step-title")?.textContent;

  expect(heading()).toContain("Pick a language");
  await click(buttonWith(container, "Next")!);
  expect(stepText()).toBe("Step 2 of 4");
  expect(heading()).toContain("Connect a provider");

  // "I'll do this later" is not a dead end: it advances rather than closing.
  await click(buttonWith(container, "I'll do this later")!);
  expect(stepText()).toBe("Step 3 of 4");
  expect(heading()).toContain("Reach it from other devices");

  await click(buttonWith(container, "Next")!);
  expect(stepText()).toBe("Step 4 of 4");
  expect(heading()).toContain("You're set");

  await click(buttonWith(container, "Back")!);
  expect(stepText()).toBe("Step 3 of 4");
  await click(buttonWith(container, "Next")!);

  await click(buttonWith(container, "Finish")!);
  expect(dialogOf(container)).toBeNull();
  expect(JSON.parse(localStorage.getItem("ocx-m3:onboarding") ?? "{}").completed).toBe(true);

  await act(async () => { root.unmount(); });
});

// Escape counts as a skip: closed, remembered, and focus handed back.
test("Escape closes it as a skip and returns focus where it came from", async () => {
  stubProviders([]);
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  expect(document.activeElement).toBe(opener as unknown as Element);

  const { container, root } = await mount();
  const dialog = dialogOf(container)!;
  expect(dialog).toBeTruthy();

  await act(async () => {
    dialog.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });

  expect(dialogOf(container)).toBeNull();
  expect(JSON.parse(localStorage.getItem("ocx-m3:onboarding") ?? "{}").completed).toBe(true);
  expect(document.activeElement).toBe(opener as unknown as Element);

  await act(async () => { root.unmount(); });
});

// Turning "Don't show this again" off is the one way to be shown it again; a
// deferred run is stored as an explicit not-completed rather than as nothing.
test("skipping with don't-show-again turned off defers instead of completing", async () => {
  stubProviders([]);
  const { container, root } = await mount();

  const dontShow = container.querySelector('[role="switch"]') as unknown as HTMLButtonElement;
  expect(dontShow.getAttribute("aria-checked")).toBe("true");
  await click(dontShow);
  expect(dontShow.getAttribute("aria-checked")).toBe("false");

  await click(buttonWith(container, "Skip setup")!);
  expect(dialogOf(container)).toBeNull();
  expect(JSON.parse(localStorage.getItem("ocx-m3:onboarding") ?? "{}").completed).toBe(false);

  await act(async () => { root.unmount(); });
});

// The language step writes the app-wide locale, not a wizard-local key, and the
// change lands in the append-only revision log.
test("picking a language sets the shared locale and records a revision", async () => {
  stubProviders([]);
  const { container, root } = await mount();

  const chip = [...container.querySelectorAll(".m3-chip")].find(c => c.textContent === "日本語")!;
  await click(chip);

  expect(localStorage.getItem("ocx-lang")).toBe("ja");
  expect(chip.getAttribute("aria-pressed")).toBe("true");

  const revisions = JSON.parse(localStorage.getItem("ocx-m3:revisions") ?? "[]");
  expect(revisions).toHaveLength(1);
  expect(revisions[0].scope).toBe("settings");
  expect(revisions[0].summary).toContain("日本語");

  // Re-picking the same language is not a mutation, so it records nothing more.
  await click(chip);
  expect(JSON.parse(localStorage.getItem("ocx-m3:revisions") ?? "[]")).toHaveLength(1);

  await act(async () => { root.unmount(); });
});

// Focus is trapped while the dialog is open: Tab off the last control wraps to
// the first instead of landing on the page behind.
test("traps Tab and Shift+Tab inside the dialog", async () => {
  stubProviders([]);
  const { container, root } = await mount();

  const dialog = dialogOf(container)!;
  const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
  expect(focusable.length).toBeGreaterThan(2);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  await act(async () => {
    last.focus();
    dialog.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true }) as never);
  });
  expect(document.activeElement).toBe(first as unknown as Element);

  await act(async () => {
    first.focus();
    dialog.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }) as never);
  });
  expect(document.activeElement).toBe(last as unknown as Element);

  await act(async () => { root.unmount(); });
});

// The provider step hands off to the real Providers screen through the same
// deep link the nav writes, and leaves the wizard behind rather than parking
// the user on a dead end.
test("the provider step links to #providers and closes on the way", async () => {
  stubProviders([]);
  const { container, root } = await mount();

  await click(buttonWith(container, "Next")!);
  const link = container.querySelector('a[href="#providers"]') as unknown as HTMLAnchorElement;
  expect(link).toBeTruthy();
  expect(link.textContent).toContain("Providers");

  await click(link);
  expect(dialogOf(container)).toBeNull();
  expect(JSON.parse(localStorage.getItem("ocx-m3:onboarding") ?? "{}").completed).toBe(true);

  await act(async () => { root.unmount(); });
});

// Once closed, it is closed for this launch — a remount of the shell must not
// bring it back.
test("does not reopen after being closed in the same launch", async () => {
  stubProviders([]);
  const first = await mount();
  await click(buttonWith(first.container, "Skip setup")!);
  await act(async () => { first.root.unmount(); });

  const second = await mount();
  expect(dialogOf(second.container)).toBeNull();

  await act(async () => { second.root.unmount(); });
});
