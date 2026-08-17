/**
 * The app-logo customization store — presets, the local custom-image upload
 * pipeline, and the persisted state every rendered mark reads from.
 *
 * ## Where this sits
 *
 * Modelled directly on `i18n/personal-vocabulary.ts`: a React-free module
 * singleton with a `subscribe`/`getSnapshot` pair, so `useSyncExternalStore`
 * can bind it in exactly one place (`use-app-logo.ts`) and every consumer —
 * the nav-rail brand image, the in-document favicon link, the Appearance
 * screen's own editor — reads the same live value without a provider tree of
 * its own. That shape is deliberate here for a second reason beyond
 * precedent: a custom logo's converted variants are small but non-trivial
 * base64 strings, and folding them into the app-wide `Prefs` object would
 * mean every keystroke-driven `Prefs` diff (the draft/apply bar's dirty-count
 * check) does a full-string comparison against image data that only ever
 * changes on a deliberate upload or reset. Keeping this its own store means
 * the logo changes live the moment an action commits — no "Apply" click
 * required — which is the more literal reading of "applies live wherever
 * feasible" anyway.
 *
 * ## What this module deliberately does not do
 *
 * - It never uploads the source image anywhere. Every byte this module
 *   touches comes from a user-picked `File` (or the shipped/generated
 *   presets) and stays local: decoding happens through the browser's own
 *   canvas machinery, and the only thing ever written to disk is
 *   `localStorage`. There is no `fetch` anywhere in this file or its two
 *   pure siblings (`app-logo-format.ts`, `app-logo-geometry.ts`), and the
 *   test suite for this module asserts that directly.
 * - It never retains the original uploaded bytes past the conversion step
 *   that turns them into the small square variants this app actually
 *   renders. Only the converted output — a handful of square PNGs at the
 *   sizes `LOGO_OUTPUT_SIZES` names — is persisted. That keeps the stored
 *   footprint bounded to roughly what the shipped mark itself costs, at the
 *   cost of "Replace" always meaning "pick a file again" rather than
 *   "re-open my last crop" — a deliberate trade documented once here rather
 *   than silently discovered by whoever next wonders where the source went.
 * - It never rewrites anything electron-builder.yml, `package.json`, or the
 *   `electron/` main process own about the *packaged application's*
 *   identity — its Windows executable icon, its app id, its installer name,
 *   its update feed. Those are baked in at build time from
 *   `gui/public/logo.png`, a file this module never opens for writing. What
 *   this module changes is presentation *inside the running renderer*: the
 *   `<img>` in the nav rail and the `<link rel="icon">` in the document
 *   head, both of which are ordinary DOM state that resets to the shipped
 *   mark the moment `resetAppLogo()` runs.
 *
 * ## The persisted schema
 *
 * ```json
 * {
 *   "sourceId": "shipped" | "<preset id>" | "custom",
 *   "custom": null | {
 *     "format": "png" | "jpeg",
 *     "sourceWidth": number, "sourceHeight": number,
 *     "fit": "contain" | "fill" | "crop",
 *     "background": string | null,
 *     "focal": { "x": number, "y": number },
 *     "cropBox": null | { "x": number, "y": number, "size": number },
 *     "variants": { "32": "data:image/png;base64,…", "128": "…", "256": "…" }
 *   }
 * }
 * ```
 *
 * `custom` is validated and re-validated as a whole on every read — see
 * {@link readAppLogoState} — and any variant that does not itself re-probe as
 * a well-formed, correctly-sized, non-animated PNG through the exact same
 * `probeImageBytes` a fresh upload goes through causes the *entire* custom
 * asset to be dropped, falling back to the shipped mark. A partially valid
 * custom logo is not a state this module will render.
 */

import {
  LOGO_MAX_DECLARED_PIXELS,
  LOGO_MAX_DIMENSION,
  LOGO_MAX_FILE_BYTES,
  bytesFromDataUri,
  probeImageBytes,
  probeLogoFile,
  type LogoProbeOk,
  type LogoProbeRejectReason,
  type LogoProbeResult,
} from "./app-logo-format";
import {
  DEFAULT_FOCAL,
  clampCropBox,
  clampFocal,
  computeDestRect,
  computeSourceRect,
  type FocalPoint,
  type LogoFit,
  type PixelCropBox,
} from "./app-logo-geometry";
import { parseColor, toCssValue } from "../../../shared/m3/color";
import { recordRevision } from "../shell/revisions";

