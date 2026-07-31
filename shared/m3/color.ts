/**
 * The colour engine behind the infinite picker and its translator.
 *
 * One canonical model, `Color`, in **OKLCh plus alpha**. Everything else is a
 * *representation* of it, produced on demand. That choice is not stylistic:
 *
 *  - The M3 token engine already derives every role token through OKLCh
 *    (`gui/src/theme/m3.ts`), so a picker working in the same space cannot
 *    disagree with the palette it is feeding.
 *  - Hue survives achromatic colours. A model canonicalised to RGB loses the
 *    hue of `#808080` — drag the saturation of a picker to zero and back and the
 *    colour comes back a different hue than it left. Storing `h` explicitly
 *    means the 2-D field can be dragged into the grey axis and out again.
 *  - It is unbounded. sRGB cannot express a Display-P3 red, so a model that
 *    canonicalised to sRGB would silently clip the user's colour on the way in
 *    and there would be nothing left to *warn* about. Clipping is detected here
 *    (`gamutOf`, `clipsSrgb`) precisely because the model does not do it.
 *
 * Everything is pure and synchronous: no DOM, no `CSS.supports`, no colour
 * management. That is what lets the whole translator be exercised in a test
 * runner with no browser, which matters because a wrong matrix produces a colour
 * that merely looks a bit off rather than an error anyone would notice.
 *
 * Deliberately NOT here:
 *  - ICC profiles. `cmyk()` below is the naive device conversion every browser
 *    performs for `device-cmyk()` with no profile attached. It is labelled as
 *    such at the call site rather than presented as print-accurate, because a
 *    CMYK number that claims to be a press value and is not is worse than one
 *    that admits what it is.
 *  - `color()` / `color-mix()` parsing. Both can name a space this module would
 *    have to resolve against the document, and a parser that half-supports a
 *    syntax is a parser that returns the wrong colour for the other half.
 *  - Any notion of a "current" colour or a picker's state. This module answers
 *    questions; it does not remember anything.
 */

/* ------------------------------------------------------------------ model -- */

