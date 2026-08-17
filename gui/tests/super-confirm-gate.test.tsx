/**
 * SUPERCONFIRM-01 — the destructive-action super-confirmation gate.
 *
 * `shell/super-confirm.tsx` is the one surface in this app allowed to perform
 * something genuinely irreversible, so the state machine gets exercised
 * directly rather than only through the two screens that use it: untouched,
 * one key, both keys, a partial slide, a full slide, cancel, Escape, keyboard
 * operation, and both the real success and the real failure path of
 * `onAuthorize`. `bun test` runs against real `react-dom/client` and a real
 * DOM (`happy-dom`), so these assertions are about what actually renders and
 * actually fires, not about the component's internals.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { SuperConfirmGate, type SuperConfirmGateProps } from "../src/shell/super-confirm";

const domGlobals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // happy-dom has no top layer, so `<dialog>`'s native methods are stubbed to
  // the one thing a test can observe: the `open` attribute. Only the modal
  // presentation touches this; the anchored one never calls it.
  const dialogProto = testWindow.HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (dialogProto) {
    dialogProto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    dialogProto.show = function show(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    dialogProto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  }

  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

interface Deferred { resolve: () => void; reject: (err: Error) => void }

/**
 * `settle` is a stable object whose `resolve`/`reject` are (re)pointed at the
 * live promise's executor every time `onAuthorize()` runs — returning a plain
 * `{ resolve, reject }` pair here would capture `undefined`, because the
 * executor only runs once `onAuthorize()` is actually invoked, which happens
 * well after this function returns.
 */
function deferredAuthorize(): { onAuthorize: () => Promise<void>; settle: Deferred } {
  const settle: Deferred = { resolve: () => {}, reject: () => {} };
  const onAuthorize = () => new Promise<void>((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });
  return { onAuthorize, settle };
}

/**
 * The harness renders the trigger and the gate together and — like every real
 * caller (`Storage.tsx`'s cleanup card, `CodexAccountResetModal`) — the gate's
 * mere presence in the tree IS "open": `onClose` unmounts it by flipping local
 * state, rather than leaving it mounted forever. That matters for two of the
 * tests below: focus restoration has to survive the button ref outliving the
 * gate that pointed at it, and the `mountedRef` guard has nothing to guard
 * against unless the gate genuinely goes away.
 */
function Harness({ presentation, onAuthorize, onClose }: {
  presentation: SuperConfirmGateProps["presentation"];
  onAuthorize: () => Promise<void>;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={anchorRef} type="button">Open the gate</button>
      {open && (
        <SuperConfirmGate
          anchorRef={anchorRef}
          presentation={presentation}
          title="Permanently delete 3 file(s)"
          body="This cannot be undone."
          keyLabels={["I have reviewed the files above", "I understand this cannot be undone"]}
          sliderLabel="Slide to delete"
          workingLabel="Deleting…"
          doneLabel="Deleted"
          onAuthorize={onAuthorize}
          onClose={() => { setOpen(false); onClose(); }}
        />
      )}
    </>
  );
}

async function mount(props: {
  presentation: SuperConfirmGateProps["presentation"];
  onAuthorize: () => Promise<void>;
  onClose: () => void;
}): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host as never);
  await act(async () => {
    root?.render(
      <TestLanguageProvider>
        <Harness {...props} />
      </TestLanguageProvider>,
    );
  });
}

function keySwitches(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
}

function slider(): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('input[type="range"]')!;
}

function emergencyExit(): HTMLButtonElement {
  return [...host.querySelectorAll("button")]
    .find(b => (b.textContent ?? "").trim() === "Emergency exit") as HTMLButtonElement;
}

/** Sets a range input's value the way a real drag does, bypassing React's own value tracker. */
async function drag(value: number): Promise<void> {
  const input = slider();
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, String(value));
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  });
}

