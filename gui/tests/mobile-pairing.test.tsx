/**
 * What the phone does with a pairing token, and what it keeps afterwards.
 *
 * Two properties here are deliberate reversals of rules the rest of the GUI
 * follows, so neither can be left to read as an accident:
 *
 * 1. **The token leaves the URL before anything else happens.** A URL is the
 *    part that gets screenshotted, shared and restored by the browser on next
 *    launch. A live credential must not survive in it.
 * 2. **The key IS written to localStorage**, which `gui/src/api.ts` forbids for
 *    the admin token in as many words. Pairing mints a data-plane key, not a
 *    management one, and re-scanning a QR on every visit is what made this
 *    screen unused. If a refactor ever "restores consistency" with api.ts, the
 *    reload case below fails and says why.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import Mobile from "../src/pages/Mobile";
import { LanguageProvider } from "../src/i18n/provider";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";
import { ConfirmProvider } from "../src/shell/confirm";
import { resetApiAuthFetchForTests } from "../src/api";
import { isClaimApplied, readPairedKey, resetMobilePairingForTests } from "../src/lib/mobile-pairing";
import { normalizeHashPath } from "../src/hash-routing";


const STORED_KEY = "opencodex-mobile-key";
const TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAIRED = "ocx_pairedkeyvalue";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage", "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let claimBodies: unknown[] = [];
let claimStatus = 200;
let chatStatus = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Stands in for the proxy. Only the pairing claim is scripted in detail; the
 * management reads answer 401 exactly as a real published proxy does to a phone
 * holding a data-plane key, which is the condition the screen has to survive.
 */
function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/host/pair/claim")) {
    claimBodies.push(JSON.parse(String(init?.body ?? "{}")));
    if (claimStatus === 200) return Promise.resolve(json({ key: PAIRED }));
    if (claimStatus === 429) return Promise.resolve(json({ error: "too many pairing attempts" }, 429));
    return Promise.resolve(json({ error: "no", reason: "expired" }, 400));
  }
  if (url.includes("/v1/models")) return Promise.resolve(json({ data: [{ id: "gpt-5.4" }] }));
  if (url.includes("/v1/chat/completions")) {
    if (chatStatus === 401) return Promise.resolve(json({ error: "opencodex API key required" }, 401));
    return Promise.resolve(new Response("data: [DONE]\n\n", { status: 200 }));
  }
  // Management routes: a paired phone does not hold the admin token.
  return Promise.resolve(json({ error: "opencodex admin token required" }, 401));
}

function boot(hash: string): void {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: `http://192.168.1.50:10100/${hash}` });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    fetch: { configurable: true, value: serve },
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: serve });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

function teardown(): void {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
}

beforeEach(() => {
  claimBodies = [];
  claimStatus = 200;
  chatStatus = 200;
  resetApiAuthFetchForTests();
  // Page-load state, so a fresh case is a fresh page load.
  resetMobilePairingForTests();
});

afterEach(() => {
  resetApiAuthFetchForTests();
  resetMobilePairingForTests();
});

/**
 * Flush until `text` is on screen, or give up after a bounded number of turns.
 *
 * Bounded so a genuine regression still fails rather than hanging: the assertion
 * that follows is what reports it, and it reports the real rendered text.
 */
/**
 * One turn of the event loop, timers included.
 *
 * `await Promise.resolve()` drains microtasks and nothing else, and this screen
 * does not run on microtasks: the model list is fetched from inside
 * `setTimeout(…, haveModels ? 400 : 0)`, so every wait built on microtasks was
 * waiting for something that could not happen. It appeared to work only because
 * a busy event loop occasionally serviced a timer between two unrelated awaits
 * — which is why adding any test file anywhere could flip this suite.
 *
 * Yielding through a real timer makes that deterministic instead of incidental.
 */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms));
  });
}

async function waitForText(container: HTMLElement, text: string, turns = 100): Promise<void> {
  for (let i = 0; i < turns && !container.textContent?.includes(text); i++) {
    await tick();
  }
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <LanguageProvider>
          <NotificationsProvider>
            <ConfirmProvider>
              <Mobile apiBase="" />
            </ConfirmProvider>
          </NotificationsProvider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });
  // Wait for the screen to be genuinely usable, on the event loop it actually
  // runs on.
  //
  // Four earlier versions of this wait were wrong, and all four shared one
  // mistake: they flushed MICROTASKS and this screen does not run on microtasks.
  // The model list is fetched from inside `setTimeout(…, haveModels ? 400 : 0)`,
  // and the Send button is `disabled={!draft.trim() || !model}` — so until that
  // timer runs there is no model, the button is inert, and submitting the form
  // does nothing at all. The captured failure was exactly that: still on the
  // Chat panel, draft intact, no error anywhere, because no send had happened.
  //
  // It passed most of the time only because a busy event loop sometimes serviced
  // the timer between two unrelated awaits. That is why adding a test file
  // anywhere in the suite could flip it, and why "wait for the claim", "wait for
  // storage" and "wait for an authenticated /v1/models refetch" each looked like
  // a fix for a while. The last of those never once observed its own signal —
  // measured across full-suite runs, the counter was 0 nearly every time — so it
  // was a 200-iteration delay wearing an event wait's clothes.
  //
  // So: yield through real timers, and wait for the two things the test needs to
  // be true — the pairing claim has resolved, and the screen has a model.
  for (let i = 0; i < 100 && !readPairedKey() && !isClaimApplied(); i++) await tick();
  // A claim that succeeded stores the key in the same synchronous step that
  // latches it; a refusal never stores one, so this cannot spin on that path.
  if (isClaimApplied()) {
    for (let i = 0; i < 100 && !readPairedKey(); i++) await tick();
  }
  // The model list is what un-disables Send. Without it the form submit in these
  // tests is a no-op, which is a far more confusing failure than a timeout here.
  for (let i = 0; i < 100 && !container.querySelector("select option"); i++) await tick();
  await tick();
  return { container, root };
}

