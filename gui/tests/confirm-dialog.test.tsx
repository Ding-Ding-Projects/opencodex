/**
 * The promise-based Material 3 confirmation and prompt that replaced
 * `window.confirm()` and `window.prompt()`.
 *
 * The defect this file exists to prevent is not a wrong answer — it is *no*
 * answer. Every call site is written `if (!(await confirm(...))) return;` or
 * `if (value === null) return;`, so a promise that never settles does not throw,
 * log, or fail a build: the handler simply stops mid-way, the spinner it set
 * stays up, and its `finally` never runs. That is indistinguishable from a hang.
 * So every dismissal route below asserts the promise *resolved*, not merely that
 * the dialog went away.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";

import { ConfirmProvider } from "../src/shell/confirm";
import { useConfirm, usePrompt, type ConfirmRequest, type PromptRequest } from "../src/shell/confirm-context";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // happy-dom does not implement the top-layer methods the native element uses,
  // so `showModal()` is stubbed to the observable part: the open attribute.
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

const REQUEST: ConfirmRequest = {
  title: "Exit OpenCodex",
  body: "The proxy stops and the app closes.",
  confirmLabel: "Exit",
  tone: "danger",
};

/**
 * A button that opens a confirmation and records the answer, which is the exact
 * shape every real call site has: a focused control, an await, and code after it
 * that only runs once the promise settles.
 */
function Opener({ answers, request = REQUEST, label = "Open" }: {
  answers: (boolean | "pending")[];
  request?: ConfirmRequest;
  label?: string;
}) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() => {
        const slot = answers.push("pending") - 1;
        void confirm(request).then(answer => { answers[slot] = answer; });
      }}
    >
      {label}
    </button>
  );
}

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

function mountProvider(children: React.ReactNode) {
  // The provider reads `common.cancel` through `useT`, so it needs the language
  // provider above it exactly as `main.tsx` gives it.
  return mount(<LanguageProvider><ConfirmProvider>{children}</ConfirmProvider></LanguageProvider>);
}

function dialogOf(container: HTMLElement): HTMLDialogElement | null {
  return container.querySelector("dialog");
}

function buttonLabelled(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("dialog button")]
    .find(node => node.textContent === text);
  if (!match) throw new Error(`no dialog button labelled ${text}`);
  return match as HTMLButtonElement;
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click(); });
}

const ALIAS: PromptRequest = {
  title: "Set a display name",
  label: "Display name (leave empty to clear)",
  initialValue: "work laptop",
  confirmLabel: "Save",
};

/**
 * The prompt's equivalent of `Opener`: a control that asks for text and records
 * what came back. `"pending"` in the slot means the promise has not settled,
 * which is the state every case here is really testing against.
 */
function TextOpener({ answers, request = ALIAS, label = "Rename" }: {
  answers: (string | null | "pending")[];
  request?: PromptRequest;
  label?: string;
}) {
  const prompt = usePrompt();
  return (
    <button
      type="button"
      onClick={() => {
        const slot = answers.push("pending") - 1;
        void prompt(request).then(answer => { answers[slot] = answer; });
      }}
    >
      {label}
    </button>
  );
}

function promptField(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("dialog input");
  if (!input) throw new Error("no prompt field");
  return input;
}

/** Types through the value setter React tracks, so state actually updates. */
async function type(container: HTMLElement, value: string): Promise<void> {
  const input = promptField(container);
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
  });
}

test("confirming resolves true and cancelling resolves false", async () => {
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  const opener = container.querySelector("button")!;

  await click(opener);
  expect(dialogOf(container)).not.toBeNull();
  await click(buttonLabelled(container, "Exit"));
  expect(answers).toEqual([true]);
  expect(dialogOf(container)).toBeNull();

  await click(opener);
  await click(buttonLabelled(container, "Cancel"));
  expect(answers).toEqual([true, false]);
  expect(dialogOf(container)).toBeNull();

  await act(async () => { root.unmount(); });
});

