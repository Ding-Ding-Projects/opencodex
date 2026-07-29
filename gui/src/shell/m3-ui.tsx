/**
 * Material 3 primitives used by the system screens. Deliberately small: the
 * product screens still use the legacy `ui.tsx` primitives, which now read the
 * same `--m3-*` tokens, so both look like one system while the per-screen
 * rewrite proceeds.
 */

import type { CSSProperties, ReactNode } from "react";

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
