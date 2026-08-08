/**
 * The typography model behind the word-processor-depth editor.
 *
 * One `TypographyStyle` describes everything the rules ask a text editor to
 * offer — family, size, variable axes, weight, italic and oblique, three
 * underline properties, single and double strikethrough, overline, capitalization
 * and small caps, super/subscript, colour, highlight, outline, shadow, glow,
 * character and word spacing, line height, baseline offset, direction and
 * alignment — and `typographyCss` turns it into CSS declarations.
 *
 * The interesting part is `CAPABILITIES`. Several of these properties have no
 * clean CSS expression, and the rule is explicit that an unsupported property
 * "stays visible with a clear platform-capability explanation instead of
 * disappearing or silently dropping a saved value". So each one carries a
 * capability record naming what it maps to and what it cannot promise, and the
 * editor renders that beside the control rather than hiding it. The check is
 * `CSS.supports` where a browser exists and `"unknown"` where one does not — a
 * test runner has no rendering engine, and reporting "unsupported" there would
 * teach the editor to hide controls that work perfectly in a browser.
 *
 * `typographyCss` returns a plain record of camelCase CSS property names, which
 * is assignable to React's `CSSProperties` and also to `Object.assign(el.style,
 * …)`. It deliberately returns *only* the properties the style actually sets:
 * writing `letterSpacing: "normal"` for an unset value would override an
 * inherited one, which is the opposite of what "unset" means here.
 *
 * Deliberately NOT here: font *enumeration* (see `fonts.ts` — it needs a
 * browser), persistence, and any default values. A style with no `size` renders
 * at whatever the cascade says, and the editor shows "inherits" rather than a
 * number, because storing a copy of today's default stops the element following
 * a theme the user changes tomorrow.
 */

export type CapsMode = "none" | "uppercase" | "lowercase" | "capitalize" | "small-caps" | "all-small-caps";
export type ScriptMode = "none" | "super" | "sub";
export type SlantMode = "none" | "italic" | "oblique";
export type UnderlineStyle = "none" | "solid" | "double" | "dotted" | "dashed" | "wavy";
export type StrikeMode = "none" | "single" | "double";
export type TextAlign = "start" | "center" | "end" | "justify";
export type TextDirection = "ltr" | "rtl";

export interface TypographyStyle {
  /** A full CSS font stack, not a bare family name — see `fonts.ts`. */
  family?: string;
  /** Size in px. Free entry and stepped both write this. */
  size?: number;
  weight?: number;
  slant?: SlantMode;
  /** Degrees for `oblique`; ignored for the other slants. */
  obliqueAngle?: number;
  /** Variable-font axis tags to values, e.g. `{ wdth: 87.5, opsz: 14 }`. */
  axes?: Record<string, number>;
  underline?: UnderlineStyle;
  underlineColor?: string;
  underlineThickness?: number;
  strike?: StrikeMode;
  overline?: boolean;
  caps?: CapsMode;
  script?: ScriptMode;
  color?: string;
  highlight?: string;
  outlineWidth?: number;
  outlineColor?: string;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  glowBlur?: number;
  glowColor?: string;
  letterSpacing?: number;
  wordSpacing?: number;
  lineHeight?: number;
  /** Baseline shift in px; positive raises. Inline-level elements only. */
  baselineShift?: number;
  direction?: TextDirection;
  align?: TextAlign;
}

/** Every key a `TypographyStyle` may carry, for reset-all and for validation. */
export const TYPOGRAPHY_KEYS = [
  "family", "size", "weight", "slant", "obliqueAngle", "axes",
  "underline", "underlineColor", "underlineThickness", "strike", "overline",
  "caps", "script", "color", "highlight",
  "outlineWidth", "outlineColor", "shadowX", "shadowY", "shadowBlur", "shadowColor",
  "glowBlur", "glowColor",
  "letterSpacing", "wordSpacing", "lineHeight", "baselineShift", "direction", "align",
] as const satisfies readonly (keyof TypographyStyle)[];

/* ------------------------------------------------------------ capability -- */

export type CapabilityState = "supported" | "partial" | "unsupported" | "unknown";

export interface Capability {
  /** The `TypographyStyle` key, or a group of them, this describes. */
  id: string;
  /** The CSS this property compiles to, shown to the user verbatim. */
  css: string;
  /** What the platform cannot promise. Empty when there is nothing to warn about. */
  caveat: string;
  /** A declaration the engine either understands or does not. */
  probe?: [property: string, value: string];
  /** Set when the caveat holds even where the probe passes. */
  degraded?: boolean;
}

/**
 * What each control maps to, and where the mapping is imperfect.
 *
 * Written as data rather than as comments in the editor so the explanation the
 * user reads is the same string a test can assert on — a capability note that
 * lives only in JSX drifts out of step with the CSS it describes and nobody
 * finds out.
 */
