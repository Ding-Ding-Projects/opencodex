/**
 * Material 3 primitives used by the system screens. Deliberately small: the
 * product screens still use the legacy `ui.tsx` primitives, which now read the
 * same `--m3-*` tokens, so both look like one system while the per-screen
 * rewrite proceeds.
 */

import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export function Card({ title, subtitle, actions, children, style }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section className="m3-card" style={style}>
      {(title || actions) && (
        <header className="m3-card-head">
          <div className="m3-card-headtext">
            {title && <h2 className="m3-card-title">{title}</h2>}
            {subtitle && <p className="m3-card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="m3-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = "filled", children, ...rest }: {
  variant?: "filled" | "tonal" | "outlined" | "text" | "danger";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`m3-btn m3-btn--${variant} ${rest.className ?? ""}`.trim()}>
      {children}
    </button>
  );
}

/** Single-select pill group; `role="radiogroup"` because exactly one wins. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="m3-segmented" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`m3-segment${o.value === value ? " selected" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 44px-tall slider so the hit target clears the accessibility floor. */
export function Slider({ value, min, max, step = 1, onChange, label, valueLabel, id }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  valueLabel?: string;
  id?: string;
}) {
  return (
    <div className="m3-slider-row">
      <label className="m3-field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="m3-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={valueLabel}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span className="m3-slider-value">{valueLabel ?? value}</span>
    </div>
  );
}

export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="m3-field">
      <label className="m3-field-label" htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="m3-field-hint">{hint}</p>}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`m3-input ${props.className ?? ""}`.trim()} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`m3-input m3-textarea ${props.className ?? ""}`.trim()} />;
}

export function Chip({ selected, children, onClick, ...rest }: {
  selected?: boolean;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} aria-pressed={selected} onClick={onClick}
      className={`m3-chip${selected ? " selected" : ""} ${rest.className ?? ""}`.trim()}>
      {children}
    </button>
  );
}

