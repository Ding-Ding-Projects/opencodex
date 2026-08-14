/**
 * Shared DOM-interaction helpers for the toy-lock component tests
 * (`lock-wizard.test.tsx`, `unlock-prompt.test.tsx`, `locks-page.test.tsx`).
 *
 * Extracted after `lock-wizard.test.tsx` needed three attempts to get its own
 * copy of `clickUntil` right — see the comment inside it for the actual
 * failure mode. Worth not re-discovering per file.
 */

import { act } from "react";
import type { Window } from "happy-dom";

export function byLabel(win: Window, container: HTMLElement, text: string): HTMLElement {
  const labels = [...container.querySelectorAll("label")];
  const label = labels.find(l => (l.textContent ?? "").trim() === text);
  if (!label) throw new Error(`no label with exact text "${text}"`);
  const forId = label.getAttribute("for");
  if (forId) {
    const byId = container.ownerDocument!.getElementById(forId);
    if (byId) return byId as HTMLElement;
  }
  const wrapper = label.closest(".m3-field") ?? label.parentElement!;
  return wrapper.querySelector("input, textarea, select") as HTMLElement;
}

export function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(b => (b.textContent ?? "").trim() === text);
  if (!found) throw new Error(`no button with exact text "${text}"`);
  return found as HTMLButtonElement;
}

export function setInputValue(win: Window, input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  return act(async () => {
    const proto = input instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

/**
 * A click whose handler may kick off unawaited async work (real
 * `crypto.subtle` calls, in every toy-lock surface).
 *
 * `act()` only tracks what its own callback awaits; a click handler wired as
 * `onClick={() => void doSomethingAsync()}` keeps running after that callback
 * returns, so the state updates it eventually makes are not flushed by the
 * `act()` around the dispatch itself.
 *
 * The fix is NOT "await inside one long `act()` call" — that was tried first
 * and consistently left `container.textContent` reading stale for the entire
 * wait, because a single `act()` spanning a real-timer polling loop never
 * gives React's act-scoped scheduler a point at which to flush an unrelated
 * async continuation's updates; everything appeared only once that one
 * `act()` finally resolved, defeating the point of polling. Each poll turn
 * needs to be its **own** `act()` call so a flush actually happens after it.
 */
export async function clickUntil(
  win: Window,
  el: Element,
  until?: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  if (!until) return;
  const deadline = Date.now() + timeoutMs;
  while (!(await until()) && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
}