export type { LogoFit, FocalPoint, PixelCropBox } from "./app-logo-geometry";
export type { LogoProbeOk, LogoProbeRejectReason } from "./app-logo-format";
export { DEFAULT_FOCAL, clampFocal, clampCropBox, maxSquareSize, computeSourceRect, computeDestRect } from "./app-logo-geometry";
export { probeLogoFile, probeImageBytes, LOGO_MAX_FILE_BYTES, LOGO_MAX_DIMENSION };

/** Square output sizes this app actually consumes: the favicon tab icon, the
 *  nav-rail brand mark at its normal size, and a higher-density copy for a
 *  2×-scaled rail. Generating only these three — rather than, say, storing
 *  one large master and scaling it with CSS — is the "only the size and
 *  format variants the surface can actually consume" half of the contract:
 *  each one is independently produced, independently verified, and would
 *  independently roll back a bad conversion rather than sharing a single
 *  point of failure. */
export const LOGO_OUTPUT_SIZES = [32, 128, 256] as const;
export type LogoOutputSize = (typeof LOGO_OUTPUT_SIZES)[number];

/** Combined ceiling on every stored variant's data-URI length together. A
 *  256×256 RGBA PNG produced by `canvas.toDataURL` is ordinarily well under
 *  100 KB; this is a defence-in-depth backstop against an unexpectedly
 *  expensive encode (a highly dithered source, say) rather than a bound
 *  anyone should expect to be near in practice. */
export const LOGO_MAX_STORED_BYTES = 2 * 1024 * 1024;

const STORAGE_KEY = "ocx-applogo:v1";

/* ---------------------------------------------------------------- presets - */

export const SHIPPED_LOGO_PRESET_ID = "shipped";
/** The `sourceId` naming an active custom upload rather than a built-in preset. */
export const CUSTOM_SOURCE_ID = "custom";

const ACCENT = "#aa3bff"; // The brand purple already used by icons.svg's stroked glyphs.
const INK = "#1b1b1f";
const PAPER = "#ffffff";

/**
 * A stroke-built "`</>`" mark — two chevrons and a diagonal slash — rather
 * than an SVG `<text>` glyph. Text shaping in an SVG rendered as an `<img>`
 * or a favicon depends on which fonts the host has installed, which is
 * exactly the kind of platform-dependent rendering a *shipped, deterministic*
 * preset should not carry; three `<path>`s always draw identically.
 */
function bracketGlyph(stroke: string): string {
  return (
    `<g fill="none" stroke="${stroke}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M100 84 L64 128 L100 172"/>` +
    `<path d="M156 84 L192 128 L156 172"/>` +
    `<path d="M142 72 L114 184"/>` +
    `</g>`
  );
}

export type LogoPresetSource =
  | { readonly kind: "shipped" }
  | { readonly kind: "generated"; readonly svg: () => string };

export interface LogoPreset {
  readonly id: string;
  /** Resolved against the dictionaries at the UI layer; kept as a plain
   *  string here so this module stays free of an `i18n` dependency, the same
   *  way `ELEMENT_TARGETS` in `prefs-context.ts` keeps its `tkey` untyped. */
  readonly tkey: string;
  readonly source: LogoPresetSource;
}

/**
 * The shipped mark, plus three generated, project-appropriate badges built
 * from the same bracket glyph opencodex already uses as its accent motif —
 * a circle, a rounded square, and an outlined ring, so the choice on offer
 * is genuinely a choice of *shape* and *treatment*, not three colour swaps
 * of one drawing.
 */