test("Escape resolves false rather than leaving the promise hanging", async () => {
  // The native dialog answered "false" on Escape; a React dialog that only hides
  // itself leaves the awaiting handler parked forever, which reads as a hang
  // rather than as a cancellation.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  await click(container.querySelector("button")!);

  const dialog = dialogOf(container)!;
  await act(async () => {
    dialog.dispatchEvent(new testWindow.Event("cancel", { bubbles: false, cancelable: true }) as unknown as Event);
  });

  expect(answers).toEqual([false]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("the scrim resolves false", async () => {
  // A click that lands on the <dialog> element itself is the scrim; the surface
  // swallows everything inside it.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  await click(container.querySelector("button")!);

  await click(dialogOf(container)!);

  expect(answers).toEqual([false]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("the dialog is modal and carries an accessible name from its title", async () => {
  // Without a name, assistive tech announces the most consequential decision in
  // the app as "dialog"; without `showModal()` it is not a decision gate at all.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  await click(container.querySelector("button")!);

  const dialog = dialogOf(container)!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.hasAttribute("open")).toBe(true);

  const labelledBy = dialog.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  // getElementById, not a `#id` selector: React's useId emits colons.
  expect(container.ownerDocument.getElementById(labelledBy!)?.textContent).toBe("Exit OpenCodex");

  await act(async () => { root.unmount(); });
});

test("the body is wired as the dialog's description, not just drawn", async () => {
  // Focus lands on a button inside the dialog, so a screen reader announces the
  // dialog's name and that button. Without aria-describedby, the one sentence
  // saying what confirming actually does is never read aloud.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  await click(container.querySelector("button")!);

  const describedBy = dialogOf(container)!.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(container.ownerDocument.getElementById(describedBy!)?.textContent)
    .toBe("The proxy stops and the app closes.");

  await act(async () => { root.unmount(); });
});

test("a request with no body carries no dangling description reference", async () => {
  // An aria-describedby pointing at an element that was never rendered is worse
  // than none: assistive tech resolves it to nothing and the dialog reads as bare.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(
    <Opener answers={answers} request={{ title: "Stop the proxy", confirmLabel: "Stop Proxy" }} />,
  );
  await click(container.querySelector("button")!);

  expect(dialogOf(container)!.getAttribute("aria-describedby")).toBeNull();
  await act(async () => { root.unmount(); });
});

test("a danger tone styles the confirming button, and the default tone does not", async () => {
  // The label names the action; the tone is the second signal that this one
  // cannot be taken back. Losing it turns "Exit" into an ordinary filled button.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(
    <>
      <Opener answers={answers} label="Danger" />
      <Opener answers={answers} request={{ title: "Stop the proxy", confirmLabel: "Stop Proxy" }} label="Plain" />
    </>,
  );
  const [danger, plain] = [...container.querySelectorAll("button")] as HTMLButtonElement[];

  await click(danger);
  expect(buttonLabelled(container, "Exit").className).toContain("m3-btn--danger");
  await click(buttonLabelled(container, "Cancel"));

  await click(plain);
  const stop = buttonLabelled(container, "Stop Proxy");
  expect(stop.className).toContain("m3-btn--filled");
  expect(stop.className).not.toContain("m3-btn--danger");

  await act(async () => { root.unmount(); });
});

test("focus returns to the control that opened the confirmation", async () => {
  // Keyboard users otherwise restart from the top of the page after every
  // decision — the dialog is removed from the DOM rather than closed, so the
  // browser's own focus restoration never runs.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  const opener = container.querySelector("button")!;
  opener.focus();
  expect(document.activeElement).toBe(opener);

  await click(opener);
  await click(buttonLabelled(container, "Exit"));

  expect(document.activeElement).toBe(opener);
  await act(async () => { root.unmount(); });
});

test("a request still open when the provider unmounts settles false", async () => {
  // Nothing is left to press Escape on, and the caller is still parked on its
  // await. Declining is the safe answer and the one Cancel already gives.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(<Opener answers={answers} />);
  await click(container.querySelector("button")!);
  expect(answers).toEqual(["pending"]);

  await act(async () => { root.unmount(); });
  // The resolution is queued as a microtask by the unmount cleanup; one turn of
  // the event loop is enough for the `.then` above to have run.
  await act(async () => { await Promise.resolve(); });

  expect(answers).toEqual([false]);
});

test("a second request while one is open loses neither promise", async () => {
  // Overwriting the open request with the new one would drop the first promise
  // on the floor, and its handler would never continue. They queue instead.
  const answers: (boolean | "pending")[] = [];
  const { container, root } = await mountProvider(
    <>
      <Opener answers={answers} label="First" />
      <Opener answers={answers} request={{ title: "Restore this snapshot", confirmLabel: "Restore" }} label="Second" />
    </>,
  );
  const [first, second] = [...container.querySelectorAll("button")] as HTMLButtonElement[];

  await click(first);
  await click(second);

  // Only one dialog is ever on screen: two stacked modals fight over the focus
  // trap, and the user cannot tell which question the buttons belong to.
  expect(container.querySelectorAll("dialog").length).toBe(1);
  expect(answers).toEqual(["pending", "pending"]);

  await click(buttonLabelled(container, "Exit"));
  expect(answers).toEqual([true, "pending"]);

  // The queued one takes its place rather than vanishing with the first.
  const queued = dialogOf(container)!;
  const labelledBy = queued.getAttribute("aria-labelledby")!;
  expect(container.ownerDocument.getElementById(labelledBy)?.textContent).toBe("Restore this snapshot");

  await click(buttonLabelled(container, "Cancel"));
  expect(answers).toEqual([true, false]);
  expect(dialogOf(container)).toBeNull();

  await act(async () => { root.unmount(); });
});

test("nothing is shown until a request arrives", async () => {
  // A provider that always renders its <dialog> would inert the whole app.
  const { container, root } = await mountProvider(<Opener answers={[]} />);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("useConfirm outside the provider fails loudly instead of returning undefined", async () => {
  // A silent `undefined` here would be called as a function inside a handler and
  // reject with a TypeError nobody catches — the same silent stall by a longer
  // route.
  let caught: unknown = null;
  function Bare() {
    const [, setState] = useState(0);
    useEffect(() => setState(1), []);
    try {
      useConfirm();
    } catch (err) {
      caught = err;
    }
    return null;
  }
  const { root } = await mount(<Bare />);
  expect(caught).toBeInstanceOf(Error);
  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------------------------ prompt -- */

test("the typed value is what resolves", async () => {
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);

  await click(container.querySelector("button")!);
  // An edit starts from the current value rather than from an empty box — the
  // native prompt's second argument, which is the whole reason it had one.
  expect(promptField(container).value).toBe("work laptop");

  await type(container, "home desktop");
  await click(buttonLabelled(container, "Save"));

  expect(answers).toEqual(["home desktop"]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("an empty string resolves as an answer, not as a cancellation", async () => {
  // `""` and `null` mean different things at every call site: the alias prompts
  // read `=== null` to bail and otherwise send what came back, so folding an
  // emptied field into "cancelled" would make clearing an alias impossible.
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);

  await click(container.querySelector("button")!);
  await type(container, "");
  await click(buttonLabelled(container, "Save"));

  expect(answers).toEqual([""]);
  await act(async () => { root.unmount(); });
});

test("Enter submits the field, as the native prompt did", async () => {
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);

  await click(container.querySelector("button")!);
  await type(container, "typed then Entered");
  await act(async () => {
    promptField(container).dispatchEvent(
      new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
    );
  });

  expect(answers).toEqual(["typed then Entered"]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("Cancel resolves null rather than the draft text", async () => {
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);

  await click(container.querySelector("button")!);
  await type(container, "half-typed, then thought better of it");
  await click(buttonLabelled(container, "Cancel"));

  expect(answers).toEqual([null]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("Escape on a prompt resolves null rather than leaving the promise hanging", async () => {
  // The native prompt answered null on Escape; a React dialog that only hides
  // itself leaves the awaiting handler parked forever, which reads as a hang
  // rather than as a cancellation.
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);
  await click(container.querySelector("button")!);

  const dialog = dialogOf(container)!;
  await act(async () => {
    dialog.dispatchEvent(new testWindow.Event("cancel", { bubbles: false, cancelable: true }) as unknown as Event);
  });

  expect(answers).toEqual([null]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("the scrim does not discard what was typed", async () => {
  // The one difference from the confirmation, which does dismiss on the scrim: a
  // stray click outside a box the user has been typing into is never deliberate,
  // and losing the draft to it is not recoverable.
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);
  await click(container.querySelector("button")!);
  await type(container, "still writing this");

  await click(dialogOf(container)!);

  expect(answers).toEqual(["pending"]);
  expect(dialogOf(container)).not.toBeNull();
  expect(promptField(container).value).toBe("still writing this");

  await act(async () => { root.unmount(); });
});

test("a prompt still open when the provider unmounts settles null", async () => {
  // Nothing is left to press Escape on, and the caller is still parked on its
  // await. Answering null is the safe outcome and the one Cancel already gives.
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);
  await click(container.querySelector("button")!);
  expect(answers).toEqual(["pending"]);

  await act(async () => { root.unmount(); });
  await act(async () => { await Promise.resolve(); });

  expect(answers).toEqual([null]);
});

test("two racing prompts both settle, and neither inherits the other's draft", async () => {
  // Overwriting the open request with the new one would drop the first promise
  // on the floor. Worse for a prompt than for a confirmation: if the second
  // dialog were the same element relabelled, it would open holding the text
  // typed into the first, and saving would write it to the wrong credential.
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(
    <>
      <TextOpener answers={answers} label="First" />
      <TextOpener
        answers={answers}
        request={{ title: "Name this key", label: "Key label", initialValue: "", confirmLabel: "Save" }}
        label="Second"
      />
    </>,
  );
  const [first, second] = [...container.querySelectorAll("button")] as HTMLButtonElement[];

  await click(first);
  await click(second);

  // Only one dialog is ever on screen: two stacked modals fight over the focus
  // trap, and the user cannot tell which field the Save button belongs to.
  expect(container.querySelectorAll("dialog").length).toBe(1);
  expect(answers).toEqual(["pending", "pending"]);

  await type(container, "first answer");
  await click(buttonLabelled(container, "Save"));
  expect(answers).toEqual(["first answer", "pending"]);

  // The queued one takes its place with its own initial value, not the first's text.
  expect(promptField(container).value).toBe("");
  await type(container, "second answer");
  await click(buttonLabelled(container, "Save"));

  expect(answers).toEqual(["first answer", "second answer"]);
  expect(dialogOf(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("a confirmation and a prompt queue against each other rather than stacking", async () => {
  // They share one queue precisely so this cannot happen: two independent queues
  // would each decide to show a modal and put two on screen at once.
  const confirmAnswers: (boolean | "pending")[] = [];
  const textAnswers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(
    <>
      <Opener answers={confirmAnswers} label="Confirm" />
      <TextOpener answers={textAnswers} label="Prompt" />
    </>,
  );
  const [confirmBtn, promptBtn] = [...container.querySelectorAll("button")] as HTMLButtonElement[];

  await click(confirmBtn);
  await click(promptBtn);
  expect(container.querySelectorAll("dialog").length).toBe(1);

  await click(buttonLabelled(container, "Exit"));
  expect(confirmAnswers).toEqual([true]);

  // The prompt is now the one on screen, with a real field rather than a second
  // pair of confirmation buttons.
  expect(promptField(container).value).toBe("work laptop");
  await click(buttonLabelled(container, "Cancel"));
  expect(textAnswers).toEqual([null]);

  await act(async () => { root.unmount(); });
});

test("the field is labelled and holds focus, and a secret one is masked", async () => {
  // `window.prompt()` gave the box no accessible name at all, so a screen reader
  // announced the most sensitive input in the app as "edit, blank".
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(
    <TextOpener
      answers={answers}
      request={{ title: "Admin token needed", label: "Admin token", secret: true, confirmLabel: "Use this token" }}
    />,
  );
  await click(container.querySelector("button")!);

  const input = promptField(container);
  const labelled = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
  expect(labelled?.textContent).toBe("Admin token");
  // A credential is masked and kept out of autofill; an ordinary value is not.
  expect(input.getAttribute("type")).toBe("password");
  expect(input.getAttribute("autocomplete")).toBe("off");
  // The user opened this to type, so the field takes focus rather than the
  // Cancel button `showModal()` would otherwise land on.
  expect(document.activeElement).toBe(input);

  await click(buttonLabelled(container, "Cancel"));
  await act(async () => { root.unmount(); });
});

test("an ordinary prompt field stays readable", async () => {
  const answers: (string | null | "pending")[] = [];
  const { container, root } = await mountProvider(<TextOpener answers={answers} />);
  await click(container.querySelector("button")!);

  expect(promptField(container).getAttribute("type")).toBe("text");

  await click(buttonLabelled(container, "Cancel"));
  await act(async () => { root.unmount(); });
});

test("usePrompt outside the provider fails loudly instead of returning undefined", async () => {
  let caught: unknown = null;
  function Bare() {
    const [, setState] = useState(0);
    useEffect(() => setState(1), []);
    try {
      usePrompt();
    } catch (err) {
      caught = err;
    }
    return null;
  }
  const { root } = await mount(<Bare />);
  expect(caught).toBeInstanceOf(Error);
  await act(async () => { root.unmount(); });
});
