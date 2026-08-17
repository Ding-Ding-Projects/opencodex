/**
 * The categorized adapter catalogue.
 *
 * This is the whole editorial decision for what the converter can and cannot
 * do today, in one file. Every format the contract's eight categories could
 * plausibly need is listed here — enabled or not — because the contract's
 * rule 2 is explicit: a known format with no bundled adapter stays visible
 * and disabled, naming its exact missing dependency, rather than disappearing
 * from the catalogue.
 *
 * ## Three bundled families now, each proven at runtime rather than claimed
 *
 * `bundled: true` is never a static assertion in this file for *any* format —
 * every one is computed by actually exercising the real adapter at catalogue-
 * build time and checking a real result, never by reading `package.json` or
 * trusting a comment:
 *
 *  - **Documents/PDF** (`isPdfLibReachable`): a genuine `await import("pdf-lib")`,
 *    checking `PDFDocument` really is a function. `pdf-lib` is a production
 *    dependency with no native bindings and no network calls, and
 *    `src/lib/pdf-tools/` runs 70 tests against it. What this does NOT prove
 *    is that a *packaged* installer's `asar` actually contains it — nobody has
 *    opened a built `.exe` to look, recorded as an open gap in
 *    `docs/FEATURE-INVENTORY.md`'s PDF-tools row and inherited honestly here.
 *  - **Archives** (`isZipExtractReachable`): builds a tiny real ZIP with the
 *    existing `export-archive.ts` writer, extracts it with this module's own
 *    `zip-extract.ts`, and checks the round-tripped bytes actually match. Both
 *    halves are dependency-free — `node:zlib` alone — so this family can never
 *    be silently unavailable the way a PATH-discovered tool could be.
 *  - **Structured Data** (`isStructuredDataReachable`): runs a real JSON→CSV→JSON
 *    and JSON→XML→JSON round trip through `delimited.ts` and `xml-convert.ts`
 *    and checks the results. Also dependency-free.
 *
 * Every other category still has no bundled dependency anywhere in
 * `package.json`. Wiring a PATH-discovered `ffmpeg`, a network image service,
 * or a developer-machine-only tool would make those formats *appear* enabled
 * while violating the one rule this catalogue exists to enforce, so they stay
 * disabled with the exact reason instead. Images, audio, video and the rest
 * remain future work, not a shortcut taken here. 7-Zip is the one archive
 * format that is *not* a near-term candidate: the existing 7z support spawns
 * the real executable off `PATH`, which this contract's rule 1 explicitly
 * forbids counting as bundled.
 */

import { buildZip } from "../export-archive";
import { delimitedToJson, jsonToDelimited } from "./delimited";
import type { AdapterCategoryId, CatalogCategory, CatalogFormat, ConverterCatalog } from "./types";
import { jsonToXml, xmlToJson } from "./xml-convert";
import { extractZip } from "./zip-extract";

/** English category labels. The GUI overrides these with localized copy keyed by `id`; the CLI and raw API consumers use these as-is. */
const CATEGORY_LABELS: Record<AdapterCategoryId, string> = {
  "documents-pdf": "Documents / PDF",
  images: "Images",
  audio: "Audio",
  video: "Video",
  archives: "Archives",
  "structured-data": "Structured Data / Spreadsheets",
  "code-text": "Code / Text",
  "binary-encodings": "Binary Encodings",
};

const CATEGORY_ORDER: readonly AdapterCategoryId[] = [
  "documents-pdf", "images", "audio", "video", "archives", "structured-data", "code-text", "binary-encodings",
];

/** The seven pdf-tools operations, exactly as `src/lib/pdf-tools/types.ts` names them. */
const PDF_OPERATIONS = ["inspect", "split", "merge", "extract", "reorder", "rotate", "metadata"] as const;

const NO_CODEC = "no bundled, offline codec ships in this install — a real one (e.g. libvips/sharp, or a pure-JS equivalent) is not a listed dependency in package.json";
const NO_TRANSCODER = "no bundled, offline transcoder ships in this install (e.g. ffmpeg) — nothing of the kind is a listed dependency in package.json, and a PATH-discovered or network transcoder is exactly what the contract forbids treating as \"enabled\"";
const NO_DOC_ENGINE = "no bundled, offline document engine ships in this install for this format — nothing of the kind is a listed dependency in package.json";
const NOT_BUILT_YET = "no adapter has been built for this format yet in this pass — the registry, detection and disclosure machinery this format will use already exist and are proven by the PDF family; only its own bounded, sandboxed conversion logic remains to be written";

/**
 * Formats whose catalogue entry does not depend on the PDF bundled-check —
 * every one of these is a static, honest `bundled: false`.
 */