export const LOGO_PRESETS: readonly LogoPreset[] = [
  { id: SHIPPED_LOGO_PRESET_ID, tkey: "appearance.logoPresetShipped", source: { kind: "shipped" } },
  {
    id: "badge-circle",
    tkey: "appearance.logoPresetCircle",
    source: {
      kind: "generated",
      svg: () =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
        `<circle cx="128" cy="128" r="120" fill="${ACCENT}"/>${bracketGlyph(PAPER)}</svg>`,
    },
  },
  {
    id: "badge-square",
    tkey: "appearance.logoPresetSquare",
    source: {
      kind: "generated",
      svg: () =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
        `<rect x="8" y="8" width="240" height="240" rx="56" fill="${INK}"/>${bracketGlyph(ACCENT)}</svg>`,
    },
  },
  {
    id: "badge-outline",
    tkey: "appearance.logoPresetOutline",
    source: {
      kind: "generated",
      svg: () =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
        `<circle cx="128" cy="128" r="118" fill="${PAPER}" stroke="${ACCENT}" stroke-width="10"/>${bracketGlyph(ACCENT)}</svg>`,
    },
  },
];

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The `<img src>`/favicon `href` a preset resolves to. The shipped preset
 *  points at the file `electron-builder.yml`'s `win.icon` is also built
 *  from — the same bytes, read the ordinary way a web page reads an asset,
 *  never rewritten. */
export function presetImageSrc(preset: LogoPreset): string {
  return preset.source.kind === "shipped" ? "/logo.png" : svgToDataUri(preset.source.svg());
}

export function findPreset(id: string): LogoPreset | undefined {
  return LOGO_PRESETS.find(p => p.id === id);
}

/* ------------------------------------------------------------------ state - */

export interface CustomLogoAsset {
  readonly format: "png" | "jpeg";
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly fit: LogoFit;
  /** A CSS colour, or `null` for a transparent background. */
  readonly background: string | null;
  readonly focal: FocalPoint;
  /** Only meaningful when `fit === "crop"`; `null` means "use the box the
   *  focal point implies", so a user who has only ever touched the focal
   *  point never has an explicit crop box to keep in sync with it. */
  readonly cropBox: PixelCropBox | null;
  /** Keyed by the numeric size; every key present is guaranteed (by
   *  {@link readAppLogoState}'s validation) to decode as a PNG of exactly
   *  that width and height. */
  readonly variants: Readonly<Partial<Record<LogoOutputSize, string>>>;
}

export interface AppLogoState {
  readonly sourceId: string;
  readonly custom: CustomLogoAsset | null;
}

export const DEFAULT_APP_LOGO_STATE: AppLogoState = { sourceId: SHIPPED_LOGO_PRESET_ID, custom: null };

/* ---------------------------------------------------------- src resolution - */

function largestAvailableVariant(custom: CustomLogoAsset): string | null {
  for (const size of [...LOGO_OUTPUT_SIZES].sort((a, b) => b - a)) {
    const uri = custom.variants[size];
    if (uri) return uri;
  }
  return null;
}

function smallestAvailableVariant(custom: CustomLogoAsset): string | null {
  for (const size of [...LOGO_OUTPUT_SIZES].sort((a, b) => a - b)) {
    const uri = custom.variants[size];
    if (uri) return uri;
  }
  return null;
}

/** The mark to render at ordinary chrome sizes — the nav rail's brand image,
 *  the Appearance screen's own "currently active" preview. Prefers the
 *  largest generated variant so it stays crisp at whatever the rail's own
 *  CSS scales it to. */
export function resolveLogoSrc(state: AppLogoState): string {
  if (state.sourceId === CUSTOM_SOURCE_ID && state.custom) {
    const uri = largestAvailableVariant(state.custom);
    if (uri) return uri;
  }
  return presetImageSrc(findPreset(state.sourceId) ?? LOGO_PRESETS[0]!);
}

/** The `<link rel="icon">` target: `href` plus the MIME type it should carry,
 *  since a generated preset is SVG while a custom upload's variants are
 *  always PNG. Prefers the *smallest* variant — a browser tab icon renders
 *  at a handful of pixels, and handing it the 256px master only costs a
 *  larger download for identical on-screen results. */
