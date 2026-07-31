/**
 * The infinite colour picker, with the full colour-space translator.
 *
 * "Infinite" is the load-bearing word: the primary control is a continuous 2-D
 * chroma/lightness field plus a continuous hue ramp, and every swatch on this
 * panel is a shortcut *layered on* that field rather than an alternative to it.
 * A `<input type="color">` does not satisfy the rule and neither does a grid,
 * however large.
 *
 * The field is a canvas rather than stacked CSS gradients, and that is not
 * decoration. Gradients composite in sRGB, so an OKLCh field drawn with them is
 * wrong in the middle of every ramp — the exact region a person drags through.
 * More importantly a gradient cannot show where sRGB *ends*: the canvas draws
 * the clipped colour beyond the boundary and traces a contour along it, so the
 * user can see the edge they are about to walk over instead of discovering it
 * later when the colour they picked comes out different.
 *
 * Every readout is computed, never asserted. The gamut name, the clipping
 * warning, the contrast ratio and its WCAG grade all come from
 * `shared/m3/color.ts`, and the contrast backdrop is read out of the live
 * `--m3-surface` token rather than assumed to be white — which is what makes the
 * number true in dark mode.
 *
 * Accessibility: the canvas is a pointer convenience and the four numeric
 * sliders beneath it are the real controls, each independently focusable,
 * labelled and announced. The canvas is keyboard-operable too (arrows, Page
 * Up/Down, Home/End) so a keyboard user is not forced through the numbers, but
 * nothing is *only* reachable through it.
 *
 * What it deliberately does NOT do: manage its own persistence, or normalise the
 * value it emits. It reports whatever CSS string `toCssValue` produces for the
 * colour the user built — `oklch()` when that colour is outside sRGB, hex when
 * it is not — and the owner decides where that lands.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  clipDistance,
  clipsSrgb,
  contrastGrade,
  contrastRatio,
  formatColor,
  fromRgb,
  gamutOf,
  oklabToLinear,
  over,
  parseColor,
  toCssValue,
  toRgb,
  translate,
  type Color,
} from "../../../../shared/m3/color";
import { computePlacement } from "../../../../shared/m3/anchor";
import { SEED_SWATCHES } from "../../../../shared/m3/tokens";
import { pushRecentColor, readRecentColors } from "../../lib/element-styles";
import type { TFn } from "../../lib/strings";
// Only the primitives whose classes already exist in `shared/m3/components.css`.
// `IconButton`/`TextArea` are in `ui.tsx` but their `.m3-icon-btn` /
// `.m3-textarea` rules are being added by another stage; using them now would
// ship two unstyled controls, and defining those classes here as well would put
// the same selector in two stylesheets and make which one wins a load-order
// accident. The two icon-only buttons this panel needs carry `ap-` classes.
import { Button, Field, TextInput } from "../ui";

const CopyIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
);

/** Widest chroma the field draws. Beyond this every hue is far outside every gamut. */
const MAX_CHROMA = 0.37;
/** Field resolution. Scaled up by CSS, so this is a cost/detail trade, not a size. */
const FIELD_PX = 168;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ field -- */

/**
 * Paint the chroma/lightness plane for one hue, with the sRGB boundary traced.
 *
 * Written straight into an `ImageData` buffer: `fillRect` per pixel is ~28,000
 * canvas state changes and drops frames on a phone while dragging the hue.
 *
 * The boundary contour is drawn by comparing each pixel's gamut with its left
 * and upper neighbour, so it costs one comparison per pixel rather than a second
 * pass, and it lands *on* the last in-gamut pixel — the edge the user can still
 * reach — rather than on the first unreachable one.
 */