/** OKLCh plus alpha. `l` is 0..1, `c` is unbounded (~0..0.4 in practice), `h` degrees. */
export interface Color {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

/** Every representation the translator can produce, in the order it shows them. */
export type ColorSpace =
  | "named"
  | "hex"
  | "hex8"
  | "rgb"
  | "rgba"
  | "hsl"
  | "hsla"
  | "hsv"
  | "hwb"
  | "lab"
  | "lch"
  | "oklab"
  | "oklch"
  | "cmyk";

export const TRANSLATOR_SPACES: readonly ColorSpace[] = [
  "named", "hex", "hex8", "rgb", "rgba", "hsl", "hsla",
  "hsv", "hwb", "lab", "lch", "oklab", "oklch", "cmyk",
];

/** Display names, English. A locale overrides these at the call site. */
export const SPACE_LABELS: Record<ColorSpace, string> = {
  named: "Named", hex: "HEX", hex8: "HEX8", rgb: "RGB", rgba: "RGBA",
  hsl: "HSL", hsla: "HSLA", hsv: "HSV / HSB", hwb: "HWB", lab: "CIELAB",
  lch: "CIE LCH", oklab: "OKLab", oklch: "OKLCH", cmyk: "CMYK",
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round = (v: number, places: number) => {
  const k = 10 ** places;
  // `+ 0` normalises -0, which otherwise prints as "-0" in every readout.
  return Math.round(v * k) / k + 0;
};

/* ------------------------------------------------------------- conversion -- */

/*
 * Matrices are written out in full rather than derived from primaries at
 * runtime. Deriving them needs a matrix inverse, and an inverse computed in
 * floating point from four chromaticity pairs is exactly as trustworthy as the
 * constants below while being far harder to check against a reference.
 */

const SRGB_TO_XYZ = [
  [0.4123907992659595, 0.35758433938387796, 0.1804807884018343],
  [0.21263900587151036, 0.7151686787677559, 0.07219231536073371],
  [0.019330818715591851, 0.11919477979462599, 0.9505321522496606],
] as const;

const XYZ_TO_P3 = [
  [2.493496911941425, -0.9313836179191239, -0.40271078445071684],
  [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
  [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
] as const;

const XYZ_TO_REC2020 = [
  [1.7166511879712674, -0.3556707837763924, -0.25336628137365974],
  [-0.6666843518324892, 1.6164812366349395, 0.01576854581391113],
  [0.017639857445310783, -0.042770613257808524, 0.9421031212354739],
] as const;

/** Bradford-adapted, because CSS `lab()`/`lch()` are D50 while everything else here is D65. */
const D65_TO_D50 = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
] as const;

const D50_TO_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
] as const;

const D50 = [0.9642956764295677, 1, 0.8251046025104602] as const;

type Vec3 = [number, number, number];
const mul = (m: readonly (readonly number[])[], v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/** sRGB transfer function. Signed so out-of-gamut negatives survive the round trip. */
export const toLinear = (c: number): number => {
  const s = Math.sign(c) || 1;
  const a = Math.abs(c);
  return s * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4);
};

export const fromLinear = (c: number): number => {
  const s = Math.sign(c) || 1;
  const a = Math.abs(c);
  return s * (a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055);
};

/** Linear sRGB -> OKLab (Ottosson). */
export function linearToOklab(r: number, g: number, b: number): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab -> linear sRGB. May return values outside 0..1; that is the point. */
export function oklabToLinear(L: number, A: number, B: number): Vec3 {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** sRGB 0..1 -> the canonical model. */
export function fromRgb(r: number, g: number, b: number, alpha = 1): Color {
  const [L, A, B] = linearToOklab(toLinear(r), toLinear(g), toLinear(b));
  const c = Math.hypot(A, B);
  // Below this the hue is numerical noise, and reporting a random angle for a
  // grey makes the hue slider jump the moment chroma is dragged to zero.
  const h = c < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h, alpha: clamp(alpha, 0, 1) };
}

/** The canonical model -> sRGB 0..1, **unclamped**. */
export function toRgb(color: Color): Vec3 {
  const rad = (color.h * Math.PI) / 180;
  const [r, g, b] = oklabToLinear(color.l, color.c * Math.cos(rad), color.c * Math.sin(rad));
  return [fromLinear(r), fromLinear(g), fromLinear(b)];
}

/** sRGB bytes, clipped. What actually reaches a `#rrggbb` or an `rgb()`. */
export function toRgb255(color: Color): Vec3 {
  return toRgb(color).map(v => Math.round(clamp(v, 0, 1) * 255)) as Vec3;
}

function toXyzD65(color: Color): Vec3 {
  const [r, g, b] = toRgb(color);
  return mul(SRGB_TO_XYZ, [toLinear(r), toLinear(g), toLinear(b)]);
}

/* ---------------------------------------------------------------- gamut -- */

export type GamutName = "sRGB" | "Display P3" | "Rec. 2020" | "Beyond Rec. 2020";

/** A hair of slack, so a colour parsed from its own hex does not read as out of gamut. */
const GAMUT_EPS = 1e-4;
const within = (v: Vec3) => v.every(x => x >= -GAMUT_EPS && x <= 1 + GAMUT_EPS);

/**
 * The smallest standard gamut that contains this colour.
 *
 * Named rather than boolean because "out of gamut" alone tells the user nothing
 * they can act on: a colour inside Display P3 is reachable on the laptop they
 * are holding, one beyond Rec. 2020 is not reachable anywhere.
 */
export function gamutOf(color: Color): GamutName {
  const [r, g, b] = toRgb(color);
  if (within([r, g, b])) return "sRGB";
  const xyz = toXyzD65(color);
  if (within(mul(XYZ_TO_P3, xyz).map(fromLinear) as Vec3)) return "Display P3";
  if (within(mul(XYZ_TO_REC2020, xyz).map(fromLinear) as Vec3)) return "Rec. 2020";
  return "Beyond Rec. 2020";
}

/** True when writing this colour as sRGB would change it. */
export function clipsSrgb(color: Color): boolean {
  return !within(toRgb(color));
}

/**
 * How far the sRGB write would move the colour, 0..1-ish in OKLab distance.
 *
 * A magnitude rather than a flag because the warning has to be proportionate:
 * a hair outside the gamut is a rounding artefact, a long way outside is the
 * user losing the colour they picked.
 */
export function clipDistance(color: Color): number {
  const [r, g, b] = toRgb(color);
  if (within([r, g, b])) return 0;
  const clipped = fromRgb(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1), color.alpha);
  const rad = (color.h * Math.PI) / 180;
  const rad2 = (clipped.h * Math.PI) / 180;
  return Math.hypot(
    color.l - clipped.l,
    color.c * Math.cos(rad) - clipped.c * Math.cos(rad2),
    color.c * Math.sin(rad) - clipped.c * Math.sin(rad2),
  );
}

/* ------------------------------------------------------------- contrast -- */

/**
 * WCAG 2.1 relative luminance, computed on the **clipped sRGB** value.
 *
 * Clipped deliberately: the ratio is a claim about what a reader will see, and
 * what they will see is whatever the display can actually produce. Reporting a
 * ratio derived from an unreachable colour would be a number that is right about
 * nothing.
 */
export function relativeLuminance(color: Color): number {
  const [r, g, b] = toRgb(color).map(v => toLinear(clamp(v, 0, 1))) as Vec3;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21. Alpha is ignored — it needs a backdrop to mean anything. */
export function contrastRatio(a: Color, b: Color): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type ContrastGrade = "AAA" | "AA" | "AA Large" | "Fail";

/** The best WCAG grade this ratio earns for the given text size. */
export function contrastGrade(ratio: number, large = false): ContrastGrade {
  if (ratio >= (large ? 4.5 : 7)) return "AAA";
  if (ratio >= (large ? 3 : 4.5)) return "AA";
  if (ratio >= 3) return "AA Large";
  return "Fail";
}

/**
 * Composite a colour with alpha over an opaque backdrop.
 *
 * Contrast against a translucent colour is meaningless without this — a 20%
 * white over black is not white, and a picker that reported it as white would
 * pass a control that is in fact unreadable.
 */
export function over(color: Color, backdrop: Color): Color {
  if (color.alpha >= 1) return color;
  const f = toRgb(color);
  const b = toRgb(backdrop);
  const a = color.alpha;
  return fromRgb(
    f[0] * a + b[0] * (1 - a),
    f[1] * a + b[1] * (1 - a),
    f[2] * a + b[2] * (1 - a),
    1,
  );
}

/* ---------------------------------------------------------- named colours -- */

/**
 * The CSS named colours, all 148 of them plus `transparent`.
 *
 * The full list rather than a curated subset: the translator promises to name a
 * colour "when defined", and a shortened table would silently answer "no name"
 * for a colour that has one.
 */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4",
  azure: "#f0ffff", beige: "#f5f5dc", bisque: "#ffe4c4", black: "#000000",
  blanchedalmond: "#ffebcd", blue: "#0000ff", blueviolet: "#8a2be2", brown: "#a52a2a",
  burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00", chocolate: "#d2691e",
  coral: "#ff7f50", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c",
  cyan: "#00ffff", darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9", darkgreen: "#006400", darkgrey: "#a9a9a9", darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b", darkolivegreen: "#556b2f", darkorange: "#ff8c00", darkorchid: "#9932cc",
  darkred: "#8b0000", darksalmon: "#e9967a", darkseagreen: "#8fbc8f", darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1", darkviolet: "#9400d3",
  deeppink: "#ff1493", deepskyblue: "#00bfff", dimgray: "#696969", dimgrey: "#696969",
  dodgerblue: "#1e90ff", firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22",
  fuchsia: "#ff00ff", gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700",
  goldenrod: "#daa520", gray: "#808080", green: "#008000", greenyellow: "#adff2f",
  grey: "#808080", honeydew: "#f0fff0", hotpink: "#ff69b4", indianred: "#cd5c5c",
  indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa",
  lavenderblush: "#fff0f5", lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6",
  lightcoral: "#f08080", lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3",
  lightgreen: "#90ee90", lightgrey: "#d3d3d3", lightpink: "#ffb6c1", lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa", lightskyblue: "#87cefa", lightslategray: "#778899", lightslategrey: "#778899",
  lightsteelblue: "#b0c4de", lightyellow: "#ffffe0", lime: "#00ff00", limegreen: "#32cd32",
  linen: "#faf0e6", magenta: "#ff00ff", maroon: "#800000", mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd", mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee", mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc", mediumvioletred: "#c71585",
  midnightblue: "#191970", mintcream: "#f5fffa", mistyrose: "#ffe4e1", moccasin: "#ffe4b5",
  navajowhite: "#ffdead", navy: "#000080", oldlace: "#fdf5e6", olive: "#808000",
  olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500", orchid: "#da70d6",
  palegoldenrod: "#eee8aa", palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093",
  papayawhip: "#ffefd5", peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb",
  plum: "#dda0dd", powderblue: "#b0e0e6", purple: "#800080", rebeccapurple: "#663399",
  red: "#ff0000", rosybrown: "#bc8f8f", royalblue: "#4169e1", saddlebrown: "#8b4513",
  salmon: "#fa8072", sandybrown: "#f4a460", seagreen: "#2e8b57", seashell: "#fff5ee",
  sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd",
  slategray: "#708090", slategrey: "#708090", snow: "#fffafa", springgreen: "#00ff7f",
  steelblue: "#4682b4", tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8",
  tomato: "#ff6347", turquoise: "#40e0d0", violet: "#ee82ee", wheat: "#f5deb3",
  white: "#ffffff", whitesmoke: "#f5f5f5", yellow: "#ffff00", yellowgreen: "#9acd32",
};

/** hex -> the first name that produces it, built once. */
const NAME_BY_HEX: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [name, hex] of Object.entries(NAMED_COLORS)) if (!map.has(hex)) map.set(hex, name);
  return map;
})();