export function resolveFaviconSrc(state: AppLogoState): { href: string; type: string } {
  if (state.sourceId === CUSTOM_SOURCE_ID && state.custom) {
    const uri = smallestAvailableVariant(state.custom);
    if (uri) return { href: uri, type: "image/png" };
  }
  if (state.sourceId === SHIPPED_LOGO_PRESET_ID) return { href: "/favicon.png", type: "image/png" };
  const preset = findPreset(state.sourceId) ?? LOGO_PRESETS[0]!;
  return { href: presetImageSrc(preset), type: "image/svg+xml" };
}

/* ------------------------------------------------------- stored validation - */

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function clamp01(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** A stored background colour is re-validated by actually parsing it — the
 *  same `parseColor` the infinite colour picker's own free-text field uses —
 *  and re-serialized to its canonical form rather than trusted verbatim, so
 *  a corrupted or hand-edited value can never reach `ctx.fillStyle` as
 *  anything other than a colour this app itself recognises. */
function readBackground(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") return null;
  const parsed = parseColor(raw.trim().slice(0, 64));
  return parsed ? toCssValue(parsed) : null;
}

function readFocal(raw: unknown): FocalPoint {
  if (!raw || typeof raw !== "object") return DEFAULT_FOCAL;
  const f = raw as Partial<FocalPoint>;
  return clampFocal({ x: clamp01(f.x, DEFAULT_FOCAL.x), y: clamp01(f.y, DEFAULT_FOCAL.y) });
}

function readCropBox(raw: unknown, source: { width: number; height: number }): PixelCropBox | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<PixelCropBox>;
  if (!isFinitePositive(b.size) || typeof b.x !== "number" || typeof b.y !== "number") return null;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  return clampCropBox({ x: b.x, y: b.y, size: b.size }, source);
}

/**
 * Re-validate every stored variant by re-probing its own bytes through the
 * exact byte-signature parser a fresh upload goes through. A variant that
 * does not decode to a well-formed, non-animated PNG of *precisely* the
 * width and height its key claims is dropped; if any expected size is
 * missing after that pass, the whole custom asset is refused (see
 * {@link readAppLogoState}) rather than rendered from a partial variant set.
 */
function readVariants(raw: unknown): Partial<Record<LogoOutputSize, string>> {
  const out: Partial<Record<LogoOutputSize, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const size of LOGO_OUTPUT_SIZES) {
    const value = (raw as Record<string, unknown>)[String(size)];
    if (typeof value !== "string") continue;
    const bytes = bytesFromDataUri(value);
    if (!bytes) continue;
    const probe = probeImageBytes(bytes);
    if (probe.ok && probe.format === "png" && probe.width === size && probe.height === size) {
      out[size] = value;
    }
  }
  return out;
}

/**
 * Read and fully re-validate the persisted state, failing closed to the
 * shipped mark for anything missing, corrupt, or produced by a schema this
 * build no longer understands — the same "a cache is never trusted on the
 * strength of merely existing" rule `personal-vocabulary.ts` applies to its
 * own cache.
 */