export const CAPABILITIES: readonly Capability[] = [
  { id: "family", css: "font-family", caveat: "" },
  { id: "size", css: "font-size", caveat: "" },
  { id: "weight", css: "font-weight", caveat: "A static face renders only the weights it ships; the browser may synthesise the rest." },
  { id: "slant", css: "font-style: italic | oblique <angle>", caveat: "A family with no italic face is slanted synthetically.", probe: ["font-style", "oblique 12deg"] },
  { id: "axes", css: "font-variation-settings", caveat: "Only a variable font exposes axes; a static face ignores every one of them.", probe: ["font-variation-settings", "'wght' 400"] },
  { id: "underline", css: "text-decoration-line / -style", caveat: "", probe: ["text-decoration-style", "wavy"] },
  { id: "underlineColor", css: "text-decoration-color", caveat: "", probe: ["text-decoration-color", "red"] },
  { id: "underlineThickness", css: "text-decoration-thickness", caveat: "", probe: ["text-decoration-thickness", "2px"] },
  { id: "strike", css: "text-decoration-line: line-through (+ -style: double)", caveat: "Double strike shares one decoration-style with the underline, so a wavy underline and a double strike cannot both be shown.", degraded: true },
  { id: "overline", css: "text-decoration-line: overline", caveat: "" },
  { id: "caps", css: "text-transform / font-variant-caps", caveat: "Small caps are synthesised when the family ships no small-cap glyphs.", probe: ["font-variant-caps", "all-small-caps"] },
  { id: "script", css: "font-variant-position, with vertical-align fallback", caveat: "Real super/subscript glyphs need a family that ships them; otherwise the text is shifted and scaled.", probe: ["font-variant-position", "super"], degraded: true },
  { id: "color", css: "color", caveat: "" },
  { id: "highlight", css: "background-color", caveat: "Paints the element's whole box, not only the glyph runs — CSS has no text-only highlight outside ::selection." , degraded: true },
  { id: "outlineWidth", css: "-webkit-text-stroke", caveat: "Non-standard, though every current engine implements it. The stroke is centred on the glyph edge, so a heavy outline eats into the letterform.", probe: ["-webkit-text-stroke-width", "1px"] },
  { id: "shadowX", css: "text-shadow", caveat: "" },
  { id: "glowBlur", css: "text-shadow with no offset", caveat: "Shares the `text-shadow` property with the drop shadow; both are emitted as one comma-separated list.", degraded: true },
  { id: "letterSpacing", css: "letter-spacing", caveat: "" },
  { id: "wordSpacing", css: "word-spacing", caveat: "" },
  { id: "lineHeight", css: "line-height", caveat: "" },
  { id: "baselineShift", css: "vertical-align: <length>", caveat: "Applies to inline-level elements only; a block-level target ignores it entirely.", degraded: true },
  { id: "direction", css: "direction + unicode-bidi", caveat: "" },
  { id: "align", css: "text-align", caveat: "" },
];

export const CAPABILITY_BY_ID: Readonly<Record<string, Capability>> =
  Object.fromEntries(CAPABILITIES.map(c => [c.id, c]));

/**
 * Whether this engine implements the property behind a control.
 *
 * `"unknown"` where there is no `CSS.supports` — a server render, a test runner,
 * a very old engine. The editor must keep the control visible in that case: a
 * missing API is not evidence the feature is missing, and hiding a working
 * control because the probe was unavailable is the failure mode the rule names.
 */
export function capabilityState(id: string): CapabilityState {
  const capability = CAPABILITY_BY_ID[id];
  if (!capability) return "unknown";
  if (!capability.probe) return capability.degraded ? "partial" : "supported";
  const supports = (globalThis as { CSS?: { supports?(p: string, v: string): boolean } }).CSS?.supports;
  if (typeof supports !== "function") return "unknown";
  let ok = false;
  try {
    ok = supports.call((globalThis as { CSS?: unknown }).CSS, capability.probe[0], capability.probe[1]);
  } catch {
    return "unknown";
  }
  if (!ok) return "unsupported";
  return capability.degraded ? "partial" : "supported";
}

/* ---------------------------------------------------------------- to CSS -- */

const px = (v: number) => `${v}px`;

/**
 * A `TypographyStyle` as CSS declarations.
 *
 * Only what the style sets. Three properties are shared by more than one
 * control and so are assembled rather than assigned:
 *
 *  - `text-decoration-line` collects underline, strike and overline. Emitting
 *    three separate declarations would have each overwrite the last, so turning
 *    on an overline would silently remove the underline.
 *  - `text-decoration-style` is single-valued in CSS, so a wavy underline and a
 *    double strike genuinely cannot coexist. `strike: "double"` wins when both
 *    are asked for, and `CAPABILITIES` says so where the user can read it.
 *  - `text-shadow` carries both the drop shadow and the glow, comma-separated.
 */