function openControlPanel(container: HTMLElement): void {
  const buttons = [...container.querySelectorAll("button")];
  const control = buttons.find(b => b.textContent?.trim() === "Control");
  control?.click();
}

test("claims the token from the hash and removes it from the URL", async () => {
  boot("#/mobile?pair=" + TOKEN);
  try {
    const { root } = await mount();

    // Spent exactly once, with the token from the hash and nothing else.
    expect(claimBodies).toEqual([{ token: TOKEN }]);

    // The parameter is gone. This is the property a screenshot or a shared link
    // depends on. The route part survives — normalized to the app's own `#mobile`
    // form, which `readPageFromHash` and the QR's `#/mobile` both resolve to —
    // so the page the code was scanned to open is still the page on screen.
    expect(normalizeHashPath(window.location.hash)).toBe("mobile");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.href).not.toContain("pair=");

    // The key it received is kept, so the next visit does not scan again.
    expect(localStorage.getItem(STORED_KEY)).toBe(PAIRED);

    await act(async () => { root.unmount(); });
  } finally {
    teardown();
  }
});

test("the stored key survives a reload, with no token in the URL to re-claim", async () => {
  boot("#/mobile?pair=" + TOKEN);
  let root1: Root;
  try {
    ({ root: root1 } = await mount());
    expect(localStorage.getItem(STORED_KEY)).toBe(PAIRED);
    await act(async () => { root1.unmount(); });
  } finally {
    teardown();
  }

  // A genuinely new page load: fresh window, fresh module state, plain `#/mobile`
  // exactly as the browser would restore it after the token was stripped.
  const survivingStorage = new Map<string, string>([[STORED_KEY, PAIRED]]);
  boot("#/mobile");
  try {
    for (const [k, v] of survivingStorage) localStorage.setItem(k, v);
    claimBodies = [];
    // The seam is what makes this a second page load rather than a second
    // render: it drops the in-memory key and the spent-token latch, leaving
    // storage as the only thing carrying the pairing across.
    resetMobilePairingForTests();

    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PrefsProvider><LanguageProvider><NotificationsProvider><ConfirmProvider>
          <Mobile apiBase="" />
        </ConfirmProvider></NotificationsProvider></LanguageProvider></PrefsProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });

    // Nothing to claim, and nothing claimed — the key came straight from storage.
    expect(claimBodies).toEqual([]);
    openControlPanel(container);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Paired");
    expect(container.textContent).not.toContain("Not paired");

    await act(async () => { root.unmount(); });
  } finally {
    teardown();
  }
});

test("\"forget this device\" clears the stored key", async () => {
  boot("#/mobile?pair=" + TOKEN);
  try {
    const { container, root } = await mount();
    expect(localStorage.getItem(STORED_KEY)).toBe(PAIRED);

    openControlPanel(container);
    await act(async () => { await Promise.resolve(); });

    const forget = [...container.querySelectorAll("button")]
      .find(b => b.textContent?.includes("Forget this device"));
    expect(forget).toBeTruthy();
    await act(async () => { forget!.click(); });

    // Forgetting is a decision, so it goes through the shared confirm dialog
    // rather than deleting a credential on a single tap.
    const confirmButton = [...document.querySelectorAll("dialog button")]
      .find(b => b.textContent?.includes("Forget this device"));
    expect(confirmButton).toBeTruthy();
    await act(async () => { (confirmButton as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });

    expect(localStorage.getItem(STORED_KEY)).toBeNull();
    expect(container.textContent).toContain("Not paired");

    await act(async () => { root.unmount(); });
  } finally {
    teardown();
  }
});

test("a refused claim keeps nothing and explains which failure it was", async () => {
  claimStatus = 400;
  boot("#/mobile?pair=" + TOKEN);
  try {
    const { container, root } = await mount();

    expect(localStorage.getItem(STORED_KEY)).toBeNull();
    openControlPanel(container);
    await act(async () => { await Promise.resolve(); });
    // The reason drives the advice: an expired code means mint another, which is
    // a different instruction from "nobody is offering one".
    expect(container.textContent).toContain("already expired");

    await act(async () => { root.unmount(); });
  } finally {
    teardown();
  }
});

test("a rejected key asks to pair again rather than failing silently", async () => {
  chatStatus = 401;
  boot("#/mobile?pair=" + TOKEN);
  try {
    const { container, root } = await mount();
    expect(localStorage.getItem(STORED_KEY)).toBe(PAIRED);

    const textarea = container.querySelector("textarea")!;
    const proto = Object.getPrototypeOf(textarea) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(textarea, "hello");
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
    await act(async () => { await Promise.resolve(); });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }) as never);
    });

    // Wait for the message, rather than for a fixed number of microtask turns
    // and a hope.
    //
    // This was two turns. The send awaits a fetch, reads the 401, switches to
    // the Control panel and renders — more hops than two on any run, and exactly
    // two on the runs where it happened to work. It failed the moment anything
    // else in the module graph shifted the timing: adding an unrelated import to
    // `Logs.tsx`, or a block of keys to either locale file, each flipped it on
    // its own, which is the signature of a race rather than a bug in any of them.
    await waitForText(container, "scan a new pairing code");

    // A stale key is expected, not exotic — keys get revoked on the desktop and
    // wiped by a state restore. The screen has to name the fix.
    expect(container.textContent).toContain("scan a new pairing code");

    await act(async () => { root.unmount(); });
  } finally {
    teardown();
  }
});
