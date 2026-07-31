/**
 * The confirmation request shape, its React context, and the `useConfirm` hook.
 *
 * Split from `confirm.tsx` for the same reason `notifications-context.ts` is
 * split from `notifications.tsx`: Fast Refresh discards a module's state when
 * that module exports both a component and something else. Here the state is a
 * queue of *unsettled promises*, so losing it mid-edit would park every awaiting
 * handler forever — which is the one failure this design exists to rule out.
 *
 * Deliberately absent: an `alert` and a `prompt` equivalent. Anything that only
 * reports an outcome is a snackbar (`notify()`), and anything that collects a
 * value needs a real labelled form rather than one anonymous text box.
 */

import { createContext, useContext } from "react";

/**
 * `danger` styles the confirming button as destructive. It is a warning to the
 * reader and nothing else — the provider takes the same code path either way.
 */
export type ConfirmTone = "default" | "danger";

export interface ConfirmRequest {
  /** Headline. Names the decision: "Exit OpenCodex", not "Are you sure?". */
  title: string;
  /**
   * Supporting text: what will happen and what it costs, in unambiguous words.
   * Rendered `pre-line`, so a body that separates consequence from cost with a
   * blank line keeps the break.
   */
  body?: string;
  /**
   * The confirming button's label, naming the action — "Exit", "Restore",
   * "Download export". "OK" tells the reader nothing about what they just
   * agreed to, which is the worst part of the native dialog this replaces.
   */
  confirmLabel: string;
  /** Defaults to the shared "Cancel". */
  cancelLabel?: string;
  tone?: ConfirmTone;
}

/** Resolves true only when the user confirms; every dismissal route gives false. */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;

export const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within ConfirmProvider");
  return confirm;
}
