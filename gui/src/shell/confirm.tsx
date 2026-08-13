/**
 * The Material 3 replacements for `window.confirm()` and `window.prompt()`.
 *
 * A dozen call sites used to ask the browser to draw their decisions. Inside the
 * desktop shell that renders as a grey Windows box titled "opencodex-desktop":
 * no theme, no Cantonese, no funny level, and buttons the app cannot label — so
 * the dialog guarding a plaintext dump of every credential offered the same "OK"
 * as everything else. It also stops the renderer, so the page behind it freezes
 * mid-paint and reads as a hijacked window. `window.prompt()` is worse again:
 * Electron does not implement it and *throws*, so an alias rename inside the
 * desktop app was not an ugly dialog, it was an exception.
 *
 * The awkward part is the shape. `confirm()` and `prompt()` are synchronous and
 * return a value; a React dialog is neither. Every site is written as
 * `if (!confirm(...)) return;` or `const x = prompt(...); if (x === null) return;`
 * in the middle of a handler, so the replacements had to be awaitable rather
 * than a lump of dialog state bolted onto each screen:
 *
 *     const confirm = useConfirm();
 *     if (!(await confirm({ title, body, confirmLabel, tone: "danger" }))) return;
 *
 *     const prompt = usePrompt();
 *     const alias = await prompt({ title, label, initialValue, confirmLabel });
 *     if (alias === null) return;
 *
 * These stay **modal**. The project's rule sends anything *informational* to a
 * non-blocking snackbar, and none of these inform: each asks a question whose
 * answer decides what the next statement does. Blocking is correct for exactly
 * this category, and `Dialog` defaults to `showModal()`.
 *
 * The invariant worth stating out loud: **a returned promise always settles.**
 * A handler awaiting one that never resolves does not fail loudly — it simply
 * never continues, leaving a spinner up and a `finally` block unrun. So Cancel,
 * Escape, the scrim, and the provider unmounting all resolve the dismissal value
 * (`false` / `null`), and a second request arriving while one is open queues
 * behind it instead of replacing it and dropping its promise.
 *
 * One queue holds both kinds, not two. Two independent queues would each happily
 * put a dialog on screen at the same moment, and two stacked modals fight over
 * the focus trap while the user cannot tell which question the buttons answer.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Field, TextInput } from "./m3-ui";
import { useT } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import { decorateMessage } from "./message-emoji";
import {
  ConfirmContext,
  PromptContext,
  type ConfirmFn,
  type ConfirmRequest,
  type PromptFn,
  type PromptRequest,
} from "./confirm-context";

interface PendingConfirm {
  kind: "confirm";
  id: number;
  request: ConfirmRequest;
  /** Idempotent: the first answer wins, later ones are dropped. */
  settle: (answer: boolean) => void;
}

interface PendingPrompt {
  kind: "prompt";
  id: number;
  request: PromptRequest;
  /** Idempotent: the first answer wins, later ones are dropped. */
  settle: (answer: string | null) => void;
}

type Pending = PendingConfirm | PendingPrompt;