/** The exact CSS name for this colour, or null. Opaque colours only — `red` has no alpha. */
export function nameOf(color: Color): string | null {
  if (color.alpha < 1) return color.alpha === 0 ? "transparent" : null;
  return NAME_BY_HEX.get(formatHex(color)) ?? null;
}

/**
 * The closest named colour, by OKLab distance.
 *
 * Perceptual distance rather than RGB distance, because "nearest" is a claim
 * about what the eye would call it: the nearest colour to a muted teal in RGB
 * space is frequently something nobody would ever describe as similar.
 */
export function nearestName(color: Color): { name: string; distance: number } {
  const rad = (color.h * Math.PI) / 180;
  const target: Vec3 = [color.l, color.c * Math.cos(rad), color.c * Math.sin(rad)];
  let best = { name: "black", distance: Infinity };
  for (const [name, hex] of Object.entries(NAMED_COLORS)) {
    const other = parseHex(hex);
    if (!other) continue;
    const r2 = (other.h * Math.PI) / 180;
    const distance = Math.hypot(
      target[0] - other.l,
      target[1] - other.c * Math.cos(r2),
      target[2] - other.c * Math.sin(r2),
    );
    if (distance < best.distance) best = { name, distance };
  }
  return best;
}

/* ---------------------------------------------------------------- parsing -- */