export function typographyCss(style: TypographyStyle | undefined): Record<string, string> {
  if (!style) return {};
  const css: Record<string, string> = {};

  if (style.family) css.fontFamily = style.family;
  if (style.size != null) css.fontSize = px(style.size);
  if (style.weight != null) css.fontWeight = String(style.weight);
  if (style.slant && style.slant !== "none") {
    css.fontStyle = style.slant === "oblique" && style.obliqueAngle != null
      ? `oblique ${style.obliqueAngle}deg`
      : style.slant;
  }
  if (style.axes && Object.keys(style.axes).length) {
    css.fontVariationSettings = Object.entries(style.axes)
      .map(([tag, value]) => `"${tag}" ${value}`)
      .join(", ");
  }

  const lines: string[] = [];
  if (style.underline && style.underline !== "none") lines.push("underline");
  if (style.strike && style.strike !== "none") lines.push("line-through");
  if (style.overline) lines.push("overline");
  if (lines.length) {
    css.textDecorationLine = lines.join(" ");
    // `strike: "double"` needs `text-decoration-style: double`, and so does a
    // double underline. When they disagree the strike wins, because a strike is
    // a stronger statement about the text than an underline's texture.
    const decorationStyle = style.strike === "double"
      ? "double"
      : style.underline && style.underline !== "none" && style.underline !== "solid"
        ? style.underline
        : null;
    if (decorationStyle) css.textDecorationStyle = decorationStyle;
    if (style.underlineColor) css.textDecorationColor = style.underlineColor;
    if (style.underlineThickness != null) css.textDecorationThickness = px(style.underlineThickness);
  }

  if (style.caps && style.caps !== "none") {
    if (style.caps === "small-caps" || style.caps === "all-small-caps") css.fontVariantCaps = style.caps;
    else css.textTransform = style.caps;
  }

  if (style.script && style.script !== "none") {
    css.fontVariantPosition = style.script;
    // The fallback for a family with no positioned glyphs. Emitted always, not
    // only when the probe fails: `font-variant-position` silently does nothing
    // for a face that lacks the feature, and there is no way to detect that from
    // script — so the visible shift is the honest floor and the OpenType feature
    // is the improvement on top of it.
    css.verticalAlign = style.script;
    css.fontSize = style.size != null ? px(style.size * 0.75) : "0.75em";
  }

  if (style.color) css.color = style.color;
  if (style.highlight) css.backgroundColor = style.highlight;

  if (style.outlineWidth != null && style.outlineWidth > 0) {
    css.webkitTextStrokeWidth = px(style.outlineWidth);
    css.webkitTextStrokeColor = style.outlineColor || "currentColor";
  }

  const shadows: string[] = [];
  if (style.shadowBlur != null || style.shadowX != null || style.shadowY != null) {
    shadows.push(`${px(style.shadowX ?? 0)} ${px(style.shadowY ?? 1)} ${px(style.shadowBlur ?? 2)} ${style.shadowColor || "rgba(0,0,0,.4)"}`);
  }
  if (style.glowBlur != null && style.glowBlur > 0) {
    shadows.push(`0 0 ${px(style.glowBlur)} ${style.glowColor || "currentColor"}`);
  }
  if (shadows.length) css.textShadow = shadows.join(", ");

  if (style.letterSpacing != null) css.letterSpacing = px(style.letterSpacing);
  if (style.wordSpacing != null) css.wordSpacing = px(style.wordSpacing);
  if (style.lineHeight != null) css.lineHeight = String(style.lineHeight);
  if (style.baselineShift != null) css.verticalAlign = px(style.baselineShift);
  if (style.direction) {
    css.direction = style.direction;
    // Without this the direction property alone only reorders the *base*
    // direction of a paragraph, and mixed-script text ignores the setting.
    css.unicodeBidi = "isolate";
  }
  if (style.align) css.textAlign = style.align;

  return css;
}

/**
 * The same declarations as a kebab-case CSS block, for the stylesheet channel.
 *
 * `webkitTextStrokeWidth` has to become `-webkit-text-stroke-width` — a leading
 * capital in the camelCase name means a leading dash, which the naive
 * `replace(/[A-Z]/…)` gets wrong by producing `webkit-text-stroke-width`, a
 * property that does not exist and fails silently.
 */
export function cssText(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .filter(([, value]) => isSafeDeclarationValue(value))
    .map(([prop, value]) => `${kebab(prop)}: ${value};`)
    .join(" ");
}