/** The answer every dismissal route gives, whichever kind is on screen. */
function dismiss(pending: Pending): void {
  if (pending.kind === "confirm") pending.settle(false);
  else pending.settle(null);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  // "Show emojis in dialogs and message boxes." Read once here rather than
  // inside `Dialog` itself: `Dialog` is exercised bare, with no settings
  // provider in the tree at all (see `tests/m3-dialog.test.tsx`), so the
  // decoration is resolved at this call site and handed down as an already-built
  // title instead.
  const { prefs } = usePrefs();
  const [queue, setQueue] = useState<Pending[]>([]);
  const seq = useRef(0);

  // Stable for the life of the provider, so a caller can safely list either in a
  // dependency array — a `confirm` that changed identity on every answer would
  // re-run every effect that guards on it.
  // The pending entry is built *before* the updater, never inside it. React may
  // call an updater twice to check it is pure, and one that minted an id and a
  // fresh `settle` closure on each call would burn a sequence number and throw
  // away the closure it had already handed out.
  const confirm = useCallback<ConfirmFn>(request => new Promise<boolean>(resolve => {
    let answered = false;
    const pending: PendingConfirm = {
      kind: "confirm",
      id: ++seq.current,
      request,
      settle: answer => { if (answered) return; answered = true; resolve(answer); },
    };
    setQueue(prev => prev.concat([pending]));
  }), []);

  const prompt = useCallback<PromptFn>(request => new Promise<string | null>(resolve => {
    let answered = false;
    const pending: PendingPrompt = {
      kind: "prompt",
      id: ++seq.current,
      request,
      settle: answer => { if (answered) return; answered = true; resolve(answer); },
    };
    setQueue(prev => prev.concat([pending]));
  }), []);

  // The queue mirrored into a ref purely so the unmount cleanup can reach it. A
  // cleanup that closed over `queue` would have to list it as a dependency, and
  // would then run on every answer — declining the request still on screen.
  const pendingRef = useRef<Pending[]>([]);
  useEffect(() => { pendingRef.current = queue; }, [queue]);

  // Unmounting with requests outstanding is the one route where nothing else can
  // answer them: there is no dialog left to press Escape on, and the handler that
  // called `confirm()` / `prompt()` is still parked on its `await`. Dismissing is
  // the safe answer and the same one Cancel gives.
  useEffect(() => () => { for (const pending of pendingRef.current) dismiss(pending); }, []);

  const current = queue[0];

  // Settling and dequeuing are separate on purpose: `settle` is idempotent and
  // the queue is what decides what is on screen, so the caller's promise is kept
  // even if a re-render loses the race to remove the entry.
  const dequeue = (id: number) => setQueue(prev => prev.filter(other => other.id !== id));

  return (
    <ConfirmContext.Provider value={confirm}>
      <PromptContext.Provider value={prompt}>
        {children}
        {/* Keyed on the request, so answering one and revealing the next queued
            one mounts a fresh <dialog> rather than relabelling the open one.
            Relabelling would leave focus sitting on the button just pressed —
            which is now the *next* question's confirm button, so one more Enter
            would agree to something the user has not read. A remount hands focus
            back to the opener and lets `showModal()` place it afresh. For a
            prompt it also matters that the draft text resets: a remount is what
            stops the second question inheriting the first one's typing. */}
        {current?.kind === "confirm" && (
          <Dialog
            key={current.id}
            // "danger" earns the same alarm mark a standing warning does; every
            // other confirmation is a plain decision, not a warning at all, so it
            // gets the question mark rather than borrowing the danger tone's.
            title={decorateMessage(current.request.tone === "danger" ? "danger" : "question", current.request.title, prefs.showEmojis)}
            description={current.request.body
              ? <span style={{ whiteSpace: "pre-line" }}>{current.request.body}</span>
              : undefined}
            onClose={() => { current.settle(false); dequeue(current.id); }}
            actions={
              <>
                {/* Cancel comes first in the DOM on purpose. `showModal()` focuses
                    the first focusable descendant, so Enter on a freshly opened
                    confirmation declines rather than firing a destructive action
                    the user has not read yet. */}
                <Button variant="text" onClick={() => { current.settle(false); dequeue(current.id); }}>
                  {current.request.cancelLabel ?? t("common.cancel")}
                </Button>
                <Button
                  variant={current.request.tone === "danger" ? "danger" : "filled"}
                  onClick={() => { current.settle(true); dequeue(current.id); }}
                >
                  {current.request.confirmLabel}
                </Button>
              </>
            }
          />
        )}
        {current?.kind === "prompt" && (
          <PromptDialog
            key={current.id}
            request={current.request}
            cancelLabel={current.request.cancelLabel ?? t("common.cancel")}
            showEmojis={prefs.showEmojis}
            onSettle={value => { current.settle(value); dequeue(current.id); }}
          />
        )}
      </PromptContext.Provider>
    </ConfirmContext.Provider>
  );
}

/**
 * The prompt's own dialog, split out so the draft text is component state.
 *
 * Holding it in the provider would mean resetting it by hand on every request —
 * and the failure mode of forgetting is the worst one available here: the second
 * question opens prefilled with what was typed into the first, and a confirming
 * user saves it somewhere it does not belong. Mounting a fresh component per
 * request makes the reset structural instead of remembered.
 */
function PromptDialog({ request, cancelLabel, showEmojis, onSettle }: {
  request: PromptRequest;
  cancelLabel: string;
  showEmojis: boolean;
  onSettle: (value: string | null) => void;
}) {
  const [value, setValue] = useState(request.initialValue ?? "");
  // The field and its label are wired together by id rather than by nesting,
  // because `Field` renders the label as a sibling.
  const fieldId = useId();

  return (
    <Dialog
      title={decorateMessage("prompt", request.title, showEmojis)}
      description={request.body
        ? <span style={{ whiteSpace: "pre-line" }}>{request.body}</span>
        : undefined}
      onClose={() => onSettle(null)}
      // The dialog holds text the user has typed. A stray click on the scrim
      // discarding it is the one dismissal route that is never deliberate, so
      // only Cancel and Escape close this.
      dismissOnScrim={false}
      actions={
        <>
          <Button variant="text" onClick={() => onSettle(null)}>{cancelLabel}</Button>
          <Button variant="filled" onClick={() => onSettle(value)}>{request.confirmLabel}</Button>
        </>
      }
    >
      <Field label={request.label} hint={request.hint} id={fieldId}>
        <TextInput
          id={fieldId}
          // `showModal()` focuses the first focusable descendant, which for a
          // confirmation is deliberately its Cancel button. A prompt is the
          // opposite case: the user opened it to type, so the field asks for
          // focus explicitly rather than making them Tab to it.
          autoFocus
          type={request.secret ? "password" : "text"}
          autoComplete={request.secret ? "off" : undefined}
          spellCheck={request.secret ? false : undefined}
          value={value}
          placeholder={request.placeholder}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            // Enter submits, as it did in the native prompt. Escape is left to
            // the dialog's own `cancel` event so both routes settle identically.
            if (event.key !== "Enter") return;
            event.preventDefault();
            onSettle(value);
          }}
        />
      </Field>
    </Dialog>
  );
}
