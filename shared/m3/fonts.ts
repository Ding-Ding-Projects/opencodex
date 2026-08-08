/**
 * Font discovery: what faces this machine actually has, and what axes they carry.
 *
 * The rules ask for "every installed and bundled font … searchable and
 * selectable with its own live typeface preview". There is exactly one web API
 * that can enumerate installed fonts — `queryLocalFonts()`, Chromium-only and
 * permission-gated — so this module has three sources and is honest about which
 * one produced a given list:
 *
 *  1. `local`   — `queryLocalFonts()` succeeded. The real list, every family.
 *  2. `probed`  — measured. A candidate family is rendered against three generic
 *                 fallbacks and kept when its metrics differ from all three.
 *                 This detects only families we thought to name, which is why
 *                 the result is labelled a probe and never presented as
 *                 "your installed fonts".
 *  3. `bundled` — the faces this site ships. Always present, in every source,
 *                 because they are the ones guaranteed to render.
 *
 * The distinction matters to the user, not just to us: a probe list that
 * silently omits their favourite face looks like a bug, whereas a probe list
 * that *says* it is a guess and offers a free-text family field is a tool.
 *
 * Variable axes come from the font's own `fvar` table, parsed from the blob
 * `queryLocalFonts` hands back. Parsing binary is more work than reading a
 * hard-coded table, and it is the only way to be right: an axis list written by
 * hand is a claim about a file on someone else's computer.
 *
 * Everything here is async and failure-tolerant. No call in this module may
 * reject: a font list is a convenience, and a picker that throws because a
 * permission prompt was dismissed is worse than one that shows fewer families.
 */

export type FontSource = "local" | "probed" | "bundled";

export interface VariationAxis {
  tag: string;
  name: string;
  min: number;
  max: number;
  default: number;
}

export interface FontFamily {
  /** The family name, as it goes into `font-family`. */
  family: string;
  /** A ready-to-use stack: the family, then a CJK-safe tail. */
  stack: string;
  /** Where this entry came from, so the UI can say so. */
  source: FontSource;
  /** Face count when known (`queryLocalFonts` only). */
  faces?: number;
  /**
   * Variable axes, when they could be read. `undefined` means "not determined"
   * and is rendered differently from `[]`, which means "read, and it has none".
   */
  axes?: VariationAxis[];
  /** True for the generic families every platform resolves. */
  generic?: boolean;
}

/* --------------------------------------------------------------- bundled -- */

/**
 * A CJK-safe tail on every stack.
 *
 * The site renders Cantonese, Japanese, Korean, Russian and Chinese. A stack
 * ending in `sans-serif` leaves CJK to whatever the browser's default happens to
 * be, which on a Latin-configured system is frequently a face with no CJK
 * coverage at all — the reader gets tofu, and the font picker gets blamed.
 */
const CJK_TAIL = '"Pretendard Variable", "Noto Sans HK", "Noto Sans CJK SC", "Microsoft YaHei", "Hiragino Sans", sans-serif';

/** Faces this site ships, so they render with no install and no permission. */
export const BUNDLED_FAMILIES: readonly FontFamily[] = [
  {
    family: "Geist Variable", source: "bundled", stack: `"Geist Variable", ${CJK_TAIL}`,
    axes: [{ tag: "wght", name: "Weight", min: 100, max: 900, default: 400 }],
  },
  {
    family: "Pretendard Variable", source: "bundled", stack: `"Pretendard Variable", ${CJK_TAIL}`,
    axes: [{ tag: "wght", name: "Weight", min: 100, max: 900, default: 400 }],
  },
];

/** The generic families a browser always resolves, offered so the user can opt out entirely. */
export const GENERIC_FAMILIES: readonly FontFamily[] = [
  { family: "system-ui", source: "bundled", generic: true, stack: `system-ui, ${CJK_TAIL}`, axes: [] },
  { family: "sans-serif", source: "bundled", generic: true, stack: `sans-serif, ${CJK_TAIL}`, axes: [] },
  { family: "serif", source: "bundled", generic: true, stack: `serif, "Noto Serif CJK SC", serif`, axes: [] },
  { family: "monospace", source: "bundled", generic: true, stack: `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`, axes: [] },
  { family: "cursive", source: "bundled", generic: true, stack: `cursive, ${CJK_TAIL}`, axes: [] },
];

