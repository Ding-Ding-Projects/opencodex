/**
 * The decoration behind "Show emojis in dialogs and message boxes".
 *
 * The setting draws a hard line the rest of this module exists to enforce: the
 * emoji decorates the *message* — a dialog's headline, a snackbar's title — and
 * must never reach a button, an action label, a field label, or anything else
 * that contributes to an accessible name. `decorateMessage` is the one place
 * that line gets drawn, so every caller gets it for free rather than having to
 * remember it per dialog.
 *
 * The mechanism is the same one this codebase already uses for an icon sitting
 * beside a button's text (`<IconRefresh aria-hidden="true" /> {t("startup.refresh")}`
 * in `Settings.tsx`, for one): a decorative node marked `aria-hidden="true"`
 * nested inside an element that supplies an accessible name is excluded from
 * that name's computation, so a screen reader announces the words and nothing
 * about the glyph in front of them. `confirm.tsx`'s dialog title is exactly such
 * an element — it is what `aria-labelledby` points at — which is why the glyph
 * has to live *inside* the title as a hidden sibling rather than beside it.
 *
 * Each mark is chosen to be relevant without being semantic: it tells the reader
 * what *kind* of message this is (a decision, a destructive warning, a finished
 * success) without restating the message itself, and the four tones a Notice or
 * Banner already carries — info, success, warn, error — each get their own,
 * distinct from the two extra kinds a confirmation/prompt dialog needs.
 */

import type { ReactNode } from "react";

export type MessageMarkKind = "info" | "success" | "warn" | "error" | "danger" | "question" | "prompt";

/**
 * One glyph per kind, deliberately not reused across kinds except where two
 * kinds really are the same category under different names: a destructive
 * confirmation (`danger`) and a standing warning (`warn`) both draw attention
 * the same way, so they share a mark — but `error` (something already went
 * wrong) stays visually distinct from both, and `success` and `info` each get
 * their own rather than borrowing a general-purpose checkmark or dot.
 */
const MESSAGE_MARKS: Record<MessageMarkKind, string> = {
  info: "ℹ️", // ℹ️
  success: "✅", // ✅
  warn: "⚠️", // ⚠️
  error: "❌", // ❌
  danger: "⚠️", // ⚠️ — the same alarm as `warn`; both name a hazard.
  question: "❓", // ❓ — a decision the reader has to make.
  prompt: "✏️", // ✏️ — text is being asked for.
};

/** The bare glyph for `kind`, for a caller that wants to place it itself. */
export function messageMark(kind: MessageMarkKind): string {
  return MESSAGE_MARKS[kind];
}

/**
 * `title`, prefixed with `kind`'s glyph when `show` is true — otherwise `title`
 * comes back untouched, same reference and all, so a caller that never enables
 * the setting renders exactly what it always rendered.
 *
 * The glyph sits in its own `aria-hidden` span so it never becomes part of an
 * accessible name computed from this content (see the module doc for why that
 * matters). Nothing here reads user preferences itself — every call site passes
 * its own `show`, resolved from `usePrefs().prefs.showEmojis` — which keeps this
 * module and its callers usable in tests that mount a bare `<Dialog>` or
 * `<SnackbarHost>` with no settings provider in the tree at all.
 */
export function decorateMessage(kind: MessageMarkKind, title: ReactNode, show: boolean): ReactNode {
  if (!show || title === undefined || title === null || title === "") return title;
  return (
    <>
      <span className="m3-emoji" aria-hidden="true">{messageMark(kind)}</span>{" "}
      {title}
    </>
  );
}
