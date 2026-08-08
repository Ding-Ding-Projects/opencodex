/*
 * What is left of the pre-M3 primitive set.
 *
 * `Tooltip` is the only survivor. Everything else that lived here now has a
 * Material 3 counterpart in `shell/m3-ui.tsx`, and the call sites moved:
 *
 *   Switch      -> Toggle       (role="switch" + aria-checked, 52x32 anatomy)
 *   Select      -> SelectField  (the native control, themed)
 *   Notice      -> Banner, for page state that stays until the condition clears,
 *                  or notify(), for an outcome that should time itself out
 *   EmptyState  -> Empty
 *
 * `Notice` in particular could only be "ok" or "err", so every warning this app
 * had shipped as an error. `Banner` carries the same four tones the notification
 * system does, which is why the tone had to be re-decided per site rather than
 * mechanically renamed.
 *
 * `Tooltip` has no M3 replacement yet and one live caller (the shadow-call hint
 * on the Models screen), so it stays here rather than being half-deleted.
 * Deliberately not attempted here: writing an M3 tooltip. That needs anchoring,
 * collision handling and a touch story, and inventing it as a side effect of a
 * deletion pass would be a worse component than the one it replaced.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/* Hover/focus tooltip — styled replacement for the native `title` attribute. */
export function Tooltip({ content, children, side = "top", maxWidth = 280 }: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  maxWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 150);
  };
  const hide = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    setOpen(false);
  };
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      className="ocx-tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={event => {
        if (event.key === "Escape") hide();
      }}
      aria-describedby={open ? tipId : undefined}
      style={{ display: "inline", border: 0, background: "transparent", padding: 0, margin: 0, color: "inherit", font: "inherit", cursor: "inherit" }}
    >
      {children}
      {open && (
        <span id={tipId} className={`ocx-tooltip-bubble ocx-tooltip-bubble--${side}`} role="tooltip" style={{ maxWidth }}>
          {content}
        </span>
      )}
    </button>
  );
}