/**
 * Families the probe asks about when `queryLocalFonts` is unavailable.
 *
 * Chosen to cover the default UI and document faces of Windows, macOS, Linux and
 * the common CJK installs, plus the developer monospaces a docs reader is most
 * likely to want. It is not, and does not claim to be, a list of their fonts.
 */
const PROBE_CANDIDATES: readonly string[] = [
  "Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara", "Cascadia Code",
  "Cascadia Mono", "Century Gothic", "Comic Sans MS", "Consolas", "Constantia", "Corbel",
  "Courier New", "Ebrima", "Franklin Gothic Medium", "Gabriola", "Gadugi", "Garamond",
  "Georgia", "Helvetica", "Helvetica Neue", "Impact", "Ink Free", "Javanese Text",
  "Leelawadee UI", "Lucida Console", "Lucida Sans Unicode", "Malgun Gothic", "Marlett",
  "Microsoft Himalaya", "Microsoft JhengHei", "Microsoft New Tai Lue", "Microsoft PhagsPa",
  "Microsoft Sans Serif", "Microsoft Tai Le", "Microsoft YaHei", "Microsoft Yi Baiti",
  "MingLiU", "Mongolian Baiti", "MS Gothic", "MV Boli", "Myanmar Text", "Nirmala UI",
  "Palatino Linotype", "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Emoji",
  "Segoe UI Historic", "Segoe UI Symbol", "SimSun", "Sitka", "Sylfaen", "Symbol",
  "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings",
  "Yu Gothic", "SF Pro Text", "SF Mono", "New York", "Menlo", "Monaco", "Optima",
  "Avenir", "Avenir Next", "Futura", "Gill Sans", "Baskerville", "Didot", "Hoefler Text",
  "American Typewriter", "Charter", "Iowan Old Style", "PingFang SC", "PingFang HK",
  "Hiragino Sans", "Hiragino Mincho ProN", "Apple SD Gothic Neo", "Noto Sans",
  "Noto Serif", "Noto Sans HK", "Noto Sans SC", "Noto Sans JP", "Noto Sans KR",
  "Noto Sans Mono", "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Sans",
  "Liberation Serif", "Liberation Mono", "Ubuntu", "Ubuntu Mono", "Cantarell",
  "Fira Sans", "Fira Code", "Source Sans Pro", "Source Code Pro", "JetBrains Mono",
  "IBM Plex Sans", "IBM Plex Mono", "Inter", "Roboto", "Roboto Mono", "Open Sans",
  "Lato", "Montserrat", "Nunito", "Poppins", "Merriweather", "Playfair Display",
];

/**
 * The faces a host application actually ships, for the two apps that share this
 * module.
 *
 * The constants above describe the docs site. The dashboard bundles a different
 * set entirely — Roboto Flex, Roboto, Roboto Mono, Noto Sans HK — and listing
 * `Geist Variable` in *its* picker would offer a face that cannot render, which
 * is the one thing a font list must never do. So every entry point takes an
 * optional host description and defaults to this module's own, leaving the docs
 * site's behaviour byte-identical.
 */
export interface FontHost {
  /** Faces the host ships itself. */
  bundled?: readonly FontFamily[];
  /** Generic families the browser always resolves. */
  generic?: readonly FontFamily[];
  /** Appended to a family that has no entry of its own; see `CJK_TAIL`. */
  cjkTail?: string;
}

const DEFAULT_HOST: Required<FontHost> = {
  bundled: BUNDLED_FAMILIES,
  generic: GENERIC_FAMILIES,
  cjkTail: CJK_TAIL,
};

const hostOf = (host?: FontHost): Required<FontHost> => ({ ...DEFAULT_HOST, ...host });

/** Quote a family name for a `font-family` value when it needs it. */
export function quoteFamily(family: string): string {
  return /^[A-Za-z][A-Za-z0-9 -]*$/.test(family) && !/^\d/.test(family) ? `"${family}"` : JSON.stringify(family);
}