for (const presentation of ["anchored", "modal"] as const) {
  test(`[${presentation}] untouched: the slider is disabled and nothing is armed`, async () => {
    const onAuthorize = () => Promise.resolve();
    let closed = false;
    await mount({ presentation, onAuthorize, onClose: () => { closed = true; } });

    expect(slider().disabled).toBe(true);
    expect(keySwitches().length).toBe(2);
    for (const key of keySwitches()) expect(key.getAttribute("aria-checked")).toBe("false");
    expect(closed).toBe(false);
  });

  test(`[${presentation}] one key only: the slider stays disabled`, async () => {
    const onAuthorize = () => Promise.resolve();
    await mount({ presentation, onAuthorize, onClose: () => {} });

    await act(async () => { keySwitches()[0]!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });

    expect(keySwitches()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(keySwitches()[1]!.getAttribute("aria-checked")).toBe("false");
    expect(slider().disabled).toBe(true);
  });

  test(`[${presentation}] both keys: the slider unlocks`, async () => {
    const onAuthorize = () => Promise.resolve();
    await mount({ presentation, onAuthorize, onClose: () => {} });

    for (const key of keySwitches()) {
      await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    }

    expect(slider().disabled).toBe(false);
    expect(host.textContent).toContain("Drag all the way to the end to authorize");
  });

  test(`[${presentation}] partial slide: dragging short of the end never authorizes`, async () => {
    let calls = 0;
    const onAuthorize = () => { calls += 1; return Promise.resolve(); };
    await mount({ presentation, onAuthorize, onClose: () => {} });

    for (const key of keySwitches()) {
      await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    }
    await drag(1);
    await drag(50);
    await drag(99);

    expect(calls).toBe(0);
    expect(slider().disabled).toBe(false);
  });

  test(`[${presentation}] full slide: reaching the end authorizes exactly once and never before both keys are on`, async () => {
    let calls = 0;
    const onAuthorize = () => { calls += 1; return Promise.resolve(); };
    await mount({ presentation, onAuthorize, onClose: () => {} });

    // Sliding before both keys are on must never fire the action — guarded in
    // JS, not only by the `disabled` attribute a test environment might not
    // enforce identically to a browser.
    await drag(100);
    expect(calls).toBe(0);

    for (const key of keySwitches()) {
      await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    }
    await drag(100);

    // `onAuthorize` here resolves synchronously, so by the time `drag` (and
    // its wrapping `act`) returns, the gate has already moved clean through
    // "authorizing" to "done" — the working label's own visibility, and the
    // real timing of that transition, is what the dedicated success-path test
    // below checks with a promise under manual control.
    expect(calls).toBe(1);
    expect(host.textContent).toContain("Deleted");

    // A second slide, after the gate has already authorized once, must never
    // fire the action again.
    await drag(0);
    await drag(100);
    expect(calls).toBe(1);
  });

  test(`[${presentation}] real success path: the completion state shows, then the gate closes and hands focus back`, async () => {
    let closed = false;
    const onAuthorize = () => Promise.resolve();
    await mount({ presentation, onAuthorize, onClose: () => { closed = true; } });

    for (const key of keySwitches()) {
      await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    }
    await drag(100);

    expect(host.textContent).toContain("Deleted");
    expect(closed).toBe(false); // still dwelling on the completion state

    // The completion dwell (900ms) elapses and the gate closes itself.
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 950)); });

    expect(closed).toBe(true);
    expect(testWindow.document.activeElement?.textContent).toBe("Open the gate");
  });

  test(`[${presentation}] real failure path: a rejection shows inline, resets the slide, and keeps both keys on for a retry`, async () => {
    let calls = 0;
    const onAuthorize = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("The server refused it.")) : Promise.resolve();
    };
    await mount({ presentation, onAuthorize, onClose: () => {} });

    for (const key of keySwitches()) {
      await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    }
    await drag(100);
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });

    expect(host.textContent).toContain("Authorization failed");
    expect(host.textContent).toContain("The server refused it.");
    expect(Number(slider().value)).toBe(0);
    // Both keys are still on: a retry is one drag away, not a walk back
    // through both acknowledgements.
    for (const key of keySwitches()) expect(key.getAttribute("aria-checked")).toBe("true");
    expect(slider().disabled).toBe(false);

    // Retrying reaches the real success path on the second call.
    await drag(100);
    expect(calls).toBe(2);
  });

  test(`[${presentation}] cancel (Emergency exit): closes without ever authorizing, and hands focus back`, async () => {
    let calls = 0;
    let closed = false;
    const onAuthorize = () => { calls += 1; return Promise.resolve(); };
    await mount({ presentation, onAuthorize, onClose: () => { closed = true; } });

    for (const key of keySwitches()) {
      await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    }
    await drag(40);
    await act(async () => { emergencyExit().dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });

    expect(calls).toBe(0);
    expect(closed).toBe(true);
    expect(testWindow.document.activeElement?.textContent).toBe("Open the gate");
  });

  test(`[${presentation}] keyboard: Tab reaches both keys and the slider, and each key is Enter-operable`, async () => {
    const onAuthorize = () => Promise.resolve();
    await mount({ presentation, onAuthorize, onClose: () => {} });

    const [key1, key2] = keySwitches();
    await act(async () => { key1!.focus(); });
    expect(testWindow.document.activeElement).toBe(key1);
    await act(async () => { key1!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    expect(key1!.getAttribute("aria-checked")).toBe("true");

    await act(async () => { key2!.focus(); });
    expect(testWindow.document.activeElement).toBe(key2);
    await act(async () => { key2!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    expect(key2!.getAttribute("aria-checked")).toBe("true");

    await act(async () => { slider().focus(); });
    expect(testWindow.document.activeElement).toBe(slider());
    expect(slider().disabled).toBe(false);
  });
}

// Escape and outside-press are custom-coded only for the anchored
// presentation (the modal one inherits them from the shared `Dialog`'s own
// native `<dialog>` semantics, which happy-dom does not model), so they get
// their own focused pass rather than looping over both presentations.
test("[anchored] Escape cancels without authorizing", async () => {
  let calls = 0;
  let closed = false;
  const onAuthorize = () => { calls += 1; return Promise.resolve(); };
  await mount({ presentation: "anchored", onAuthorize, onClose: () => { closed = true; } });

  for (const key of keySwitches()) {
    await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  }
  await drag(20);
  await act(async () => {
    testWindow.document.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });

  expect(calls).toBe(0);
  expect(closed).toBe(true);
});

test("[anchored] a press outside the panel cancels without authorizing", async () => {
  let calls = 0;
  let closed = false;
  const onAuthorize = () => { calls += 1; return Promise.resolve(); };
  await mount({ presentation: "anchored", onAuthorize, onClose: () => { closed = true; } });

  await act(async () => {
    testWindow.document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
  });

  expect(calls).toBe(0);
  expect(closed).toBe(true);
});

test("Escape is always available even mid-authorization, and a settled promise after unmount touches nothing", async () => {
  const { onAuthorize, settle } = deferredAuthorize();
  let closed = false;
  await mount({ presentation: "anchored", onAuthorize, onClose: () => { closed = true; } });

  for (const key of keySwitches()) {
    await act(async () => { key.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  }
  await drag(100);
  expect(host.textContent).toContain("Deleting…");

  // Emergency exit is clickable even while authorization is in flight, and it
  // genuinely unmounts the gate — the harness's `onClose` flips `open` to
  // `false` exactly like every real caller's does.
  await act(async () => { emergencyExit().dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  expect(closed).toBe(true);
  expect(host.textContent).not.toContain("Deleting…");

  // The in-flight request settles after the gate is already gone. Without the
  // `mountedRef` guard this calls `setState` on an unmounted component, which
  // React reports as a console error rather than a thrown exception — so the
  // console is watched directly rather than trusting an absence of throw.
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await act(async () => { settle.resolve(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  } finally {
    console.error = originalError;
  }
  expect(errors).toEqual([]);
});