export function readAppLogoState(storage?: Pick<Storage, "getItem">): AppLogoState {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!store) return DEFAULT_APP_LOGO_STATE;
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_APP_LOGO_STATE;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return DEFAULT_APP_LOGO_STATE;
    const obj = parsed as Record<string, unknown>;
    const sourceId = typeof obj.sourceId === "string" ? obj.sourceId : SHIPPED_LOGO_PRESET_ID;
    const knownSource = sourceId === CUSTOM_SOURCE_ID || findPreset(sourceId) !== undefined;
    if (!knownSource) return DEFAULT_APP_LOGO_STATE;

    if (sourceId !== CUSTOM_SOURCE_ID || !obj.custom || typeof obj.custom !== "object") {
      return { sourceId: sourceId === CUSTOM_SOURCE_ID ? SHIPPED_LOGO_PRESET_ID : sourceId, custom: null };
    }

    const c = obj.custom as Record<string, unknown>;
    const format = c.format === "png" || c.format === "jpeg" ? c.format : null;
    const sourceWidth = c.sourceWidth;
    const sourceHeight = c.sourceHeight;
    if (
      !format ||
      !isFinitePositive(sourceWidth) ||
      !isFinitePositive(sourceHeight) ||
      sourceWidth > LOGO_MAX_DIMENSION ||
      sourceHeight > LOGO_MAX_DIMENSION ||
      sourceWidth * sourceHeight > LOGO_MAX_DECLARED_PIXELS
    ) {
      return DEFAULT_APP_LOGO_STATE;
    }
    const fit: LogoFit = c.fit === "fill" || c.fit === "crop" ? c.fit : "contain";
    const focal = readFocal(c.focal);
    const cropBox = readCropBox(c.cropBox, { width: sourceWidth, height: sourceHeight });
    const variants = readVariants(c.variants);
    // Every declared output size must have re-validated, or the asset is
    // only ever *partially* renderable — the nav rail asking for the large
    // variant would get it while the favicon silently fell back to a preset,
    // a split state nobody chose. Fail the whole asset closed instead.
    const complete = LOGO_OUTPUT_SIZES.every(size => variants[size] !== undefined);
    if (!complete) return DEFAULT_APP_LOGO_STATE;

    return {
      sourceId: CUSTOM_SOURCE_ID,
      custom: { format, sourceWidth, sourceHeight, fit, background: readBackground(c.background), focal, cropBox, variants },
    };
  } catch {
    return DEFAULT_APP_LOGO_STATE;
  }
}