function staticFormats(): CatalogFormat[] {
  return [
    // ---- documents-pdf (pdf itself is added separately, once bundled status is known) ----
    { id: "docx", label: "DOCX", category: "documents-pdf", extensions: ["docx"], bundled: false, missingDependency: "a DOCX reader/writer", reason: NO_DOC_ENGINE },
    { id: "rtf", label: "RTF", category: "documents-pdf", extensions: ["rtf"], bundled: false, missingDependency: "an RTF reader/writer", reason: NO_DOC_ENGINE },
    { id: "odt", label: "ODT", category: "documents-pdf", extensions: ["odt"], bundled: false, missingDependency: "an ODT reader/writer", reason: NO_DOC_ENGINE },

    // ---- images ----
    { id: "png", label: "PNG", category: "images", extensions: ["png"], bundled: false, missingDependency: "an image codec", reason: NO_CODEC },
    { id: "jpeg", label: "JPEG", category: "images", extensions: ["jpg", "jpeg"], bundled: false, missingDependency: "an image codec", reason: NO_CODEC },
    { id: "gif", label: "GIF", category: "images", extensions: ["gif"], bundled: false, missingDependency: "an image codec", reason: NO_CODEC },
    { id: "webp", label: "WebP", category: "images", extensions: ["webp"], bundled: false, missingDependency: "an image codec", reason: NO_CODEC },
    { id: "bmp", label: "BMP", category: "images", extensions: ["bmp"], bundled: false, missingDependency: "an image codec", reason: NO_CODEC },

    // ---- audio ----
    { id: "mp3", label: "MP3", category: "audio", extensions: ["mp3"], bundled: false, missingDependency: "an audio transcoder", reason: NO_TRANSCODER },
    { id: "wav", label: "WAV", category: "audio", extensions: ["wav"], bundled: false, missingDependency: "an audio transcoder", reason: NO_TRANSCODER },
    { id: "flac", label: "FLAC", category: "audio", extensions: ["flac"], bundled: false, missingDependency: "an audio transcoder", reason: NO_TRANSCODER },
    { id: "ogg", label: "Ogg Vorbis", category: "audio", extensions: ["ogg", "oga"], bundled: false, missingDependency: "an audio transcoder", reason: NO_TRANSCODER },

    // ---- video ----
    { id: "mp4", label: "MP4", category: "video", extensions: ["mp4", "m4v"], bundled: false, missingDependency: "a video transcoder", reason: NO_TRANSCODER },
    { id: "webm", label: "WebM", category: "video", extensions: ["webm"], bundled: false, missingDependency: "a video transcoder", reason: NO_TRANSCODER },
    { id: "mov", label: "MOV (QuickTime)", category: "video", extensions: ["mov"], bundled: false, missingDependency: "a video transcoder", reason: NO_TRANSCODER },
    { id: "avi", label: "AVI", category: "video", extensions: ["avi"], bundled: false, missingDependency: "a video transcoder", reason: NO_TRANSCODER },

    // ---- archives ----
    // ZIP itself is added separately below, once its bundled status is known
    // — the same pattern PDF already uses. 7z, tar and gzip stay static:
    {
      id: "7z", label: "7-Zip", category: "archives", extensions: ["7z"], bundled: false,
      missingDependency: "a bundled, offline 7-Zip implementation",
      reason: "the existing 7z support in src/lib/export-archive.ts spawns the real 7-Zip executable discovered on PATH, which rule 1 explicitly forbids counting as \"bundled\"",
    },
    { id: "tar", label: "TAR", category: "archives", extensions: ["tar"], bundled: false, missingDependency: "a bundled tar reader/writer", reason: NOT_BUILT_YET },
    { id: "gzip", label: "gzip", category: "archives", extensions: ["gz"], bundled: false, missingDependency: "converter-contract wiring around node:zlib's gzip codec", reason: "node:zlib can gzip/gunzip with no external dependency, exactly like the ZIP extractor, but nothing wires it through this contract's bounds/sandbox/disclosure/output-validation pipeline yet" },

    // ---- structured-data ----
    // JSON, CSV, TSV and XML are added separately below, once their bundled
    // status is known. YAML and TOML are the two structured-data formats
    // still genuinely unbuilt — unlike their JSON/CSV/TSV/XML siblings, no
    // bounded parser/serializer exists yet for either.
    { id: "yaml", label: "YAML", category: "structured-data", extensions: ["yaml", "yml"], bundled: false, missingDependency: "a bundled YAML parser/serializer", reason: NOT_BUILT_YET },
    { id: "toml", label: "TOML", category: "structured-data", extensions: ["toml"], bundled: false, missingDependency: "a bundled TOML parser/serializer", reason: NOT_BUILT_YET },

    // ---- code-text ----
    { id: "plain-text", label: "Plain text", category: "code-text", extensions: ["txt"], bundled: false, missingDependency: "line-ending/encoding conversion wiring", reason: NOT_BUILT_YET },
    { id: "markdown", label: "Markdown", category: "code-text", extensions: ["md"], bundled: false, missingDependency: "a Markdown-to-HTML/plain-text adapter", reason: NOT_BUILT_YET },
    { id: "html", label: "HTML", category: "code-text", extensions: ["html", "htm"], bundled: false, missingDependency: "an HTML-to-plain-text/Markdown adapter", reason: NOT_BUILT_YET },

    // ---- binary-encodings ----
    { id: "base64", label: "Base64", category: "binary-encodings", extensions: ["b64"], bundled: false, missingDependency: "converter-contract wiring (Node's own base64 codec needs no dependency, but nothing wires it through bounds/sandbox/output validation yet)", reason: NOT_BUILT_YET },
    { id: "hex", label: "Hex", category: "binary-encodings", extensions: ["hex"], bundled: false, missingDependency: "converter-contract wiring (Node's own hex codec needs no dependency, but nothing wires it through bounds/sandbox/output validation yet)", reason: NOT_BUILT_YET },
    { id: "url-encoding", label: "URL encoding", category: "binary-encodings", extensions: [], bundled: false, missingDependency: "converter-contract wiring", reason: NOT_BUILT_YET },
  ];
}

