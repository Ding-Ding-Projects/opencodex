/**
 * The confirmation and prompt request shapes, their React contexts, and the
 * `useConfirm` / `usePrompt` hooks.
 *
 * Split from `confirm.tsx` for the same reason `notifications-context.ts` is
 * split from `notifications.tsx`: Fast Refresh discards a module's state when
 * that module exports both a component and something else. Here the state is a
 * queue of *unsettled promises*, so losing it mid-edit would park every awaiting
 * handler forever — which is the one failure this design exists to rule out.
 *
 * Still deliberately absent: an `alert` equivalent. Anything that only reports
 * an outcome is a snackbar (`notify()`), never a dialog the user has to dismiss
 * before the app will move again.
 *
 * `prompt` used to be absent on the same reasoning — that collecting a value
 * needs a real labelled form rather than one anonymous text box. The labelled
 * form is what `PromptRequest` is: a required field `label`, so the box is
 * always named, and a title that says what the value is for. What it replaces
 * is five `window.prompt()` calls whose only label was the message string, and
 * which throw outright inside Electron.
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

export interface PromptRequest {
  /** Headline. Names what is being asked for: "Rename this account". */
  title: string;
  /** Optional supporting text, rendered `pre-line` like the confirmation's. */
  body?: string;
  /**
   * The text field's visible label — required, not optional. `window.prompt()`
   * gave the field no name at all beyond the message floating above it, which
   * is exactly why a screen reader announced these five as "edit, blank".
   */
  label: string;
  /** Prefills the field. An edit starts from the current value, not from empty. */
  initialValue?: string;
  placeholder?: string;
  /** Hint text under the field — say the rule before the server refuses it. */
  hint?: string;
  /**
   * Masks the field and keeps it out of autofill. For a credential only; an
   * ordinary value the user is editing should stay readable.
   */
  secret?: boolean;
  /** The submitting button's label, naming the action — "Save", "Unlock". */
  confirmLabel: string;
  /** Defaults to the shared "Cancel". */
  cancelLabel?: string;
}

/**
 * Resolves to the entered text, or `null` for every dismissal route.
 *
 * `""` and `null` mean different things and must not be conflated: an empty
 * string is a deliberate answer (clearing an alias), `null` is "no answer" and
 * leaves the caller's state untouched. This is the same distinction
 * `window.prompt()` drew, and every call site already reads `=== null`.
 */
export type PromptFn = (request: PromptRequest) => Promise<string | null>;

export const PromptContext = createContext<PromptFn | null>(null);

export function usePrompt(): PromptFn {
  const prompt = useContext(PromptContext);
  if (!prompt) throw new Error("usePrompt must be used within ConfirmProvider");
  return prompt;
}