/** Splits a functional notation's argument list on commas *or* whitespace, and on `/`. */
function args(body: string): { values: string[]; alpha: string | null } {
  const [main, alpha = null] = body.split("/");
  return { values: main.trim().split(/[\s,]+/).filter(Boolean), alpha: alpha?.trim() ?? null };
}

/** `50%` -> 0.5 against `scale`; a bare number is taken at face value against `scale`. */
function num(text: string | undefined, scale = 1): number {
  if (!text) return NaN;
  const t = text.trim();
  if (t === "none") return 0;
  if (t.endsWith("%")) return (parseFloat(t) / 100) * scale;
  if (t.endsWith("deg")) return parseFloat(t);
  if (t.endsWith("turn")) return parseFloat(t) * 360;
  if (t.endsWith("rad")) return (parseFloat(t) * 180) / Math.PI;
  if (t.endsWith("grad")) return parseFloat(t) * 0.9;
  return parseFloat(t);
}

function alphaOf(text: string | null | undefined): number {
  if (text == null || text === "") return 1;
  const v = num(text, 1);
  return Number.isFinite(v) ? clamp(v, 0, 1) : 1;
}

function parseHex(text: string): Color | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(text.trim());
  if (!m) return null;
  const h = m[1];
  const expand = (s: string) => s.split("").map(c => c + c).join("");
  let full: string;
  if (h.length === 3) full = expand(h) + "ff";
  else if (h.length === 4) full = expand(h);
  else if (h.length === 6) full = h + "ff";
  else if (h.length === 8) full = h;
  else return null;
  const byte = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return fromRgb(byte(0), byte(2), byte(4), byte(6));
}