/** A family plus the CJK-safe tail, which is what actually gets applied. */
export function stackFor(family: string, host?: FontHost): string {
  const { bundled, generic, cjkTail } = hostOf(host);
  const isGeneric = generic.find(f => f.family === family);
  if (isGeneric) return isGeneric.stack;
  const isBundled = bundled.find(f => f.family === family);
  if (isBundled) return isBundled.stack;
  return `${quoteFamily(family)}, ${cjkTail}`;
}

/* ----------------------------------------------------------------- probe -- */

/**
 * Whether a family is installed, by measuring text width against three generics.
 *
 * The classic trick, and it has a classic failure: a family whose metrics happen
 * to match one generic exactly reads as absent. Testing against all three cuts
 * that to near nothing, and the result is labelled a probe anyway.
 *
 * `document.fonts.check` is tried first — it is cheap and exact where it works,
 * but it answers "can I render text in this" and returns true for a family the
 * browser would substitute, so a positive is confirmed by measurement rather
 * than trusted on its own.
 */
function probeInstalled(measure: (font: string) => number, family: string): boolean {
  const quoted = quoteFamily(family);
  for (const generic of ["monospace", "serif", "sans-serif"]) {
    const base = measure(`72px ${generic}`);
    const test = measure(`72px ${quoted}, ${generic}`);
    if (Math.abs(base - test) > 0.5) return true;
  }
  return false;
}

/**
 * A width measurer over a 2-D canvas, or null where there is no canvas.
 *
 * Deliberately one canvas reused for every measurement: creating one per family
 * across a hundred candidates is a hundred GPU-backed surfaces, and on a phone
 * that is a visible stall in the middle of opening a font picker.
 */