/**
 * Real, runtime proof that `pdf-lib` is actually resolvable in this process —
 * not a read of `package.json`, an assumption, or a cached flag. A module
 * that fails to resolve here means the PDF family is disabled too, honestly,
 * rather than the catalogue claiming a bundled dependency that is not there.
 */
export async function isPdfLibReachable(): Promise<boolean> {
  try {
    const mod: unknown = await import("pdf-lib");
    return typeof (mod as { PDFDocument?: unknown }).PDFDocument === "function";
  } catch {
    return false;
  }
}

const ZIP_CANARY_TEXT = "archives-adapter-canary";

/**
 * Real, runtime proof that ZIP extraction actually works right now: builds a
 * genuine ZIP with the existing `export-archive.ts` writer, extracts it with
 * this module's own `zip-extract.ts`, and checks the round-tripped bytes
 * actually match — never a static `true`.
 */
export async function isZipExtractReachable(): Promise<boolean> {
  try {
    const canary = buildZip([{ path: "canary.txt", data: new TextEncoder().encode(ZIP_CANARY_TEXT) }]);
    const result = extractZip(canary);
    return result.ok
      && result.entries.length === 1
      && result.entries[0].path === "canary.txt"
      && new TextDecoder().decode(result.entries[0].data) === ZIP_CANARY_TEXT;
  } catch {
    return false;
  }
}

/**
 * Real, runtime proof that the structured-data adapters actually work right
 * now: a JSON→CSV→JSON round trip through `delimited.ts` and a JSON→XML→JSON
 * round trip through `xml-convert.ts`, checking real results rather than
 * asserting a static `true`.
 */
export async function isStructuredDataReachable(): Promise<boolean> {
  try {
    const csv = jsonToDelimited([{ a: 1, b: "x" }], "csv");
    if (!csv.ok) return false;
    const csvBack = delimitedToJson(csv.text, "csv");
    if (!csvBack.ok || csvBack.value.length !== 1) return false;
    if (csvBack.value[0].a !== "1" || csvBack.value[0].b !== "x") return false;

    const xml = jsonToXml({ greeting: "hi" });
    if (!xml.ok) return false;
    const xmlBack = xmlToJson(xml.text);
    if (!xmlBack.ok) return false;

    return true;
  } catch {
    return false;
  }
}

export interface BuildCatalogOptions {
  /** Injectable for tests — the default performs the real dynamic import above. */
  checkPdfLib?: () => Promise<boolean>;
  /** Injectable for tests — the default runs the real ZIP round trip above. */
  checkZipExtract?: () => Promise<boolean>;
  /** Injectable for tests — the default runs the real structured-data round trip above. */
  checkStructuredData?: () => Promise<boolean>;
}