function hslToRgb(h: number, s: number, l: number): Vec3 {
  const hue = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function hsvToRgb(h: number, s: number, v: number): Vec3 {
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return hslToRgb(h, sl, l);
}

function labToColor(L: number, A: number, B: number, alpha: number): Color {
  const fy = (L + 16) / 116;
  const fx = fy + A / 500;
  const fz = fy - B / 200;
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f = (t: number) => (t ** 3 > e ? t ** 3 : (116 * t - 16) / k);
  const xyzD50: Vec3 = [f(fx) * D50[0], (L > k * e ? ((L + 16) / 116) ** 3 : L / k) * D50[1], f(fz) * D50[2]];
  const [x, y, z] = mul(D50_TO_D65, xyzD50);
  // XYZ(D65) -> linear sRGB is the inverse of SRGB_TO_XYZ, written out for the
  // same reason the forward matrix is.
  const lin: Vec3 = [
    3.2409699419045213 * x - 1.5373831775700935 * y - 0.4986107602930033 * z,
    -0.9692436362808798 * x + 1.8759675015077206 * y + 0.04155505740717561 * z,
    0.05563007969699361 * x - 0.20397695888897657 * y + 1.0569715142428786 * z,
  ];
  return fromRgb(fromLinear(lin[0]), fromLinear(lin[1]), fromLinear(lin[2]), alpha);
}

function colorToLab(color: Color): Vec3 {
  const [x, y, z] = mul(D65_TO_D50, toXyzD65(color));
  const e = 216 / 24389;
  const k = 24389 / 27;
  const f = (t: number) => (t > e ? Math.cbrt(t) : (k * t + 16) / 116);
  const fx = f(x / D50[0]);
  const fy = f(y / D50[1]);
  const fz = f(z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Any of the syntaxes the translator emits, plus the ones a user is likely to
 * paste. Returns null rather than a fallback colour: a picker that silently
 * turns a typo into black has thrown away what the user typed.
 */
export function parseColor(input: string): Color | null {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text === "transparent") return { l: 0, c: 0, h: 0, alpha: 0 };
  if (NAMED_COLORS[text]) return parseHex(NAMED_COLORS[text]);
  if (text.startsWith("#")) return parseHex(text);

  const fn = /^([a-z-]+)\(([^)]*)\)$/.exec(text);
  if (!fn) {
    // A bare `rrggbb` with no `#`, which is what a user pasting from a design
    // tool most often has on their clipboard.
    return /^[0-9a-f]{3,8}$/.test(text) ? parseHex("#" + text) : null;
  }
  const name = fn[1];
  const { values, alpha } = args(fn[2]);
  // Legacy comma syntax puts alpha in the fourth slot instead of after a slash.
  const a = alphaOf(alpha ?? (values.length > 3 ? values[3] : null));
  const v = (i: number, scale = 1) => num(values[i], scale);
  if (!Number.isFinite(v(0)) && values[0] !== "none") return null;

  switch (name) {
    case "rgb":
    case "rgba": {
      // `rgb(50% 0% 0%)` and `rgb(128 0 0)` are both legal; the `%` suffix is
      // what decides the scale, so each channel is resolved on its own.
      const ch = (i: number) => (values[i]?.endsWith("%") ? num(values[i], 1) : num(values[i]) / 255);
      return fromRgb(ch(0), ch(1), ch(2), a);
    }
    case "hsl":
    case "hsla": {
      const [r, g, b] = hslToRgb(v(0), v(1, 1), v(2, 1));
      return fromRgb(r, g, b, a);
    }
    case "hsv":
    case "hsb": {
      const [r, g, b] = hsvToRgb(v(0), v(1, 1), v(2, 1));
      return fromRgb(r, g, b, a);
    }
    case "hwb": {
      const w = v(1, 1);
      const bl = v(2, 1);
      // W + B >= 1 is achromatic; the ratio decides which grey.
      if (w + bl >= 1) {
        const grey = w / (w + bl);
        return fromRgb(grey, grey, grey, a);
      }
      const [r, g, b] = hsvToRgb(v(0), 1 - w / (1 - bl), 1 - bl);
      return fromRgb(r, g, b, a);
    }
    case "lab":
      return labToColor(v(0, 100), v(1, 125), v(2, 125), a);
    case "lch": {
      const hue = v(2);
      return labToColor(
        v(0, 100),
        v(1, 150) * Math.cos((hue * Math.PI) / 180),
        v(1, 150) * Math.sin((hue * Math.PI) / 180),
        a,
      );
    }
    case "oklab": {
      const L = v(0, 1);
      const A = v(1, 0.4);
      const B = v(2, 0.4);
      const c = Math.hypot(A, B);
      return { l: L, c, h: c < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360, alpha: a };
    }
    case "oklch":
      return { l: v(0, 1), c: v(1, 0.4), h: ((v(2) % 360) + 360) % 360, alpha: a };
    case "cmyk":
    case "device-cmyk": {
      const k = v(3, 1);
      const ch = (i: number) => (1 - v(i, 1)) * (1 - k);
      return fromRgb(ch(0), ch(1), ch(2), a);
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------- formatting -- */

const hex2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");

export function formatHex(color: Color): string {
  const [r, g, b] = toRgb255(color);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function formatHex8(color: Color): string {
  return `${formatHex(color)}${hex2(color.alpha * 255)}`;
}

function toHsl(color: Color): Vec3 {
  const [r, g, b] = toRgb(color).map(v => clamp(v, 0, 1)) as Vec3;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toHsv(color: Color): Vec3 {
  const [r, g, b] = toRgb(color).map(v => clamp(v, 0, 1)) as Vec3;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return [h, max === 0 ? 0 : d / max, max];
}

/**
 * Naive device CMYK, with no ICC profile.
 *
 * The same transform a browser applies to `device-cmyk()` when nothing has told
 * it about a press. It is offered because the rules ask the translator to cover
 * CMYK and a designer pasting a value from one tool into another is served by
 * it; it is labelled as a device conversion at every call site so nobody sends
 * it to a printer believing it is colour-managed.
 */
export function toCmyk(color: Color): [number, number, number, number] {
  const [r, g, b] = toRgb(color).map(v => clamp(v, 0, 1)) as Vec3;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}

/**
 * One representation of a colour, as a string a browser would accept.
 *
 * `named` is the one space that can fail: most colours have no name. It returns
 * the nearest name prefixed with `~` rather than an empty string, so the row
 * still carries information and is visibly *not* an exact value — copying it
 * gives a real CSS colour, just not the same one, and the tilde is what says so.
 */
export function formatColor(color: Color, space: ColorSpace): string {
  const a = round(color.alpha, 3);
  switch (space) {
    case "named": {
      const exact = nameOf(color);
      return exact ?? `~${nearestName(color).name}`;
    }
    case "hex":
      return formatHex(color);
    case "hex8":
      return formatHex8(color);
    case "rgb": {
      const [r, g, b] = toRgb255(color);
      return `rgb(${r} ${g} ${b})`;
    }
    case "rgba": {
      const [r, g, b] = toRgb255(color);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    case "hsl": {
      const [h, s, l] = toHsl(color);
      return `hsl(${round(h, 1)} ${round(s * 100, 1)}% ${round(l * 100, 1)}%)`;
    }
    case "hsla": {
      const [h, s, l] = toHsl(color);
      return `hsla(${round(h, 1)}, ${round(s * 100, 1)}%, ${round(l * 100, 1)}%, ${a})`;
    }
    case "hsv": {
      const [h, s, v] = toHsv(color);
      return `hsv(${round(h, 1)} ${round(s * 100, 1)}% ${round(v * 100, 1)}%)`;
    }
    case "hwb": {
      const [h] = toHsv(color);
      const [r, g, b] = toRgb(color).map(v => clamp(v, 0, 1)) as Vec3;
      const w = Math.min(r, g, b);
      const bl = 1 - Math.max(r, g, b);
      return `hwb(${round(h, 1)} ${round(w * 100, 1)}% ${round(bl * 100, 1)}%${a < 1 ? ` / ${a}` : ""})`;
    }
    case "lab": {
      const [L, A, B] = colorToLab(color);
      return `lab(${round(L, 2)}% ${round(A, 2)} ${round(B, 2)}${a < 1 ? ` / ${a}` : ""})`;
    }
    case "lch": {
      const [L, A, B] = colorToLab(color);
      const c = Math.hypot(A, B);
      const h = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
      return `lch(${round(L, 2)}% ${round(c, 2)} ${round(h, 2)}${a < 1 ? ` / ${a}` : ""})`;
    }
    case "oklab": {
      const rad = (color.h * Math.PI) / 180;
      return `oklab(${round(color.l * 100, 2)}% ${round(color.c * Math.cos(rad), 4)} ${round(color.c * Math.sin(rad), 4)}${a < 1 ? ` / ${a}` : ""})`;
    }
    case "oklch":
      return `oklch(${round(color.l * 100, 2)}% ${round(color.c, 4)} ${round(color.h, 2)}${a < 1 ? ` / ${a}` : ""})`;
    case "cmyk": {
      const [c, m, y, k] = toCmyk(color).map(v => round(v * 100, 1));
      return `device-cmyk(${c}% ${m}% ${y}% ${k}%)`;
    }
  }
}

/**
 * The string a stylesheet should receive for this colour.
 *
 * `oklch()` when the colour is outside sRGB — writing the hex there would be the
 * silent clip the warning exists to prevent, and a browser that understands
 * `oklch()` will render the wide colour on a display that has it. Hex otherwise,
 * because it is what a reader inspecting the CSS expects to see, and `#rrggbbaa`
 * when alpha is in play.
 */
export function toCssValue(color: Color): string {
  if (color.alpha <= 0) return "transparent";
  if (clipsSrgb(color)) return formatColor(color, "oklch");
  return color.alpha < 1 ? formatHex8(color) : formatHex(color);
}

/** Every translator row for one colour, ready to render. */
export function translate(color: Color): { space: ColorSpace; label: string; value: string }[] {
  return TRANSLATOR_SPACES.map(space => ({
    space,
    label: SPACE_LABELS[space],
    value: formatColor(color, space),
  }));
}
