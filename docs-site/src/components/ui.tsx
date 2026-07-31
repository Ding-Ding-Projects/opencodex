/**
 * The handful of M3 primitives this site's islands render, and their icons.
 *
 * Deliberately NOT an import of `gui/src/shell/m3-ui.tsx`. That module is a React
 * component file living inside another package: importing it here would resolve
 * its bare `react` specifier by walking up from *its* directory to the repository
 * root rather than to this package's `node_modules`, which is two React copies,
 * two dispatchers, and "Invalid hook call" from every hook in the tree. The
 * dedupe in `astro.config.mjs` covers the modules this site imports directly, and
 * relying on it to also fix a component that reaches into another package's tree
 * is a bet that costs a runtime-only failure when it loses.
 *
 * What IS shared is the thing that actually decides whether the two surfaces look
 * alike: the CSS. Every class below is defined once in `shared/m3/components.css`
 * and rendered by both trees, so the markup being written twice cannot make a
 * chip here a different chip there. Duplicating forty lines of JSX to keep one
 * React instance is the right trade; duplicating the stylesheet would not be.
 *
 * These are intentionally thin — no state, no layout opinions, no `useEffect`.
 * A caller composes them; it never has to restyle them.
 */

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

/* ----------------------------------------------------------------- icons -- */

/**
 * Sized by the class that contains them (`.m3-btn svg`, `.m3-icon-btn svg`),
 * never by a width prop, so a caller cannot accidentally ship a 24px icon into a
 * row of 18px ones. `aria-hidden` on every one: each lives inside a control that
 * already carries the accessible name.
 */
export const Icon = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  /* `.*` over a bracket: the two constructs a reader recognises as "regex" at
     16px, where a full `/…/` literal is unreadable. */
  regex: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 5v14M5 5h3M5 19h3" />
      <path d="M19 5v14M19 5h-3M19 19h-3" />
      <path d="M12 9v6M9.5 10.5l5 3M14.5 10.5l-5 3" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  pin: (
    <svg className="m3-tab-pin" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14 3l7 7-2.1 2.1-1.4-.4-3.6 3.6.5 3.5L12 21l-3.3-3.3L3 21l3.3-5.7L3 12l1.6-1.4 3.5.5 3.6-3.6-.4-1.4z" />
    </svg>
  ),
};

/* ------------------------------------------------------------ primitives -- */

export function Button({ variant = "filled", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "filled" | "tonal" | "outlined" | "text" | "danger";
}) {
  return <button type="button" className={`m3-btn m3-btn--${variant}${className ? ` ${className}` : ""}`} {...rest} />;
}

/** A 44px square control carrying only an icon. The size is the hit-target floor, not a style choice. */
export function IconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`m3-icon-btn${className ? ` ${className}` : ""}`} {...rest} />;
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`m3-input${className ? ` ${className}` : ""}`} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`m3-input m3-textarea${className ? ` ${className}` : ""}`} {...rest} />;
}

/**
 * A label/control/hint stack.
 *
 * `htmlFor` is only emitted when an id was given, because a `<label for>`
 * pointing at nothing is worse than no label element: a screen reader announces
 * the control as unlabelled either way, and the markup claims otherwise.
 */
export function Field({ id, label, hint, children }: {
  id?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="m3-field">
      {id ? <label className="m3-field-label" htmlFor={id}>{label}</label>
          : <span className="m3-field-label">{label}</span>}
      {children}
      {hint ? <p className="m3-field-hint">{hint}</p> : null}
    </div>
  );
}

/**
 * A selectable chip.
 *
 * `aria-pressed` rather than `aria-selected`: these are independent toggles (a
 * regex flag, a scope) and not options within a listbox, and `aria-selected`
 * outside a composite widget is announced inconsistently or not at all.
 */
export function Chip({ selected, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`m3-chip${selected ? " selected" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}