/** M3 switch with the `role="switch"` + `aria-checked` pair the contract requires. */
export function Toggle({ on, onChange, label, disabled }: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`m3-switch${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="m3-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="m3-empty">
      <div className="m3-empty-title">{title}</div>
      {children && <div className="m3-empty-body">{children}</div>}
    </div>
  );
}

/**
 * A Material 3 dialog.
 *
 * Built on the native `<dialog>` element rather than a `div` overlay, because
 * `showModal()` gives the things a hand-rolled overlay has to reimplement and
 * usually gets wrong: a real focus trap, Escape, inert background content, and
 * focus restored to whatever opened it. The legacy modals this replaces already
 * used `<dialog>` — each one repeating the same `showModal()` effect inline, in
 * fifteen files. That effect lives here now.
 *
 * Anatomy follows M3: a scrim, a surface-container-high container at 28px
 * radius, headline, supporting text, and actions aligned to the end. The sheet
 * it replaces was liquid glass — `backdrop-filter: blur(40px)` over hardcoded
 * rgba — which is the parallel design language the M3 rule exists to remove.
 *
 * `onClose` fires for every dismissal route: Escape, the scrim, and a close
 * button. A caller that must not be dismissed casually should not use this.
 *
 * ## modal vs non-modal
 *
 * A blocking dialog is reserved for a decision the user must make before
 * continuing — a confirmation, a destructive gate, a credential step. Content
 * the user merely *opened to read* (a request detail, a help panel) is not a
 * decision, and halting the whole app to show it is the thing the
 * non-blocking rule exists to prevent. Those pass `modal={false}`, which uses
 * `show()` instead of `showModal()`: it still floats above the page and still
 * closes on its own button, but it does not trap focus or inert the background,
 * so the user can keep working with it open.
 *
 * Anything that just *reports* an outcome should not be a dialog at all — use
 * `notify()` and let it land as a snackbar.
 */
export function Dialog({
  open = true,
  onClose,
  title,
  description,
  actions,
  children,
  labelledBy,
  width = 520,
  dismissOnScrim = true,
  modal = true,
  id,
  headAction,
  onKeyDown,
}: {
  open?: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Set when the caller renders its own heading and owns the id. */
  labelledBy?: string;
  width?: number;
  /**
   * Clicking the scrim closes by default. Turn it off for a dialog holding
   * unsaved input, where a stray click should not discard what was typed.
   */
  dismissOnScrim?: boolean;
  /**
   * False for content the user opened to read rather than to decide on. Uses
   * `show()`, so the background stays interactive and focus is not trapped.
   */
  modal?: boolean;
  /**
   * Placed on the `<dialog>` itself. Needed when a trigger elsewhere points at
   * this dialog with `aria-controls` — dropping the id leaves that trigger
   * advertising a relationship to an element that is not in the document.
   */
  id?: string;
  /**
   * A trailing control in the header, typically a close button. It must not go
   * inside `title`: the headline is an `<h2>`, so a button nested in it becomes
   * part of the heading's computed text and heading navigation announces
   * "Delete key Close" instead of the title.
   */
  headAction?: ReactNode;
  /**
   * Placed on the `<dialog>` itself, where keyboard events actually land.
   * `showModal()` traps focus natively, but a caller with its own key handling
   * (a wizard stepping on arrow keys, a defensive trap) needs the outer element
   * — a handler on a child never sees an event dispatched at the dialog.
   */
  onKeyDown?: (event: KeyboardEvent<Element>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const generatedTitleId = useId();
  const generatedDescId = useId();
  // A dialog with a visible headline is named by it. Requiring every caller to
  // wire `labelledBy` by hand made "forgot to pass it" the default, and a
  // dialog with no accessible name is announced as just "dialog".
  const titleId = labelledBy ?? (title ? generatedTitleId : undefined);
  // The supporting text is the substance of a confirmation — which credentials
  // are about to be written, which requests are about to be cut off. Focus lands
  // on a button inside the dialog, and a screen reader announces the dialog's
  // *name* plus that button; without this the paragraph carrying the actual
  // consequence is never read out, and the user agrees to a sentence they were
  // not told.
  const descId = description ? generatedDescId : undefined;

  const openerRef = useRef<Element | null>(null);

  // Declared BEFORE the effect that opens the dialog, and that ordering is the
  // whole point: React runs effects in declaration order, so this reads
  // `document.activeElement` while the opener still holds focus. Capturing
  // after `showModal()` would record an element inside the dialog, and
  // "restore focus" would then move focus to something that no longer exists.
  useEffect(() => {
    if (open && openerRef.current === null) openerRef.current = document.activeElement;
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (modal) dialog.showModal();
      else dialog.show();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, modal]);

  // Restore focus on unmount as well as on close.
  //
  // Callers overwhelmingly render `{isOpen && <Dialog …/>}` rather than driving
  // `open={false}`, and removing an open `<dialog>` from the DOM runs the
  // element-removing steps, never the close algorithm — so the browser's own
  // focus restoration never happens and focus silently drops to <body>. Anyone
  // navigating by keyboard then restarts from the top of the page.
  useEffect(() => () => {
    const opener = openerRef.current as { focus?: () => void } | null;
    // Duck-typed rather than `instanceof HTMLElement`: that global does not
    // exist in every environment this renders in, and an unmount cleanup that
    // throws takes the whole unmount with it.
    if (opener && typeof opener.focus === "function" && document.contains(opener as Node)) {
      opener.focus();
    }
  }, []);

  return (
    <dialog
      ref={ref}
      id={id}
      className={`m3-dialog${modal ? "" : " m3-dialog--nonmodal"}`}
      // Explicit, though `showModal()` implies it: the implicit value is not
      // exposed as an attribute, so assistive tech that reads the attribute
      // rather than the computed role — and every test that asserts it — sees
      // nothing without this.
      aria-modal={modal ? "true" : undefined}
      onKeyDown={onKeyDown}
      aria-labelledby={titleId}
      aria-describedby={descId}
      // `cancel` is Escape. Prevent the default close so React state stays the
      // single source of truth for whether this is open — otherwise the element
      // closes itself and the caller still believes it is showing.
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        // A click landing on the dialog element itself is the scrim; anything
        // inside the surface stops at the surface.
        if (dismissOnScrim && event.target === ref.current) onClose();
      }}
    >
      <div className="m3-dialog__surface" style={{ maxWidth: width }}>
        {(title || description || headAction) && (
          <header className="m3-dialog__head">
            <div className="m3-dialog__headtext">
              {title && <h2 className="m3-dialog__title" id={labelledBy ? undefined : generatedTitleId}>{title}</h2>}
              {description && <p className="m3-dialog__desc" id={descId}>{description}</p>}
            </div>
            {headAction && <div className="m3-dialog__headaction">{headAction}</div>}
          </header>
        )}
        {children && <div className="m3-dialog__body">{children}</div>}
        {actions && <div className="m3-dialog__actions">{actions}</div>}
      </div>
    </dialog>
  );
}

/**
 * An inline status banner — Material 3's "inline alert" role, not a snackbar.
 *
 * Replaces the legacy `Notice`, whose two tones ("ok" / "err") could not
 * express a warning at all, so warnings shipped as errors. The four tones here
 * are the same set the notification system uses, so a message reads the same
 * whether it lands inline or as a toast.
 *
 * For anything that merely *reports* an outcome, prefer `notify()` — a
 * non-blocking snackbar. This is for state that belongs permanently beside the
 * thing it describes, which a toast that auto-dismisses cannot carry.
 */
export function Banner({ tone = "info", title, children, action }: {
  tone?: "info" | "success" | "warn" | "error";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`m3-banner m3-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="m3-banner__text">
        {title && <strong className="m3-banner__title">{title}</strong>}
        {children && <div className="m3-banner__body">{children}</div>}
      </div>
      {action && <div className="m3-banner__action">{action}</div>}
    </div>
  );
}

/**
 * A Material 3 select, built on the native `<select>`.
 *
 * The legacy `Select` it replaces was a hand-rolled listbox with a portal, a
 * flip-above-the-viewport calculation and its own keyboard handling — several
 * hundred lines reimplementing what the platform control already does, and
 * doing it worse on a touch device, where the native picker is the one users
 * expect. Where a custom menu is genuinely needed (rich option content, an
 * async list), that is a different component and should say so.
 */
export function SelectField({ value, options, onChange, label, disabled, id, describedBy, style }: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  /**
   * Ids of the copy explaining what this control is currently doing.
   *
   * A select box that merely shows a value implies that value is what will
   * happen — so where a caller renders a status line saying otherwise, the
   * screen-reader user has to reach it from the control rather than by
   * stumbling onto it afterwards.
   */
  describedBy?: string;
  style?: CSSProperties;
}) {
  return (
    <select
      id={id}
      className="m3-select"
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      onChange={event => onChange(event.target.value)}
      style={style}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}
