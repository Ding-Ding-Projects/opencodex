/**
 * The Material 3 replacement for `window.confirm()`.
 *
 * Seven call sites used to ask the browser to draw their confirmations. Inside
 * the desktop shell that renders as a grey Windows box titled
 * "opencodex-desktop": no theme, no Cantonese, no funny level, and buttons the
 * app cannot label — so the dialog guarding a plaintext dump of every credential
 * offered the same "OK" as everything else. It also stops the renderer, so the
 * page behind it freezes mid-paint and reads as a hijacked window.
 *
 * The awkward part is the shape. `confirm()` is synchronous and returns a
 * boolean; a React dialog is neither. All seven sites are written as
 * `if (!confirm(...)) return;` in the middle of a handler, so the replacement
 * had to be awaitable rather than a lump of dialog state bolted onto each
 * screen:
 *
 *     const confirm = useConfirm();
 *     if (!(await confirm({ title, body, confirmLabel, tone: "danger" }))) return;
 *
 * These stay **modal**. The project's rule sends anything *informational* to a
 * non-blocking snackbar, and none of these seven inform: each asks a question
 * whose answer decides what the next statement does. Blocking is correct for
 * exactly this category, and `Dialog` defaults to `showModal()`.
 *
 * The invariant worth stating out loud: **a returned promise always settles.**
 * A handler awaiting one that never resolves does not fail loudly — it simply
 * never continues, leaving a spinner up and a `finally` block unrun. So Cancel,
 * Escape, the scrim, and the provider unmounting all resolve `false`, and a
 * second request arriving while one is open queues behind it instead of
 * replacing it and dropping its promise.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog } from "./m3-ui";
import { useT } from "../i18n/shared";
import { ConfirmContext, type ConfirmFn, type ConfirmRequest } from "./confirm-context";

interface PendingConfirm {
  id: number;
  request: ConfirmRequest;
  /** Idempotent: the first answer wins, later ones are dropped. */
  settle: (answer: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const seq = useRef(0);

  // Stable for the life of the provider, so a caller can safely list it in a
  // dependency array — a `confirm` that changed identity on every answer would
  // re-run every effect that guards on it.
  const confirm = useCallback<ConfirmFn>(request => new Promise<boolean>(resolve => {
    let answered = false;
    const pending: PendingConfirm = {
      id: ++seq.current,
      request,
      settle: answer => { if (answered) return; answered = true; resolve(answer); },
    };
    setQueue(prev => prev.concat([pending]));
  }), []);

  // The queue mirrored into a ref purely so the unmount cleanup can reach it. A
  // cleanup that closed over `queue` would have to list it as a dependency, and
  // would then run on every answer — declining the request still on screen.
  const pendingRef = useRef<PendingConfirm[]>([]);
  useEffect(() => { pendingRef.current = queue; }, [queue]);

  // Unmounting with requests outstanding is the one route where nothing else can
  // answer them: there is no dialog left to press Escape on, and the handler that
  // called `confirm()` is still parked on its `await`. Declining is the safe
  // answer and the same one Cancel gives.
  useEffect(() => () => { for (const pending of pendingRef.current) pending.settle(false); }, []);

  const current = queue[0];

  const answer = (accepted: boolean) => {
    if (!current) return;
    current.settle(accepted);
    setQueue(prev => prev.filter(pending => pending.id !== current.id));
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        <Dialog
          // Keyed on the request, so answering one and revealing the next queued
          // one mounts a fresh <dialog> rather than relabelling the open one.
          // Relabelling would leave focus sitting on the button just pressed —
          // which is now the *next* question's confirm button, so one more Enter
          // would agree to something the user has not read. A remount hands focus
          // back to the opener and lets `showModal()` place it on Cancel again.
          key={current.id}
          title={current.request.title}
          description={current.request.body
            ? <span style={{ whiteSpace: "pre-line" }}>{current.request.body}</span>
            : undefined}
          onClose={() => answer(false)}
          actions={
            <>
              {/* Cancel comes first in the DOM on purpose. `showModal()` focuses
                  the first focusable descendant, so Enter on a freshly opened
                  confirmation declines rather than firing a destructive action
                  the user has not read yet. */}
              <Button variant="text" onClick={() => answer(false)}>
                {current.request.cancelLabel ?? t("common.cancel")}
              </Button>
              <Button
                variant={current.request.tone === "danger" ? "danger" : "filled"}
                onClick={() => answer(true)}
              >
                {current.request.confirmLabel}
              </Button>
            </>
          }
        />
      )}
    </ConfirmContext.Provider>
  );
}