/**
 * Whether a value can be concatenated into a stylesheet without escaping it.
 *
 * The per-property channel (`Object.assign(el.style, …)`, React's
 * `CSSProperties`) is safe by construction: the engine parses each value on its
 * own and simply rejects junk. A generated `<style>` block is not — there, a
 * value carrying `;` or `}` closes the declaration and the rule, and everything
 * after it is parsed as new CSS against whatever selector the attacker wrote.
 *
 * `readTypography` cannot close this on its own: it validates *stored* values,
 * and a family name typed into the picker's free-text field never passes through
 * it. So the check lives here, at the one function whose whole purpose is
 * building stylesheet text.
 *
 * A rejected declaration is dropped rather than escaped. Escaping would have to
 * be per-property — a font family is a CSS string, a colour is not — and a
 * half-right escaper is how the hole gets reopened. Dropping means the property
 * visibly does not apply, which is a bug report rather than a silent breach.
 */
function isSafeDeclarationValue(value: string): boolean {
  return !/[;{}<>\\]/.test(value) && !value.includes("/*") && !/url\s*\(/i.test(value);
}

export function kebab(prop: string): string {
  const dashed = prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
  return prop.startsWith("webkit") ? `-${dashed}` : dashed;
}

/* -------------------------------------------------------------- validation -- */

const clampNum = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * Everything in a stored style that is still a value this can render.
 *
 * Every number is clamped and every enum is checked, because these land straight
 * in a `style` attribute: a hand-edited or corrupted entry must not be able to
 * set `font-size: 1e9px` and leave the reader with a page they cannot navigate
 * back from. Unknown keys are dropped rather than passed through — the same
 * reason.
 */
export function readTypography(raw: unknown): TypographyStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const style: TypographyStyle = {};

  const str = (key: "family" | "color" | "highlight" | "underlineColor" | "outlineColor" | "shadowColor" | "glowColor") => {
    const value = input[key];
    if (typeof value === "string" && value.trim()) style[key] = value.trim().slice(0, 200);
  };
  str("family"); str("color"); str("highlight");
  str("underlineColor"); str("outlineColor"); str("shadowColor"); str("glowColor");

  const n = (key: "size" | "weight" | "obliqueAngle" | "underlineThickness" | "outlineWidth"
    | "shadowX" | "shadowY" | "shadowBlur" | "glowBlur" | "letterSpacing" | "wordSpacing"
    | "lineHeight" | "baselineShift", lo: number, hi: number) => {
    if (input[key] == null) return;
    const value = clampNum(input[key], lo, hi);
    if (value != null) style[key] = value;
  };
  n("size", 6, 200);
  n("weight", 1, 1000);
  n("obliqueAngle", -90, 90);
  n("underlineThickness", 0, 20);
  n("outlineWidth", 0, 20);
  n("shadowX", -40, 40);
  n("shadowY", -40, 40);
  n("shadowBlur", 0, 60);
  n("glowBlur", 0, 60);
  n("letterSpacing", -10, 40);
  n("wordSpacing", -20, 80);
  n("lineHeight", 0.5, 4);
  n("baselineShift", -40, 40);

  style.slant = oneOf(input.slant, ["none", "italic", "oblique"] as const);
  style.underline = oneOf(input.underline, ["none", "solid", "double", "dotted", "dashed", "wavy"] as const);
  style.strike = oneOf(input.strike, ["none", "single", "double"] as const);
  style.caps = oneOf(input.caps, ["none", "uppercase", "lowercase", "capitalize", "small-caps", "all-small-caps"] as const);
  style.script = oneOf(input.script, ["none", "super", "sub"] as const);
  style.direction = oneOf(input.direction, ["ltr", "rtl"] as const);
  style.align = oneOf(input.align, ["start", "center", "end", "justify"] as const);
  if (input.overline === true) style.overline = true;

  if (input.axes && typeof input.axes === "object") {
    const axes: Record<string, number> = {};
    for (const [tag, value] of Object.entries(input.axes as Record<string, unknown>)) {
      // An OpenType axis tag is exactly four characters. Anything else in the
      // key would be injected verbatim into `font-variation-settings`.
      if (!/^[\x20-\x7e]{4}$/.test(tag)) continue;
      const n = clampNum(value, -10000, 10000);
      if (n != null) axes[tag] = n;
    }
    if (Object.keys(axes).length) style.axes = axes;
  }

  for (const key of Object.keys(style) as (keyof TypographyStyle)[]) {
    if (style[key] === undefined) delete style[key];
  }
  return Object.keys(style).length ? style : undefined;
}

/** True when nothing is set — used to disable "reset" rather than hide it. */
export function isEmptyTypography(style?: TypographyStyle): boolean {
  return !style || Object.keys(style).length === 0;
}