function paintField(canvas: HTMLCanvasElement, hue: number): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) return;
  const image = ctx.createImageData(FIELD_PX, FIELD_PX);
  const data = image.data;
  const rad = (hue * Math.PI) / 180;
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);
  const inside = new Uint8Array(FIELD_PX * FIELD_PX);

  for (let y = 0; y < FIELD_PX; y++) {
    const L = 1 - y / (FIELD_PX - 1);
    for (let x = 0; x < FIELD_PX; x++) {
      const c = (x / (FIELD_PX - 1)) * MAX_CHROMA;
      const [lr, lg, lb] = oklabToLinear(L, c * cosH, c * sinH);
      const to8 = (v: number) => {
        const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.abs(v) ** (1 / 2.4) - 0.055;
        return clamp(s, 0, 1) * 255;
      };
      const i = (y * FIELD_PX + x) * 4;
      data[i] = to8(lr);
      data[i + 1] = to8(lg);
      data[i + 2] = to8(lb);
      data[i + 3] = 255;
      inside[y * FIELD_PX + x] = lr >= -1e-4 && lr <= 1.0001 && lg >= -1e-4 && lg <= 1.0001 && lb >= -1e-4 && lb <= 1.0001 ? 1 : 0;
    }
  }

  for (let y = 0; y < FIELD_PX; y++) {
    for (let x = 0; x < FIELD_PX; x++) {
      const here = inside[y * FIELD_PX + x];
      if (!here) continue;
      const right = x + 1 < FIELD_PX ? inside[y * FIELD_PX + x + 1] : 1;
      const below = y + 1 < FIELD_PX ? inside[(y + 1) * FIELD_PX + x] : 1;
      if (right && below) continue;
      const i = (y * FIELD_PX + x) * 4;
      // Contrasting against the pixel it sits on, so the contour is visible on a
      // pale yellow edge and on a deep blue one alike.
      const light = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 > 140;
      data[i] = data[i + 1] = data[i + 2] = light ? 24 : 236;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/* --------------------------------------------------------------- backdrop -- */

/**
 * The page's own surface and text colours, for the contrast readout.
 *
 * Read from the live custom properties rather than assumed, because the whole
 * point of the number is what *this* reader will see: the same swatch passes
 * against a light surface and fails against a dark one, and a picker that
 * always measured against white would cheerfully certify unreadable text in
 * dark mode.
 */
function readBackdrop(): { surface: Color; onSurface: Color } {
  const fallback = { surface: fromRgb(1, 1, 1), onSurface: fromRgb(0, 0, 0) };
  if (typeof getComputedStyle !== "function") return fallback;
  try {
    const style = getComputedStyle(document.documentElement);
    return {
      surface: parseColor(style.getPropertyValue("--m3-surface").trim()) ?? fallback.surface,
      onSurface: parseColor(style.getPropertyValue("--m3-on-surface").trim()) ?? fallback.onSurface,
    };
  } catch {
    return fallback;
  }
}

/* ----------------------------------------------------------------- panel -- */

interface PanelProps {
  color: Color;
  onChange: (color: Color) => void;
  t: TFn;
}

function PickerPanel({ color, onChange, t }: PanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [text, setText] = useState(() => toCssValue(color));
  const [textValid, setTextValid] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecentColors());

  // Re-seed the free-text field when the colour changes from anywhere else —
  // a slider, a swatch, the eyedropper. Guarded on the *parsed* value, not the
  // string, so typing "oklch(60% .1 200)" is not rewritten to "#…" under the
  // cursor on every keystroke.
  useEffect(() => {
    const parsed = parseColor(text);
    if (parsed && parsed.l === color.l && parsed.c === color.c && parsed.h === color.h && parsed.alpha === color.alpha) return;
    setText(toCssValue(color));
    setTextValid(true);
    // `text` is deliberately absent: including it would re-run on every keystroke
    // and fight the user for the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color.l, color.c, color.h, color.alpha]);

  useLayoutEffect(() => {
    if (canvasRef.current) paintField(canvasRef.current, color.h);
  }, [color.h]);

  const backdrop = useMemo(readBackdrop, []);
  const composited = useMemo(() => over(color, backdrop.surface), [color, backdrop.surface]);
  const ratioOnSurface = useMemo(() => contrastRatio(composited, backdrop.surface), [composited, backdrop.surface]);
  const ratioAsText = useMemo(() => contrastRatio(composited, backdrop.onSurface), [composited, backdrop.onSurface]);
  const gamut = gamutOf(color);
  const clipped = clipsSrgb(color);
  const clipFar = clipped && clipDistance(color) > 0.03;
  const rows = useMemo(() => translate(color), [color]);

  const commit = useCallback((next: Color) => {
    onChange({ ...next, l: clamp(next.l, 0, 1), c: Math.max(0, next.c), h: ((next.h % 360) + 360) % 360 });
  }, [onChange]);

  /* Pointer on the field. `setPointerCapture` so a drag that leaves the canvas
     keeps steering it — without it the colour freezes the moment the pointer
     crosses the edge, which on a phone is most of the gesture. */
  const steer = useCallback((event: ReactPointerEvent) => {
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    commit({ ...color, c: x * MAX_CHROMA, l: 1 - y });
  }, [color, commit]);

  const onFieldKey = (event: ReactKeyboardEvent) => {
    const big = event.key === "PageUp" || event.key === "PageDown";
    const stepC = (event.shiftKey ? 0.04 : 0.005);
    const stepL = (event.shiftKey ? 0.08 : 0.01);
    let next: Color | null = null;
    if (event.key === "ArrowLeft") next = { ...color, c: Math.max(0, color.c - stepC) };
    else if (event.key === "ArrowRight") next = { ...color, c: Math.min(MAX_CHROMA, color.c + stepC) };
    else if (event.key === "ArrowUp" || event.key === "PageUp") next = { ...color, l: clamp(color.l + (big ? 0.1 : stepL), 0, 1) };
    else if (event.key === "ArrowDown" || event.key === "PageDown") next = { ...color, l: clamp(color.l - (big ? 0.1 : stepL), 0, 1) };
    else if (event.key === "Home") next = { ...color, c: 0 };
    else if (event.key === "End") next = { ...color, c: MAX_CHROMA };
    if (!next) return;
    event.preventDefault();
    commit(next);
  };

  const applyText = (value: string) => {
    setText(value);
    const parsed = parseColor(value);
    setTextValid(!!parsed || value.trim() === "");
    if (parsed) commit(parsed);
  };

  const copy = async (value: string, space: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(space);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      // Clipboard access can be refused outright. The value is selectable in the
      // row either way, so this needs no error surface of its own.
    }
  };

  const pickFromScreen = async () => {
    const Dropper = (window as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!Dropper) return;
    try {
      const result = await new Dropper().open();
      const parsed = parseColor(result.sRGBHex);
      if (parsed) commit({ ...parsed, alpha: color.alpha });
    } catch {
      /* dismissed with Escape */
    }
  };

  const remember = () => setRecent(pushRecentColor(toCssValue(color)));
  const hasDropper = typeof window !== "undefined" && "EyeDropper" in window;

  const [r, g, b] = toRgb(color).map(v => Math.round(clamp(v, 0, 1) * 255));
  const cursorLeft = `${(color.c / MAX_CHROMA) * 100}%`;
  const cursorTop = `${(1 - color.l) * 100}%`;

  return (
    <div className="ap-picker">
      <div
        ref={fieldRef}
        className="ap-picker__field"
        role="application"
        tabIndex={0}
        aria-label={t("color.field")}
        aria-describedby={`${baseId}-fieldhint`}
        onPointerDown={event => { (event.target as Element).setPointerCapture?.(event.pointerId); steer(event); }}
        onPointerMove={event => { if (event.buttons) steer(event); }}
        onPointerUp={remember}
        onKeyDown={onFieldKey}
        onBlur={remember}
      >
        <canvas ref={canvasRef} width={FIELD_PX} height={FIELD_PX} aria-hidden="true" />
        <span className="ap-picker__cursor" style={{ left: cursorLeft, top: cursorTop }} aria-hidden="true" />
      </div>
      <p id={`${baseId}-fieldhint`} className="m3-field-hint">{t("color.fieldHint")}</p>

      <label className="ap-picker__ramp-label" htmlFor={`${baseId}-hue`}>
        {t("color.hue")}
        <span className="ap-picker__num">{Math.round(color.h)}°</span>
      </label>
      <input
        id={`${baseId}-hue`}
        className="ap-picker__ramp ap-picker__ramp--hue"
        type="range"
        min={0}
        max={360}
        step={0.5}
        value={color.h}
        onChange={event => commit({ ...color, h: Number(event.target.value) })}
        onPointerUp={remember}
      />

      <label className="ap-picker__ramp-label" htmlFor={`${baseId}-alpha`}>
        {t("color.alpha")}
        <span className="ap-picker__num">{Math.round(color.alpha * 100)}%</span>
      </label>
      <input
        id={`${baseId}-alpha`}
        className="ap-picker__ramp ap-picker__ramp--alpha"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={color.alpha}
        style={{ ["--ap-solid" as string]: formatColor({ ...color, alpha: 1 }, "hex") }}
        onChange={event => onChange({ ...color, alpha: Number(event.target.value) })}
        onPointerUp={remember}
      />

      <div className="ap-picker__numbers">
        {([
          ["L", color.l * 100, 0, 100, 0.1, (v: number) => commit({ ...color, l: v / 100 }), t("color.lightness")],
          ["C", color.c, 0, MAX_CHROMA, 0.001, (v: number) => commit({ ...color, c: v }), t("color.chroma")],
          ["H", color.h, 0, 360, 0.1, (v: number) => commit({ ...color, h: v }), t("color.hue")],
        ] as const).map(([tag, value, min, max, step, set, label]) => (
          <label key={tag} className="ap-picker__number">
            <span aria-hidden="true">{tag}</span>
            <input
              className="m3-input"
              type="number"
              inputMode="decimal"
              aria-label={label}
              min={min}
              max={max}
              step={step}
              value={Number(value.toFixed(3))}
              onChange={event => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) set(next);
              }}
            />
          </label>
        ))}
        <span className="ap-picker__rgb" aria-hidden="true">{`${r} ${g} ${b}`}</span>
      </div>

      <Field id={`${baseId}-text`} label={t("color.value")} hint={textValid ? t("color.valueHint") : t("color.invalid")}>
        <TextInput
          id={`${baseId}-text`}
          className="m3-input--mono"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!textValid}
          onChange={event => applyText(event.target.value)}
          onBlur={remember}
        />
      </Field>

      <div className="ap-picker__facts">
        <span className={`ap-picker__gamut${clipped ? " warn" : ""}`}>
          {t("color.gamut")}: <strong>{gamut}</strong>
        </span>
        <span className="ap-picker__contrast">
          {t("color.contrast")} {t("color.contrastAgainst", { name: t("color.contrastSurface") })}:{" "}
          <strong>{ratioOnSurface.toFixed(2)}:1</strong> {contrastGrade(ratioOnSurface)}
        </span>
        <span className="ap-picker__contrast">
          {t("color.contrast")} {t("color.contrastAgainst", { name: t("color.contrastText") })}:{" "}
          <strong>{ratioAsText.toFixed(2)}:1</strong> {contrastGrade(ratioAsText)}
        </span>
      </div>
      {clipped && (
        <p className="ap-picker__warn" role="status">{clipFar ? t("color.clipFar") : t("color.clip")}</p>
      )}

      <div className="ap-picker__swatches" role="group" aria-label={t("color.swatches")}>
        {SEED_SWATCHES.map(hex => (
          <button
            key={hex}
            type="button"
            className="ap-picker__swatch"
            style={{ background: hex }}
            title={hex}
            aria-label={hex}
            onClick={() => { const parsed = parseColor(hex); if (parsed) commit({ ...parsed, alpha: color.alpha }); }}
          />
        ))}
        {hasDropper && (
          <button type="button" className="ap-iconbtn" title={t("color.eyedropper")} aria-label={t("color.eyedropper")} onClick={pickFromScreen}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 3a2.8 2.8 0 0 1 4 4l-3 3 1 1-2 2-1-1-7 7-4 1 1-4 7-7-1-1 2-2 1 1 3-3z" />
            </svg>
          </button>
        )}
      </div>

      {recent.length > 0 && (
        <div className="ap-picker__swatches" role="group" aria-label={t("color.recent")}>
          {recent.map(value => (
            <button
              key={value}
              type="button"
              className="ap-picker__swatch"
              style={{ background: value }}
              title={value}
              aria-label={value}
              onClick={() => { const parsed = parseColor(value); if (parsed) commit(parsed); }}
            />
          ))}
        </div>
      )}

      <details className="ap-picker__translator">
        <summary>{t("color.translator")}</summary>
        <ul>
          {rows.map(row => (
            <li key={row.space}>
              <span className="ap-picker__space">{row.label}</span>
              <code>{row.value}</code>
              <Button variant="text" aria-label={t("color.copy", { space: row.label })} onClick={() => copy(row.value, row.space)}>
                {copied === row.space ? t("color.copied") : CopyIcon}
              </Button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/* ----------------------------------------------------------------- field -- */

export interface ColorFieldProps {
  label: string;
  /** Any CSS colour, or `undefined` for "inherits". */
  value: string | undefined;
  /** `undefined` when the user clears it. */
  onChange: (value: string | undefined) => void;
  t: TFn;
  /** Shown under the control; usually a capability note. */
  hint?: string;
}

/**
 * A colour control: a swatch trigger, its value, and the picker anchored to it.
 *
 * Anchored inside the trigger's own wrapper rather than portalled to `<body>`,
 * so it moves with the trigger and can never visually detach from it — the
 * placement maths in `shared/m3/anchor.ts` is written for exactly that
 * arrangement, and it is what makes a popover survive a scrolling panel with no
 * scroll listener to forget.
 *
 * Focus returns to the trigger on close, always: the panel is non-modal, so a
 * keyboard user who dismisses it would otherwise be dropped at the top of the
 * document with no idea where they had been.
 */
export function ColorField({ label, value, onChange, t, hint }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const color = useMemo(() => parseColor(value ?? "") ?? null, [value]);

  /**
   * Viewport coordinates, because the panel is `position: fixed`.
   *
   * `computePlacement` answers in the anchor's own space (it was written for a
   * panel absolutely positioned inside its trigger's wrapper), so the anchor's
   * left is added back. Fixed rather than absolute because this opens inside the
   * element editor, which is a scroll container that would otherwise clip it.
   */
  const place = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    const computed = computePlacement(
      anchor,
      { width: panel.width, height: panel.height },
      { width: window.innerWidth, height: window.innerHeight },
      { align: "start" },
    );
    setPlacement({
      left: anchor.left + computed.left,
      top: computed.side === "above" ? Math.max(8, anchor.top - panel.height - 8) : anchor.bottom + 8,
      maxHeight: computed.maxHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    place();
    window.addEventListener("resize", place);
    // Capturing, because the scroller that moves this is usually the editor
    // panel rather than the window, and those scroll events do not bubble.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stopped so one Escape closes one layer: without this the same keypress
      // reaches the element editor behind and shuts both, which reads as the
      // editor closing at random.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="ap-colorfield" ref={wrapRef}>
      <span className="m3-field-label" id={`${id}-label`}>{label}</span>
      <div className="ap-colorfield__row">
        <button
          ref={triggerRef}
          type="button"
          className="ap-colorfield__trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={`${id}-label`}
          onClick={() => setOpen(o => !o)}
        >
          <span className="ap-colorfield__chip" style={value ? { background: value } : undefined} data-empty={value ? undefined : ""} />
          <span className="ap-colorfield__value">{value ?? t("ap.inherits")}</span>
        </button>
        {value != null && (
          <Button variant="text" aria-label={t("color.clear")} onClick={() => onChange(undefined)}>{t("ap.reset")}</Button>
        )}
      </div>
      {hint ? <p className="m3-field-hint">{hint}</p> : null}

      {open && (
        <div
          ref={panelRef}
          className="ap-popover"
          // `dialog` with no `aria-modal`: nothing behind this is inert, and
          // claiming otherwise tells a screen reader the page is unavailable.
          role="dialog"
          aria-label={t("color.title")}
          data-placed={placement ? "yes" : "no"}
          style={placement ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight } : undefined}
        >
          <PickerPanel
            color={color ?? parseColor("#6750a4")!}
            onChange={next => onChange(toCssValue(next))}
            t={t}
          />
        </div>
      )}
    </div>
  );
}