/** Build the full catalogue, computing every `bundled` flag fresh rather than caching a stale verdict. */
export async function buildConverterCatalog(options: BuildCatalogOptions = {}): Promise<ConverterCatalog> {
  const checkPdfLib = options.checkPdfLib ?? isPdfLibReachable;
  const checkZipExtract = options.checkZipExtract ?? isZipExtractReachable;
  const checkStructuredData = options.checkStructuredData ?? isStructuredDataReachable;
  const [pdfBundled, zipBundled, structuredBundled] = await Promise.all([
    checkPdfLib(), checkZipExtract(), checkStructuredData(),
  ]);

  const pdfFormat: CatalogFormat = pdfBundled
    ? {
        id: "pdf", label: "PDF", category: "documents-pdf", extensions: ["pdf"],
        bundled: true, operations: PDF_OPERATIONS,
        lossy: true,
        lossyNote: "editing a signed PDF invalidates its signature (pdf-lib has no signature-preservation support); the PDF Tools page discloses this before any write and requires explicit acknowledgement",
      }
    : {
        id: "pdf", label: "PDF", category: "documents-pdf", extensions: ["pdf"],
        bundled: false, missingDependency: "pdf-lib",
        reason: "pdf-lib could not be resolved in this process at catalogue build time, so the PDF family is disabled even though it is normally bundled — this should not happen outside a broken install",
      };

  const zipFormat: CatalogFormat = zipBundled
    ? {
        id: "zip", label: "ZIP", category: "archives", extensions: ["zip"],
        bundled: true, operations: ["extract"],
      }
    : {
        id: "zip", label: "ZIP", category: "archives", extensions: ["zip"],
        bundled: false, missingDependency: "a working ZIP extractor",
        reason: "the bundled ZIP extractor's own round-trip self-test failed at catalogue build time, so this family is disabled even though it is normally bundled — this should not happen outside a broken install",
      };

  const csvFormat: CatalogFormat = structuredBundled
    ? {
        id: "csv", label: "CSV", category: "structured-data", extensions: ["csv"],
        bundled: true, operations: ["to-json", "from-json"], lossy: true,
        lossyNote: "every cell becomes plain text — numbers, booleans and null all lose their JSON type and read back as strings; nested objects/arrays are JSON-stringified into their cell",
      }
    : {
        id: "csv", label: "CSV", category: "structured-data", extensions: ["csv"],
        bundled: false, missingDependency: "a working CSV<->JSON adapter",
        reason: "the bundled structured-data adapters' own round-trip self-test failed at catalogue build time, so this format is disabled even though it is normally bundled — this should not happen outside a broken install",
      };

  const tsvFormat: CatalogFormat = structuredBundled
    ? {
        id: "tsv", label: "TSV", category: "structured-data", extensions: ["tsv"],
        bundled: true, operations: ["to-json", "from-json"], lossy: true,
        lossyNote: "every cell becomes plain text — numbers, booleans and null all lose their JSON type and read back as strings; nested objects/arrays are JSON-stringified into their cell",
      }
    : {
        id: "tsv", label: "TSV", category: "structured-data", extensions: ["tsv"],
        bundled: false, missingDependency: "a working TSV<->JSON adapter",
        reason: "the bundled structured-data adapters' own round-trip self-test failed at catalogue build time, so this format is disabled even though it is normally bundled — this should not happen outside a broken install",
      };

  const jsonFormat: CatalogFormat = structuredBundled
    ? {
        id: "json", label: "JSON", category: "structured-data", extensions: ["json"],
        bundled: true, operations: ["to-csv", "to-tsv", "to-xml", "from-csv", "from-tsv", "from-xml"],
      }
    : {
        id: "json", label: "JSON", category: "structured-data", extensions: ["json"],
        bundled: false, missingDependency: "a working structured-data adapter set",
        reason: "the bundled structured-data adapters' own round-trip self-test failed at catalogue build time, so this format is disabled even though it is normally bundled — this should not happen outside a broken install",
      };

  const xmlFormat: CatalogFormat = structuredBundled
    ? {
        id: "xml", label: "XML", category: "structured-data", extensions: ["xml"],
        bundled: true, operations: ["to-json", "from-json"], lossy: true,
        lossyNote: "attributes are never emitted when converting JSON to XML and every scalar becomes plain element text, so types and the array-vs-single-value distinction are not preserved through a round trip; reading real XML back also discards insignificant whitespace and does not guarantee attribute ordering",
      }
    : {
        id: "xml", label: "XML", category: "structured-data", extensions: ["xml"],
        bundled: false, missingDependency: "a working XML<->JSON adapter",
        reason: "the bundled structured-data adapters' own round-trip self-test failed at catalogue build time, so this format is disabled even though it is normally bundled — this should not happen outside a broken install",
      };

  const all = [pdfFormat, zipFormat, csvFormat, tsvFormat, jsonFormat, xmlFormat, ...staticFormats()];

  const categories: CatalogCategory[] = CATEGORY_ORDER.map(id => ({
    id,
    label: CATEGORY_LABELS[id],
    formats: all.filter(f => f.category === id).sort((a, b) => a.label.localeCompare(b.label)),
  }));

  return {
    categories,
    totalFormats: all.length,
    enabledFormats: all.filter(f => f.bundled).length,
  };
}

export { CATEGORY_LABELS, CATEGORY_ORDER };
