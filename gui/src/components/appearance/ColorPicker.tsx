/**
 * The infinite colour picker, with the full colour-space translator.
 *
 * "Infinite" is the load-bearing word: the primary control is a continuous 2-D
 * chroma/lightness field plus a continuous hue ramp, and every swatch on this
 * panel is a shortcut *layered on* that field rather than an alternative to it.
 * An `<input type="color">` does not satisfy the rule and neither does a grid,
 * however large — that control is swatch-and-spectrum in some browsers and a
 * fixed grid in others, carries no alpha, no colour space, no gamut and no
 * contrast readout, and cannot accept a CSS variable, which is why every call
 * site it replaced had to keep a concrete hex fallback beside it.
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
 * number true in dark mode, and why it recomputes when the theme or seed moves.
 *
 * Accessibility: the canvas is a pointer convenience and the numeric inputs
 * beneath it are the real controls, each independently focusable, labelled and
 * announced. The field is keyboard-operable too (arrows, Page Up/Down, Home/End)
 * so a keyboard user is not forced through the numbers, but nothing is *only*
 * reachable through it.
 *
 * What it deliberately does NOT do: manage its own persistence, or normalise the
 * value it emits. It reports whatever CSS string `toCssValue` produces for the
 * colour the user built — `oklch()` when that colour is outside sRGB, hex when
 * it is not — and the owner decides where that lands.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
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
  toRgb255,
  translate,
  type Color,
} from "../../../../shared/m3/color";
import { computePlacement, fixedPanelStyle } from "../../../../shared/m3/anchor";
import { SEED_SWATCHES } from "../../theme/m3";
import { pushRecentColor, readRecentColors } from "../../theme/recent-colors";
import { usePrefs } from "../../theme/prefs-context";
import { useT } from "../../i18n/shared";
import { Button, Field, TextInput } from "../../shell/m3-ui";
import { IconCopy, IconEyedropper } from "../../icons";

/** Widest chroma the field draws. Beyond this every hue is far outside every gamut. */
const MAX_CHROMA = 0.37;
/** Field resolution. Scaled up by CSS, so this is a cost/detail trade, not a size. */
const FIELD_PX = 168;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The colour the panel opens on when the property it edits is unset. */
const NEUTRAL_START: Color = { l: 0.55, c: 0.12, h: 150, alpha: 1 };

/* ------------------------------------------------------------------ field -- */

/**
 * Paint the chroma/lightness plane for one hue, with the sRGB boundary traced.
 *
 * Written straight into an `ImageData` buffer: `fillRect` per pixel is ~28,000
 * canvas state changes and drops frames while dragging the hue.
 *
 * The boundary contour is drawn by comparing each pixel's gamut with its right
 * and lower neighbour, so it costs one comparison per pixel rather than a second
 * pass, and it lands *on* the last in-gamut pixel — the edge the user can still
 * reach — rather than on the first unreachable one.
 *
 * Every canvas call is guarded. The test runner's DOM has no raster surface at
 * all, and a picker that threw there would take down every test that merely
 * rendered a screen containing one. A missing field is a degraded control; a
 * thrown exception is a broken app.
 */
function paintField(canvas: HTMLCanvasElement, hue: number): void {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx || typeof ctx.createImageData !== "function" || typeof ctx.putImageData !== "function") return;
    const image = ctx.createImageData(FIELD_PX, FIELD_PX);
    const data = image.data;
    if (!data || data.length < FIELD_PX * FIELD_PX * 4) return;
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
        inside[y * FIELD_PX + x] =
          lr >= -1e-4 && lr <= 1.0001 && lg >= -1e-4 && lg <= 1.0001 && lb >= -1e-4 && lb <= 1.0001 ? 1 : 0;
      }
    }

    for (let y = 0; y < FIELD_PX; y++) {
      for (let x = 0; x < FIELD_PX; x++) {
        if (!inside[y * FIELD_PX + x]) continue;
        const right = x + 1 < FIELD_PX ? inside[y * FIELD_PX + x + 1] : 1;
        const below = y + 1 < FIELD_PX ? inside[(y + 1) * FIELD_PX + x] : 1;
        if (right && below) continue;
        const i = (y * FIELD_PX + x) * 4;
        // Contrasting against the pixel it sits on, so the contour is visible on
        // a pale yellow edge and on a deep blue one alike.
        const light = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 > 140;
        data[i] = data[i + 1] = data[i + 2] = light ? 24 : 236;
      }
    }
    ctx.putImageData(image, 0, 0);
  } catch {
    /* No raster surface. The numeric controls below are the real ones. */
  }
}