function writeAppLogoState(state: AppLogoState, storage?: Pick<Storage, "setItem">): boolean {
  try {
    (storage ?? localStorage).setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- the store - */

export interface AppLogoSnapshot {
  readonly applied: AppLogoState;
  /** The most recent rejection from a file that failed the byte-level
   *  probe — cleared the moment a later action (successful or not)
   *  supersedes it. Never persisted: a stale error from a prior session is
   *  not a fact about the current one. */
  readonly lastRejection: LogoProbeRejectReason | null;
  /** The most recent failure from the decode/convert pipeline, distinct from
   *  a probe rejection because it names a different kind of problem — the
   *  file *looked* fine and the conversion itself could not be trusted. */
  readonly lastConversionFailure: LogoConversionFailureReason | null;
}

let snapshot: AppLogoSnapshot = { applied: DEFAULT_APP_LOGO_STATE, lastRejection: null, lastConversionFailure: null };
let hydrated = false;
const listeners = new Set<() => void>();

function setSnapshot(next: AppLogoSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function ensureHydrated(storage?: Pick<Storage, "getItem">): void {
  if (hydrated) return;
  hydrated = true;
  snapshot = { applied: readAppLogoState(storage), lastRejection: null, lastConversionFailure: null };
}

export function getAppLogoSnapshot(): AppLogoSnapshot {
  ensureHydrated();
  return snapshot;
}

export function subscribeAppLogo(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Describe a state change for the local revision log, in the words the
 *  Version history screen already renders other Appearance changes with. */
function summarizeSource(state: AppLogoState): string {
  if (state.sourceId === CUSTOM_SOURCE_ID) return "Custom upload";
  return findPreset(state.sourceId)?.id ?? state.sourceId;
}

function commit(next: AppLogoState, storage?: Pick<Storage, "getItem" | "setItem">, skipPersist = false): void {
  const before = snapshot.applied;
  if (!skipPersist) writeAppLogoState(next, storage);
  setSnapshot({ applied: next, lastRejection: null, lastConversionFailure: null });
  if (summarizeSource(before) !== summarizeSource(next) || before.sourceId !== next.sourceId) {
    recordRevision({
      scope: "settings",
      label: "App logo",
      summary: `Set to ${summarizeSource(next)}`,
      before: JSON.stringify(before),
    });
  }
}

/** Select one of the built-in presets, including the shipped mark. */
export function selectLogoPreset(id: string, storage?: Pick<Storage, "getItem" | "setItem">): boolean {
  ensureHydrated(storage);
  if (!findPreset(id)) return false;
  commit({ sourceId: id, custom: null }, storage);
  return true;
}

/** Activate a freshly converted custom logo. Only ever called with a
 *  {@link CustomLogoAsset} that has already passed the full probe + decode +
 *  convert + round-trip pipeline — this function itself performs no
 *  validation, because by the time it is called every byte it is about to
 *  persist has already been proven safe to render. */
export function applyCustomLogo(asset: CustomLogoAsset, storage?: Pick<Storage, "getItem" | "setItem">): void {
  ensureHydrated(storage);
  commit({ sourceId: CUSTOM_SOURCE_ID, custom: asset }, storage);
}

/** Reset cleanly to the shipped mark — the one action guaranteed to leave no
 *  custom asset behind, whatever the prior state was. */
export function resetAppLogo(storage?: Pick<Storage, "getItem" | "setItem">): void {
  ensureHydrated(storage);
  commit(DEFAULT_APP_LOGO_STATE, storage);
}

export function reportLogoRejection(reason: LogoProbeRejectReason): void {
  setSnapshot({ ...snapshot, lastRejection: reason, lastConversionFailure: null });
}

export function reportLogoConversionFailure(reason: LogoConversionFailureReason): void {
  setSnapshot({ ...snapshot, lastRejection: null, lastConversionFailure: reason });
}

/** Test-only: reset the module singleton between tests, mirroring
 *  `resetVocabularyForTests`. */
export function resetAppLogoForTests(): void {
  snapshot = { applied: DEFAULT_APP_LOGO_STATE, lastRejection: null, lastConversionFailure: null };
  hydrated = false;
  listeners.clear();
}

/* ---------------------------------------------------- decode and convert -- */

export type LogoConversionFailureReason =
  | "no-raster-surface"
  | "decode-failed"
  | "decode-mismatch"
  | "encode-failed"
  | "round-trip-failed"
  | "output-too-large";

export interface LogoConversionOk {
  readonly ok: true;
  readonly asset: CustomLogoAsset;
}
export interface LogoConversionFailed {
  readonly ok: false;
  readonly reason: LogoConversionFailureReason;
}
export type LogoConversionResult = LogoConversionOk | LogoConversionFailed;

export interface LogoConversionOptions {
  readonly fit: LogoFit;
  readonly background: string | null;
  readonly focal: FocalPoint;
  readonly cropBox: PixelCropBox | null;
}

/**
 * Whether this runtime can actually rasterize anything. Checked once, up
 * front, rather than letting a missing capability surface as a thrown
 * exception three steps into the pipeline — the same guarded-canvas
 * discipline `ColorPicker.tsx`'s `paintField` uses, hoisted to the entry
 * point so every caller downstream can assume a raster surface exists once
 * this has returned `true`.
 *
 * The test environment (`happy-dom`) creates a `<canvas>` element but ships
 * no 2D context implementation at all, so this deterministically returns
 * `false` there — which is exactly the "keep the prior valid logo active
 * when conversion fails" path this module exists to prove never corrupts
 * state, even when a real decode can never be exercised in that harness.
 */
function hasRasterSurface(): boolean {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  try {
    const canvas = document.createElement("canvas");
    return typeof canvas.getContext === "function" && !!canvas.getContext("2d");
  } catch {
    return false;
  }
}

interface DecodedBitmap {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
  readonly close: () => void;
}

async function decodeToBitmap(bytes: Uint8Array, format: "png" | "jpeg"): Promise<DecodedBitmap | null> {
  const mime = format === "png" ? "image/png" : "image/jpeg";
  if (typeof createImageBitmap !== "function" || typeof Blob === "undefined") return null;
  // A fresh Uint8Array view is handed to Blob rather than the original
  // buffer: `bytes` may be a subarray/view over a larger ArrayBuffer, and
  // Blob's BufferSource handling reads the *whole* underlying buffer unless
  // given a byte-range-correct copy.
  const blob = new Blob([bytes.slice()], { type: mime });
  const bitmap = await createImageBitmap(blob);
  return {
    width: bitmap.width,
    height: bitmap.height,
    source: bitmap,
    close: () => bitmap.close?.(),
  };
}

function drawVariant(bitmap: DecodedBitmap, size: number, opts: LogoConversionOptions): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, size, size);
  } else {
    ctx.clearRect(0, 0, size, size);
  }
  const sourceSize = { width: bitmap.width, height: bitmap.height };
  const src = computeSourceRect(sourceSize, opts.fit, opts.focal, opts.cropBox);
  const dest = computeDestRect(opts.fit, src, size);
  try {
    ctx.drawImage(bitmap.source, src.x, src.y, src.w, src.h, dest.x, dest.y, dest.w, dest.h);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Decode a probed candidate and produce every {@link LOGO_OUTPUT_SIZES}
 * variant, verifying each one before it is trusted.
 *
 * Three checks run per variant, in order: the decode itself must succeed and
 * report the dimensions the header already promised (a header that lied
 * would otherwise only be caught after real work had already happened); the
 * canvas encode must produce *something*; and that something must pass back
 * through the exact byte-signature parser a fresh upload goes through,
 * confirming it is a non-animated PNG of precisely the requested size. Any
 * failure anywhere in that chain aborts the whole conversion — nothing is
 * persisted and the caller's existing logo (preset or a previously converted
 * custom asset) is left completely untouched, which is what makes this safe
 * to call speculatively from a live preview step without risking the
 * committed state.
 */
export async function convertLogoImage(
  bytes: Uint8Array,
  probe: LogoProbeOk,
  opts: LogoConversionOptions,
): Promise<LogoConversionResult> {
  if (!hasRasterSurface()) return { ok: false, reason: "no-raster-surface" };

  let bitmap: DecodedBitmap | null;
  try {
    bitmap = await decodeToBitmap(bytes, probe.format);
  } catch {
    return { ok: false, reason: "decode-failed" };
  }
  if (!bitmap) return { ok: false, reason: "decode-failed" };
  if (bitmap.width !== probe.width || bitmap.height !== probe.height) {
    bitmap.close();
    return { ok: false, reason: "decode-mismatch" };
  }

  const variants: Partial<Record<LogoOutputSize, string>> = {};
  for (const size of LOGO_OUTPUT_SIZES) {
    const dataUri = drawVariant(bitmap, size, opts);
    if (!dataUri) {
      bitmap.close();
      return { ok: false, reason: "encode-failed" };
    }
    const roundTripBytes = bytesFromDataUri(dataUri);
    const roundTrip: LogoProbeResult | null = roundTripBytes ? probeImageBytes(roundTripBytes) : null;
    if (!roundTrip || !roundTrip.ok || roundTrip.format !== "png" || roundTrip.width !== size || roundTrip.height !== size) {
      bitmap.close();
      return { ok: false, reason: "round-trip-failed" };
    }
    variants[size] = dataUri;
  }
  bitmap.close();

  const totalBytes = Object.values(variants).reduce<number>((sum, uri) => sum + (uri?.length ?? 0), 0);
  if (totalBytes > LOGO_MAX_STORED_BYTES) return { ok: false, reason: "output-too-large" };

  return {
    ok: true,
    asset: {
      format: probe.format,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      fit: opts.fit,
      background: opts.background,
      focal: clampFocal(opts.focal),
      cropBox: opts.cropBox,
      variants,
    },
  };
}

/** Convenience wrapper: probe a file, then (only on success) convert it —
 *  the two-step pipeline `AppLogoPicker` drives, exposed as one call for
 *  callers that do not need to inspect the probe result independently. */
export async function probeAndConvertLogoFile(file: File, opts: LogoConversionOptions): Promise<
  | { ok: true; result: LogoConversionOk }
  | { ok: false; stage: "probe"; reason: LogoProbeRejectReason }
  | { ok: false; stage: "convert"; reason: LogoConversionFailureReason }
> {
  const probe = await probeLogoFile(file);
  if (!probe.ok) return { ok: false, stage: "probe", reason: probe.reason };
  const buffer = await file.arrayBuffer();
  const result = await convertLogoImage(new Uint8Array(buffer), probe, opts);
  if (!result.ok) return { ok: false, stage: "convert", reason: result.reason };
  return { ok: true, result };
}
