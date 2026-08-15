/**
 * Shared types for the universal file converter's registry and detection.
 *
 * Mirrors the shape `src/lib/pdf-tools/types.ts` already established: plain
 * data types that the registry, the detector, the fs-facing service, the HTTP
 * routes and the CLI all talk in, so no layer has to know how another layer is
 * implemented.
 */

/** The eight categories the contract names as a minimum. Order is display order. */
export type AdapterCategoryId =
  | "documents-pdf"
  | "images"
  | "audio"
  | "video"
  | "archives"
  | "structured-data"
  | "code-text"
  | "binary-encodings";

export const ADAPTER_CATEGORY_IDS: readonly AdapterCategoryId[] = [
  "documents-pdf",
  "images",
  "audio",
  "video",
  "archives",
  "structured-data",
  "code-text",
  "binary-encodings",
] as const;

/**
 * One known format the catalogue is aware of, whether or not it currently has
 * a working adapter. A format that stays disabled is still listed — hiding a
 * capability gap is exactly what the contract forbids.
 */
export interface CatalogFormat {
  /** Stable, lowercase, e.g. "pdf", "png", "mp3". Never derived from a filename. */
  id: string;
  /** Display name, e.g. "PDF", "PNG", "MP3". A proper noun — not translated. */
  label: string;
  category: AdapterCategoryId;
  /** Typical extensions, informational only — detection never trusts them. */
  extensions: readonly string[];
  /**
   * True only when every dependency the adapter needs is bundled inside this
   * install and proven reachable offline right now. Never true because a tool
   * happens to be on PATH or reachable over the network.
   */
  bundled: boolean;
  /** The thing that would need to be bundled for this to become enabled. Set only when `bundled` is false. */
  missingDependency?: string;
  /**
   * The exact, human-readable reason this format is disabled. Always set when
   * `bundled` is false, so the catalogue never shows a bare "disabled" with no
   * explanation.
   */
  reason?: string;
  /**
   * What an enabled adapter can actually do. For the PDF family this names the
   * seven pdf-tools operations rather than a single generic "convert", because
   * that is what the underlying, already-tested capability actually is.
   */
  operations?: readonly string[];
  /**
   * True when running this adapter can lose information or change metadata a
   * user might care about — the contract's "disclose before it runs" rule.
   * Left undefined when nothing is lost (inspection-only formats).
   */
  lossy?: boolean;
  lossyNote?: string;
}

export interface CatalogCategory {
  id: AdapterCategoryId;
  /** English label. The GUI has its own localized copy keyed by `id`; this exists for the CLI and for API consumers with no i18n layer. */
  label: string;
  formats: CatalogFormat[];
}

export interface ConverterCatalog {
  categories: CatalogCategory[];
  /** Total known formats across every category. */
  totalFormats: number;
  /** How many of those are actually enabled right now. */
  enabledFormats: number;
}

/** Why a source cannot be classified or operated on — mirrors `PdfBoundary`'s shape. */
export type DetectionBoundary = "empty" | "too-small" | "unreadable" | "too-large";

export interface DetectedSource {
  ok: boolean;
  boundary?: DetectionBoundary;
  reason?: string;
  /** Set only when `ok` and a signature was recognised. */
  formatId?: string;
  category?: AdapterCategoryId;
  /**
   * How the format was recognised — always a fact about the bytes actually
   * read, never a guess from a filename or claimed content-type.
   */
  evidence?: string;
  /** Bytes actually inspected to reach this verdict — a bounded number, never the whole file. */
  bytesInspected: number;
}