/* --------------------------------------------------------------- backdrop -- */

interface Backdrop {
  surface: Color;
  onSurface: Color;
}

/**
 * The page's own surface and text colours, for the contrast readout.
 *
 * Read from the live custom properties rather than assumed, because the whole
 * point of the number is what *this* reader will see: the same swatch passes
 * against a light surface and fails against a dark one, and a picker that always
 * measured against white would cheerfully certify unreadable text in dark mode.
 */
function readBackdrop(): Backdrop {
  const fallback: Backdrop = { surface: fromRgb(1, 1, 1), onSurface: fromRgb(0, 0, 0) };
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return fallback;
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

function PickerPanel({ color, onChange }: { color: Color; onChange: (color: Color) => void }) {
  const t = useT();
  // The contrast readout is a claim about the theme the reader is in, so it has
  // to be recomputed when the theme moves — and on the Appearance screen the
  // theme moves while this panel is open, which is exactly when a stale number
  // would be most misleading.
  const { dark, prefs } = usePrefs();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const canonical = toCssValue(color);
  const [text, setText] = useState(canonical);
  const [syncedTo, setSyncedTo] = useState(canonical);
  const [textValid, setTextValid] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecentColors());

  // Re-seed the free-text field when the colour changes from anywhere else — a
  // slider, a swatch, the eyedropper.
  //
  // Adjusted during render rather than in an effect, which is React's own
  // prescription for "state that depends on props": an effect would render the
  // stale string once, then re-render, so the field visibly lags a drag by a
  // frame.
  //
  // The second guard is what keeps it from fighting the user for the field:
  // when what is typed already *means* this colour, it is left exactly as
  // typed, so "oklch(60% .1 200)" is not rewritten to "#…" under the cursor.
  if (syncedTo !== canonical) {
    setSyncedTo(canonical);
    const parsed = parseColor(text);
    if (!parsed || toCssValue(parsed) !== canonical) {
      setText(canonical);
      setTextValid(true);
    }
  }

  useLayoutEffect(() => {
    if (canvasRef.current) paintField(canvasRef.current, color.h);
  }, [color.h]);

  // Recomputed when the theme or seed moves, because the contrast number is a
  // claim about what *this* reader sees and both of those change it.
  //
  // The linter cannot see that dependency: `readBackdrop` takes no arguments and
  // reads `--m3-surface` off the live document, so the values it depends on
  // reach it through the DOM rather than through this closure. Dropping them
  // would freeze the ratio at whatever the theme was when the panel opened,
  // which is exactly the stale number the readout exists to avoid.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const backdrop = useMemo(() => readBackdrop(), [dark, prefs.seed]);
  const composited = useMemo(() => over(color, backdrop.surface), [color, backdrop.surface]);
  const ratioOnSurface = useMemo(() => contrastRatio(composited, backdrop.surface), [composited, backdrop.surface]);
  const ratioAsText = useMemo(() => contrastRatio(composited, backdrop.onSurface), [composited, backdrop.onSurface]);
  const gamut = gamutOf(color);
  const clipped = clipsSrgb(color);
  const clipFar = clipped && clipDistance(color) > 0.03;
  const rows = useMemo(() => translate(color), [color]);

  const commit = useCallback(
    (next: Color) => {
      onChange({
        ...next,
        l: clamp(next.l, 0, 1),
        c: Math.max(0, next.c),
        h: ((next.h % 360) + 360) % 360,
      });
    },
    [onChange],
  );

  /* Pointer on the field. `setPointerCapture` so a drag that leaves the canvas
     keeps steering it — without it the colour freezes the moment the pointer
     crosses the edge, which is most of a fast gesture. */
  const steer = useCallback(
    (event: ReactPointerEvent) => {
      const rect = fieldRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
      commit({ ...color, c: x * MAX_CHROMA, l: 1 - y });
    },
    [color, commit],
  );

  const onFieldKey = (event: ReactKeyboardEvent) => {
    const big = event.key === "PageUp" || event.key === "PageDown";
    const stepC = event.shiftKey ? 0.04 : 0.005;
    const stepL = event.shiftKey ? 0.08 : 0.01;
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
      await navigator.clipboard?.writeText(value);
      setCopied(space);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      // Clipboard access can be refused outright, and there is no clipboard at
      // all outside a browser. The value is selectable in the row either way,
      // so this needs no error surface of its own.
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

  const [r, g, b] = toRgb255(color);
  const cursorLeft = `${(color.c / MAX_CHROMA) * 100}%`;
  const cursorTop = `${(1 - color.l) * 100}%`;

  /** The three numeric controls under the field, in OKLCh's own order. */
  const numbers: { tag: string; value: number; min: number; max: number; step: number; set: (v: number) => void; label: string }[] = [
    { tag: "L", value: color.l * 100, min: 0, max: 100, step: 0.1, set: v => commit({ ...color, l: v / 100 }), label: t("color.lightness") },
    { tag: "C", value: color.c, min: 0, max: MAX_CHROMA, step: 0.001, set: v => commit({ ...color, c: v }), label: t("color.chroma") },
    { tag: "H", value: color.h, min: 0, max: 360, step: 0.1, set: v => commit({ ...color, h: v }), label: t("color.hue") },
  ];

  return (
    <div className="ap-picker">
      <div
        ref={fieldRef}
        className="ap-picker__field"
        // `application` rather than a group: the arrow keys below are the whole
        // point of the control, and a screen reader in browse mode would consume
        // them before the field ever saw one.
        role="application"
        tabIndex={0}
        aria-label={t("color.field")}
        aria-describedby={`${baseId}-fieldhint`}
        onPointerDown={event => {
          (event.target as Element).setPointerCapture?.(event.pointerId);
          steer(event);
        }}
        onPointerMove={event => {
          if (event.buttons) steer(event);
        }}
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
        aria-label={t("color.hue")}
        aria-valuetext={`${Math.round(color.h)}°`}
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
        aria-label={t("color.alpha")}
        aria-valuetext={`${Math.round(color.alpha * 100)}%`}
        style={{ ["--ap-solid" as string]: formatColor({ ...color, alpha: 1 }, "hex") } as CSSProperties}
        onChange={event => onChange({ ...color, alpha: Number(event.target.value) })}
        onPointerUp={remember}
      />

      <div className="ap-picker__numbers">
        {numbers.map(entry => (
          <label key={entry.tag} className="ap-picker__number">
            <span aria-hidden="true">{entry.tag}</span>
            <TextInput
              type="number"
              inputMode="decimal"
              aria-label={entry.label}
              min={entry.min}
              max={entry.max}
              step={entry.step}
              value={Number(entry.value.toFixed(3))}
              onChange={event => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) entry.set(next);
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
          {t("color.contrastAgainst", { name: t("color.contrastSurface") })}:{" "}
          <strong>{ratioOnSurface.toFixed(2)}:1</strong> {contrastGrade(ratioOnSurface)}
        </span>
        <span className="ap-picker__contrast">
          {t("color.contrastAgainst", { name: t("color.contrastText") })}:{" "}
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
            onClick={() => {
              const parsed = parseColor(hex);
              if (parsed) commit({ ...parsed, alpha: color.alpha });
            }}
          />
        ))}
        {hasDropper && (
          <button
            type="button"
            className="ap-picker__iconbtn"
            title={t("color.eyedropper")}
            aria-label={t("color.eyedropper")}
            onClick={pickFromScreen}
          >
            <IconEyedropper width={18} height={18} aria-hidden="true" />
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
              onClick={() => {
                const parsed = parseColor(value);
                if (parsed) commit(parsed);
              }}
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
              <Button
                variant="text"
                aria-label={t("color.copy", { space: row.label })}
                onClick={() => copy(row.value, row.space)}
              >
                {copied === row.space ? t("color.copied") : <IconCopy width={16} height={16} aria-hidden="true" />}
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
  /** Shown under the control; usually a capability note. */
  hint?: string;
  /**
   * Placed on the trigger button. Needed by a host that focuses its first
   * control by id when it opens — the tab editor does exactly that, and an id
   * that lands on no element makes the auto-focus silently stop working.
   */
  id?: string;
}

/**
 * A colour control: a swatch trigger, its value, and the picker anchored to it.
 *
 * Positioned `fixed` from viewport coordinates rather than absolutely inside the
 * trigger's wrapper, because every surface this opens on is a scroll container —
 * the Appearance screen's page body, the tab editor's own panel — and an
 * absolutely positioned descendant is clipped at that container's edge. The
 * placement is recomputed on scroll and resize so the panel stays attached.
 *
 * Focus returns to the trigger on close, always: the panel is non-modal, so a
 * keyboard user who dismisses it would otherwise be dropped at the top of the
 * document with no idea where they had been.
 */
/**
 * The anchored panel, mounted only while it is open.
 *
 * Split out rather than rendered conditionally inside `ColorField` so the
 * placement state is created and destroyed with the panel. A placement kept
 * across a close has to be cleared on the way out, and clearing it is a
 * synchronous state write in an effect — the thing that causes the extra render
 * pass this repository's other popover avoids the same way.
 */
function ColorPopover({ color, onChange, anchorRef, fieldId }: {
  color: Color;
  onChange: (color: Color) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  /** The owning field's id; the panel points its description at that label. */
  fieldId: string;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);

  // Measured after the DOM exists and before paint, then re-measured whenever
  // the page moves under it, so the panel stays attached to a trigger that
  // scrolled or a window that resized.
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(
        fixedPanelStyle(
          computePlacement(
            anchor,
            { width: panel.width, height: panel.height },
            { width: window.innerWidth, height: window.innerHeight },
            { align: "start" },
          ),
        ) as CSSProperties,
      );
    };
    reposition();
    window.addEventListener("resize", reposition);
    // Capturing, because the scroller that moves this is usually a panel rather
    // than the window, and those scroll events do not bubble.
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  return (
    <div
      ref={panelRef}
      className="ap-popover"
      // `dialog` with no `aria-modal`: nothing behind this is inert, and
      // claiming otherwise tells a screen reader the page is unavailable.
      role="dialog"
      aria-label={t("color.title")}
      aria-describedby={`${fieldId}-label`}
      data-placed={placement ? "yes" : "no"}
      style={placement ?? undefined}
    >
      <PickerPanel color={color} onChange={onChange} />
    </div>
  );
}

export function ColorField({ label, value, onChange, hint, id: triggerId }: ColorFieldProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const color = useMemo(() => parseColor(value ?? "") ?? null, [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stopped so one Escape closes one layer: without this the same keypress
      // reaches the tab editor behind and shuts both, which reads as the editor
      // closing at random.
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
          id={triggerId}
          type="button"
          className="ap-colorfield__trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={`${id}-label`}
          // The value is part of the control's name, not decoration: without it
          // a screen reader announces six identical "Text colour" buttons and
          // never says what any of them is set to.
          aria-describedby={`${id}-value`}
          onClick={() => setOpen(o => !o)}
        >
          <span
            className="ap-colorfield__chip"
            style={value ? { background: value } : undefined}
            data-empty={value ? undefined : ""}
            aria-hidden="true"
          />
          <span className="ap-colorfield__value" id={`${id}-value`}>{value ?? t("ap.inherits")}</span>
        </button>
        {value != null && (
          <Button variant="text" aria-label={t("ap.resetOne", { name: label })} onClick={() => onChange(undefined)}>
            {t("ap.reset")}
          </Button>
        )}
      </div>
      {hint ? <p className="m3-field-hint">{hint}</p> : null}

      {open && (
        <ColorPopover
          color={color ?? NEUTRAL_START}
          onChange={next => onChange(toCssValue(next))}
          anchorRef={triggerRef}
          fieldId={id}
        />
      )}
    </div>
  );
}