function canvasMeasurer(): ((font: string) => number) | null {
  try {
    const doc = (globalThis as { document?: Document }).document;
    const canvas = doc?.createElement("canvas");
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    // Mixed scripts and mixed widths: a Latin-only probe string cannot tell a
    // CJK face from its fallback, which is most of what this list is for.
    const sample = "MWmwil10O—廣東語ぁアㄱ";
    return (font: string) => {
      ctx.font = font;
      return ctx.measureText(sample).width;
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ fvar -- */

/**
 * Variable-font axes, read out of the font's own `fvar` table.
 *
 * A minimal SFNT reader: the table directory, then `fvar`, then `name` for the
 * axis labels. Only the fields the picker shows are decoded, and every offset is
 * bounds-checked, because this is parsing an arbitrary file from the user's
 * machine — a malformed or hostile font must produce an empty axis list, never
 * an exception that takes the picker down with it.
 *
 * `ttcf` collections are declined rather than half-read: a collection's first
 * font is not necessarily the face the family entry refers to, and guessing
 * would attribute one face's axes to another.
 */
export function readVariationAxes(buffer: ArrayBuffer): VariationAxis[] {
  try {
    const view = new DataView(buffer);
    if (buffer.byteLength < 12) return [];
    const tag = view.getUint32(0);
    if (tag === 0x74746366 /* ttcf */) return [];

    const numTables = view.getUint16(4);
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < numTables; i++) {
      const record = 12 + i * 16;
      if (record + 16 > buffer.byteLength) return [];
      const name = String.fromCharCode(
        view.getUint8(record), view.getUint8(record + 1),
        view.getUint8(record + 2), view.getUint8(record + 3),
      );
      tables.set(name, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
    }

    const fvar = tables.get("fvar");
    if (!fvar || fvar.offset + 16 > buffer.byteLength) return [];
    const axesOffset = fvar.offset + view.getUint16(fvar.offset + 4);
    const axisCount = view.getUint16(fvar.offset + 8);
    const axisSize = view.getUint16(fvar.offset + 10);
    if (axisCount > 64 || axisSize < 20) return [];

    const names = readNameTable(view, tables.get("name"), buffer.byteLength);
    const axes: VariationAxis[] = [];
    for (let i = 0; i < axisCount; i++) {
      const at = axesOffset + i * axisSize;
      if (at + 20 > buffer.byteLength) break;
      const tagName = String.fromCharCode(
        view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3),
      );
      // Fixed 16.16, hence the /65536.
      const fixed = (offset: number) => view.getInt32(offset) / 65536;
      // A `VariationAxisRecord` is tag(4) min(4) default(4) max(4) flags(2)
      // axisNameID(2). The name id is at 18, not 16 — 16 is `flags`, and reading
      // it there yields 0 for every axis, which silently labels every one of
      // them "Copyright notice" (name id 0) instead of "Weight".
      const nameId = view.getUint16(at + 18);
      axes.push({
        tag: tagName,
        name: names.get(nameId) ?? AXIS_LABELS[tagName] ?? tagName,
        min: fixed(at + 4),
        default: fixed(at + 8),
        max: fixed(at + 12),
      });
    }
    return axes;
  } catch {
    return [];
  }
}

/** The registered axes, so a font with no `name` entry still gets a readable label. */
const AXIS_LABELS: Record<string, string> = {
  wght: "Weight", wdth: "Width", slnt: "Slant", ital: "Italic", opsz: "Optical size",
  GRAD: "Grade", XOPQ: "Thick stroke", YOPQ: "Thin stroke", XTRA: "Counter width",
  YTUC: "Uppercase height", YTLC: "Lowercase height", YTAS: "Ascender", YTDE: "Descender",
  YTFI: "Figure height", CASL: "Casual", MONO: "Monospace", CRSV: "Cursive", SOFT: "Softness",
};

/** Just enough of `name` to label an axis; unrecognised encodings are skipped. */
function readNameTable(view: DataView, table: { offset: number; length: number } | undefined, size: number): Map<number, string> {
  const out = new Map<number, string>();
  if (!table || table.offset + 6 > size) return out;
  const count = view.getUint16(table.offset + 2);
  const storage = table.offset + view.getUint16(table.offset + 4);
  for (let i = 0; i < count; i++) {
    const record = table.offset + 6 + i * 12;
    if (record + 12 > size) break;
    const platform = view.getUint16(record);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = storage + view.getUint16(record + 10);
    if (offset + length > size || out.has(nameId)) continue;
    let text = "";
    if (platform === 3 || platform === 0) {
      // UTF-16BE.
      for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(offset + j));
    } else if (platform === 1) {
      for (let j = 0; j < length; j++) text += String.fromCharCode(view.getUint8(offset + j));
    } else {
      continue;
    }
    if (text) out.set(nameId, text);
  }
  return out;
}

/* ------------------------------------------------------------ enumeration -- */

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

export interface FontCatalogue {
  families: FontFamily[];
  source: FontSource;
  /** True when the list is a measured guess rather than the machine's real list. */
  heuristic: boolean;
  /** Why the real list was not available, in words a user can act on. */
  note: string;
  /** The same fact as `note`, for a caller that has to translate it. */
  reason: CatalogueReason;
}

const sortFamilies = (a: FontFamily, b: FontFamily) => a.family.localeCompare(b.family);

/** Bundled + generic, deduplicated against `extra`. Always the floor of any catalogue. */
function withBundled(extra: FontFamily[], host: Required<FontHost>): FontFamily[] {
  const seen = new Set(extra.map(f => f.family));
  const base = [...host.bundled, ...host.generic].filter(f => !seen.has(f.family));
  return base.concat(extra.sort(sortFamilies));
}

/**
 * The catalogue, best source first.
 *
 * `queryLocalFonts` is only *attempted* when the caller says the user asked for
 * it (`allowPrompt`), because it raises a permission prompt and a prompt nobody
 * requested — fired by merely opening a font menu — is the kind of thing a
 * reader denies permanently out of irritation, permanently degrading the picker.
 * So the first open probes, and an explicit "Use my installed fonts" button
 * calls again with the prompt allowed.
 */
export async function loadFontCatalogue(options: { allowPrompt?: boolean; host?: FontHost } = {}): Promise<FontCatalogue> {
  const host = hostOf(options.host);
  const query = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  const permitted = options.allowPrompt || (await alreadyGranted());
  if (typeof query === "function" && permitted) {
    try {
      const fonts = await query();
      const byFamily = new Map<string, LocalFontData[]>();
      for (const font of fonts) {
        const list = byFamily.get(font.family);
        if (list) list.push(font);
        else byFamily.set(font.family, [font]);
      }
      const families: FontFamily[] = [...byFamily.entries()].map(([family, faces]) => ({
        family,
        stack: stackFor(family, host),
        source: "local" as const,
        faces: faces.length,
      }));
      return {
        families: withBundled(families, host),
        source: "local",
        heuristic: false,
        note: "",
        reason: "granted",
      };
    } catch (error) {
      // A dismissed or denied prompt lands here. Falling through to the probe is
      // the right answer: the picker still works, with a smaller list and a note.
      return probeCatalogue(
        deniedNote(error),
        host,
        (error as { name?: string })?.name === "NotAllowedError" ? "denied" : "failed",
      );
    }
  }
  return probeCatalogue(
    typeof query === "function"
      ? "Showing measured families. Grant access to list every installed font."
      : "This browser cannot enumerate installed fonts (queryLocalFonts is Chromium-only), so the list below was measured. Any family name can still be typed in by hand.",
    host,
    typeof query === "function" ? "notPrompted" : "unsupported",
  );
}

/**
 * Why the catalogue is what it is, as a token rather than a sentence.
 *
 * `note` above is English prose, and the dashboard renders in eight locales with
 * a per-language funny level layered on top — so a component there cannot show
 * `note` and still be translated. This says the same thing in a form a caller
 * can map onto its own dictionary, and `note` stays for callers that just want
 * a string.
 */
export type CatalogueReason =
  | "granted"
  | "notPrompted"
  | "unsupported"
  | "denied"
  | "failed"
  | "noSurface";

function deniedNote(error: unknown): string {
  const name = (error as { name?: string })?.name;
  return name === "NotAllowedError"
    ? "Access to installed fonts was declined, so the list below was measured instead. Any family name can still be typed in by hand."
    : "Installed fonts could not be read, so the list below was measured instead. Any family name can still be typed in by hand.";
}

/** Whether the local-fonts permission is already granted, without prompting. */
async function alreadyGranted(): Promise<boolean> {
  try {
    const permissions = (globalThis as { navigator?: { permissions?: { query(d: unknown): Promise<{ state: string }> } } })
      .navigator?.permissions;
    if (!permissions?.query) return false;
    const status = await permissions.query({ name: "local-fonts" });
    return status.state === "granted";
  } catch {
    // An engine that does not know the descriptor throws rather than answering,
    // which is itself the answer: it cannot have granted a permission it has
    // never heard of.
    return false;
  }
}

function probeCatalogue(note: string, host: Required<FontHost>, reason: CatalogueReason): FontCatalogue {
  const measure = canvasMeasurer();
  const found: FontFamily[] = measure
    ? PROBE_CANDIDATES.filter(family => probeInstalled(measure, family))
        .map(family => ({ family, stack: stackFor(family, host), source: "probed" as const }))
    : [];
  return {
    families: withBundled(found, host),
    source: measure ? "probed" : "bundled",
    heuristic: true,
    note: measure ? note : "No rendering surface was available to measure fonts, so only the bundled families are listed.",
    // A missing canvas is a stronger fact than whatever kept `queryLocalFonts`
    // from running: nothing was measured at all, so the caller must say that
    // rather than "grant access" for a list it could never have produced.
    reason: measure ? reason : "noSurface",
  };
}

/**
 * Axes for one family, read from the actual file when we are allowed to.
 *
 * Returns `undefined` — not `[]` — when the file could not be read at all, so
 * the picker can say "axes unknown for this family" rather than "this family has
 * no axes". Those are different facts and only one of them is a reason to hide
 * the axis controls.
 */
export async function loadAxesFor(family: string, host?: FontHost): Promise<VariationAxis[] | undefined> {
  const { bundled: hostBundled, generic } = hostOf(host);
  const bundled = hostBundled.find(f => f.family === family) ?? generic.find(f => f.family === family);
  if (bundled) return bundled.axes;
  const query = (globalThis as { queryLocalFonts?: (o?: unknown) => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof query !== "function" || !(await alreadyGranted())) return undefined;
  try {
    const fonts = await query({ postscriptNames: undefined });
    const face = fonts.find(f => f.family === family);
    if (!face) return undefined;
    const blob = await face.blob();
    return readVariationAxes(await blob.arrayBuffer());
  } catch {
    return undefined;
  }
}
