/**
 * The personal-vocabulary layer — a private, local find-and-replace glossary
 * applied to rendered copy, per the universal "local personal-vocabulary JSON
 * upload" contract every user-facing surface carries.
 *
 * ## Where this sits
 *
 * `resolve.ts`'s `translate()` is the one path from a dictionary key to the
 * string a user reads — its own doc comment says so, and `t()` calls nothing
 * else. That makes it the text boundary this module hooks: `translate()` asks
 * this module for the active vocabulary once per lookup and runs it over the
 * *resolved template*, before `interpolate()` fills in `{placeholder}`s with
 * `vars`.
 *
 * That ordering is not an implementation detail, it is the privacy and safety
 * boundary. A template is authored prose — the dictionary's own words. `vars`
 * are the opposite: a model id, a file path, a port number, a server's own
 * error text, quoted verbatim. Applying the vocabulary to the template *before*
 * `vars` are substituted in means a term can only ever match authored copy,
 * never a value that arrived at runtime — so a user whose vocabulary happens to
 * define "port" cannot accidentally turn `8080` into something else, and a
 * command, URL, identifier or file path threaded through `{cmd}` stays byte for
 * byte what the system produced. See `applyVocabularyToTemplate` below for the
 * mechanism that keeps `{placeholder}` tokens themselves out of reach too.
 *
 * ## What this module deliberately does not do
 *
 * - It never touches `resolveTrack()` directly. That function also backs the
 *   narrator's spoken-sample preview in `LanguageVoice.tsx`, which reads a
 *   *single* voice track outside of `t()` on purpose (see the comment on
 *   `sampleFor` there) so a bilingual join can never feed one voice both
 *   languages. Vocabulary substitution is scoped to `translate()`, the one
 *   function the contract names as the boundary; the narrator preview is out of
 *   scope for this pass and stays exactly as it renders today.
 * - It never makes a network request. Every function below is synchronous or
 *   resolves from a `File` the user picked and `localStorage` — nothing here
 *   imports `fetch`, and the test suite asserts that directly.
 * - It never ships a real mapping. The constants and the parser are the whole
 *   feature; the only entries that ever exist are the ones a user's own file
 *   supplies. No sample, template or example term lives in this file, in its
 *   tests, or in the settings screen that drives it.
 *
 * ## The schema
 *
 * ```json
 * { "version": 1, "entries": { "term": "replacement" } }
 * ```
 *
 * A flat map of literal terms to their replacement text, wrapped in a version
 * envelope so a future incompatible shape can be introduced without silently
 * misreading an old file. See the `VOCAB_MAX_*` constants for the bounds every
 * file is validated against, and `VocabRejectReason` for the exhaustive list of
 * ways a file can be refused.
 */

/** The only schema version this build understands. */
export const VOCAB_SCHEMA_VERSION = 1 as const;

/**
 * Hard file-size ceiling, checked against `File.size` *before* the file is
 * read into memory. A vocabulary is a short glossary, not a document — 64 KiB
 * is generous for thousands of short terms and small enough that even a
 * rejected file costs nothing to refuse.
 */
export const VOCAB_MAX_FILE_BYTES = 64 * 1024;

/** At most this many term → replacement pairs in one file. */
export const VOCAB_MAX_ENTRIES = 500;

/** A term longer than this is refused outright rather than silently truncated. */
export const VOCAB_MAX_KEY_LENGTH = 80;

/** A replacement longer than this is refused outright rather than silently truncated. */
export const VOCAB_MAX_VALUE_LENGTH = 200;

/**
 * How many JSON object literals may nest inside one another: the top-level
 * envelope (depth 1) holding `entries` (depth 2). An entry's own value must be
 * a string, so nothing legitimate ever needs a third level — a file that has
 * one is refused as `"too-deep"` rather than silently flattened or truncated.
 */
export const VOCAB_MAX_DEPTH = 2;

/**
 * Keys that would shadow `Object.prototype` if merged into a plain object
 * carelessly elsewhere in the app. Refused wherever a JSON object key appears
 * in a vocabulary file, at any nesting level — the top-level envelope as much
 * as an individual term.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The only fields the top-level envelope may carry. */
const ALLOWED_TOP_LEVEL_KEYS = new Set(["version", "entries"]);

export interface VocabDoc {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

/**
 * Every way a candidate file can be refused, named rather than counted — a
 * settings screen that has to explain "invalid" owes the reader which of these
 * it was, not a number.
 */
export type VocabRejectReason =
  | "empty-file"
  | "too-large"
  | "malformed-json"
  | "too-deep"
  | "not-an-object"
  | "unexpected-field"
  | "missing-field"
  | "unknown-version"
  | "entries-not-object"
  | "duplicate-key"
  | "unsafe-key"
  | "empty-key"
  | "key-too-long"
  | "non-string-value"
  | "value-too-long"
  | "too-many-entries";

export interface VocabRejection {
  readonly reason: VocabRejectReason;
  /** A technical fragment (the offending key, a parser position) — never shown
   *  to a user directly; the settings screen maps `reason` to localized copy. */
  readonly detail?: string;
}

export type VocabParseResult =
  | { ok: true; doc: VocabDoc }
  | ({ ok: false } & VocabRejection);

/** Failures from the local state machine rather than from the uploaded file. */
export type VocabOperationReason = "persistence-failed" | "clear-failed" | "superseded";

export interface VocabOperationFailure {
  readonly reason: VocabOperationReason;
}

export type VocabLoadResult = VocabParseResult | ({ ok: false } & VocabOperationFailure);
export type VocabClearResult = { ok: true } | ({ ok: false } & VocabOperationFailure);

/* --------------------------------------------------------------------------
 * A minimal recursive-descent JSON parser.
 *
 * `JSON.parse` cannot be reused here for one specific reason: when an object
 * literal repeats a key, `JSON.parse` silently keeps the last one and gives no
 * way to tell afterwards that a collision happened. The schema's own contract
 * requires rejecting duplicate keys outright, so detecting them has to happen
 * while the raw text is still being walked — which means walking it ourselves.
 *
 * Depth and per-key/value bounds are enforced inline, during the walk, rather
 * than after building a full value: a pathological file cannot make this parser
 * do more work than its own bounded size already allows, because nesting past
 * `VOCAB_MAX_DEPTH` aborts immediately rather than continuing to descend.
 * -------------------------------------------------------------------------- */

/** Raised for input that is not syntactically valid JSON at all. */
class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

/** Raised for syntactically valid JSON that already violates the schema in a
 *  way only the parser itself can see — a duplicate or unsafe key, or nesting
 *  past the allowed depth. Structural checks that do not need the raw text
 *  (missing fields, wrong types, length bounds) happen afterwards, in
 *  {@link validateShape}. */
class VocabSchemaViolation extends Error {
  readonly reason: VocabRejectReason;
  readonly detail?: string;
  constructor(reason: VocabRejectReason, detail?: string) {
    super(detail ?? reason);
    this.name = "VocabSchemaViolation";
    this.reason = reason;
    this.detail = detail;
  }
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function parseGuardedJson(text: string): unknown {
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    while (i < n && WHITESPACE.has(text[i]!)) i++;
  }

  function fail(message: string): never {
    throw new JsonSyntaxError(`${message} at offset ${i}`);
  }

  function parseString(): string {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        i++;
        const e = text[i];
        if (e === '"' || e === "\\" || e === "/") out += e;
        else if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail("invalid escape sequence");
        i++;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fail("control character in string");
      out += c;
      i++;
    }
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else {
      if (!(text[i]! >= "1" && text[i]! <= "9")) fail("invalid number");
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    }
    if (text[i] === ".") {
      i++;
      if (!(text[i]! >= "0" && text[i]! <= "9")) fail("invalid number");
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!(text[i]! >= "0" && text[i]! <= "9")) fail("invalid number");
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    }
    return Number(text.slice(start, i));
  }

  function parseLiteral(): boolean | null {
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    fail("unexpected token");
  }

  function parseObject(depth: number): Record<string, unknown> {
    if (depth > VOCAB_MAX_DEPTH) throw new VocabSchemaViolation("too-deep");
    i++; // {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWs();
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail("expected a string key");
      const key = parseString();
      if (UNSAFE_KEYS.has(key)) throw new VocabSchemaViolation("unsafe-key", key);
      if (seen.has(key)) throw new VocabSchemaViolation("duplicate-key", key);
      seen.add(key);
      skipWs();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      out[key] = parseValue(depth + 1);
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      fail("expected ',' or '}'");
    }
    return out;
  }

  function parseArray(depth: number): unknown[] {
    if (depth > VOCAB_MAX_DEPTH) throw new VocabSchemaViolation("too-deep");
    i++; // [
    const out: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue(depth + 1));
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      fail("expected ',' or ']'");
    }
    return out;
  }

  function parseValue(depth: number): unknown {
    skipWs();
    const c = text[i];
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (c === "t" || c === "f" || c === "n") return parseLiteral();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return parseNumber();
    fail("unexpected character");
  }

  const result = parseValue(1);
  skipWs();
  if (i !== n) fail("trailing characters after the JSON value");
  return result;
}

/** Structural validation of an already-parsed value against the schema —
 *  field presence, the version number, and every bound that does not need the
 *  raw text (duplicate/unsafe keys and nesting depth are already enforced by
 *  the parser above). */
function validateShape(raw: unknown): VocabParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not-an-object" };
  }
  const top = raw as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) return { ok: false, reason: "unexpected-field", detail: key };
  }
  if (!("version" in top)) return { ok: false, reason: "missing-field", detail: "version" };
  if (!("entries" in top)) return { ok: false, reason: "missing-field", detail: "entries" };
  if (top.version !== VOCAB_SCHEMA_VERSION) return { ok: false, reason: "unknown-version" };

  const entriesRaw = top.entries;
  if (typeof entriesRaw !== "object" || entriesRaw === null || Array.isArray(entriesRaw)) {
    return { ok: false, reason: "entries-not-object" };
  }
  const entriesObj = entriesRaw as Record<string, unknown>;
  const keys = Object.keys(entriesObj);
  if (keys.length > VOCAB_MAX_ENTRIES) return { ok: false, reason: "too-many-entries" };

  const entries: Record<string, string> = {};
  for (const key of keys) {
    if (key.length === 0) return { ok: false, reason: "empty-key" };
    if (key.length > VOCAB_MAX_KEY_LENGTH) return { ok: false, reason: "key-too-long", detail: key };
    const value = entriesObj[key];
    if (typeof value !== "string") return { ok: false, reason: "non-string-value", detail: key };
    if (value.length > VOCAB_MAX_VALUE_LENGTH) return { ok: false, reason: "value-too-long", detail: key };
    entries[key] = value;
  }
  return { ok: true, doc: { version: VOCAB_SCHEMA_VERSION, entries } };
}

/**
 * Validate a complete JSON payload against the schema, end to end. Pure and
 * synchronous — no I/O, so this is exactly what re-validates a cached string
 * before it is trusted, as much as it is what validates a freshly uploaded
 * file's contents.
 */
export function parseVocabularyJSON(raw: string): VocabParseResult {
  if (raw.trim().length === 0) return { ok: false, reason: "empty-file" };
  // Belt and braces: the file-level check below runs first against `File.size`
  // without reading bytes, but a cached string re-validated from storage has no
  // `File` behind it, so the same ceiling is enforced here on the text itself.
  if (new TextEncoder().encode(raw).length > VOCAB_MAX_FILE_BYTES) return { ok: false, reason: "too-large" };
  let parsed: unknown;
  try {
    parsed = parseGuardedJson(raw);
  } catch (error) {
    if (error instanceof VocabSchemaViolation) return { ok: false, reason: error.reason, detail: error.detail };
    return { ok: false, reason: "malformed-json", detail: error instanceof Error ? error.message : String(error) };
  }
  return validateShape(parsed);
}

/**
 * Validate a user-picked `File` end to end. The size check runs against
 * `File.size` — metadata the browser already has — before `file.text()` is
 * ever called, so an oversized file is refused without its contents being
 * read into memory at all. `file.text()` itself is the browser's local
 * `FileReader` machinery; nothing here reaches the network.
 */
export async function validateVocabularyFile(file: File): Promise<VocabParseResult> {
  if (file.size === 0) return { ok: false, reason: "empty-file" };
  if (file.size > VOCAB_MAX_FILE_BYTES) return { ok: false, reason: "too-large" };
  const text = await file.text();
  return parseVocabularyJSON(text);
}

/* --------------------------------------------------------------------------
 * Applying the vocabulary at the text boundary.
 * -------------------------------------------------------------------------- */

/**
 * Matches exactly the placeholder shape `interpolate()` in `shared.ts`
 * substitutes — `{` + one or more word characters + `}`. Kept in lockstep with
 * that function on purpose: it is the one thing standing between a vocabulary
 * term and a variable slot, so if the two ever disagreed about what a
 * placeholder looks like, a term could corrupt one.
 */
const PLACEHOLDER_RE = /(\{[a-zA-Z0-9_]+\})/g;

function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The compiled matcher for the vocabulary currently in `entries`, memoized on
 *  the exact object reference so `translate()` — called on every render — does
 *  not rebuild a regex from scratch per lookup. Vocabulary state is always
 *  replaced wholesale (see `setState` below), never mutated in place, so
 *  reference equality is a valid cache key. */
let compiledForEntries: Readonly<Record<string, string>> | null = null;
let compiledPattern: RegExp | null = null;
let compiledLookup: Map<string, string> | null = null;

function compileMatcher(entries: Readonly<Record<string, string>>): { pattern: RegExp; lookup: Map<string, string> } | null {
  if (compiledForEntries === entries) {
    return compiledPattern && compiledLookup ? { pattern: compiledPattern, lookup: compiledLookup } : null;
  }
  compiledForEntries = entries;
  const terms = Object.keys(entries);
  if (terms.length === 0) {
    compiledPattern = null;
    compiledLookup = null;
    return null;
  }
  // Longest term first: a multi-word phrase must be matched whole before a
  // shorter term that happens to sit inside it can split it into two separate
  // replacements. A single alternation regex, rather than one `.replace()` per
  // term, also means a term can never be replaced twice — once matched, the
  // scan continues *after* the replacement text, never back over it.
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  compiledPattern = new RegExp(sorted.map(escapeForRegExp).join("|"), "g");
  compiledLookup = new Map(Object.entries(entries));
  return { pattern: compiledPattern, lookup: compiledLookup };
}

/**
 * Apply the active vocabulary to one resolved dictionary template — the raw
 * string `resolveTrack()` produces, still carrying its `{placeholder}` tokens
 * and not yet interpolated with `vars`.
 *
 * The template is split on placeholders first, and every term is matched only
 * inside the literal prose segments in between — never inside a `{token}`
 * itself. That is what keeps a vocabulary term from ever being able to rewrite
 * a placeholder into something `interpolate()` no longer recognises, and it is
 * also what keeps every value that arrives through `vars` — a path, a model
 * id, a command, a server's own error text — completely outside the
 * vocabulary's reach: those are substituted in *after* this function returns,
 * so they were never present in the text this function actually saw.
 *
 * A `null` or empty vocabulary is the overwhelmingly common case — nobody has
 * uploaded a file yet — and returns the template completely untouched, with no
 * allocation beyond the one comparison. That is what keeps every existing i18n
 * test passing unchanged: with no vocabulary loaded, `translate()` behaves
 * exactly as it did before this module existed.
 */
export function applyVocabularyToTemplate(
  template: string,
  entries: Readonly<Record<string, string>> | null,
): string {
  if (!entries || Object.keys(entries).length === 0) return template;
  const compiled = compileMatcher(entries);
  if (!compiled) return template;
  const { pattern, lookup } = compiled;
  const segments = template.split(PLACEHOLDER_RE);
  for (let i = 0; i < segments.length; i += 2) {
    segments[i] = segments[i]!.replace(pattern, matched => lookup.get(matched) ?? matched);
  }
  return segments.join("");
}

/* --------------------------------------------------------------------------
 * Local-only persistence and the in-memory store `translate()` reads.
 * -------------------------------------------------------------------------- */

/** The subset of `Storage` this module needs, so tests can hand in a plain
 *  object instead of standing up a real `Storage` implementation. */
export interface VocabStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const VOCAB_STORAGE_KEY = "ocx-vocab:v1";

function resolveStorage(storage?: VocabStorageLike): VocabStorageLike | undefined {
  if (storage) return storage;
  // SSR/test environments without a DOM: no storage is a valid state, not an
  // error. `typeof` never throws on an undeclared global, which is what makes
  // this safe to evaluate even where `localStorage` was never defined at all.
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export interface VocabState {
  readonly doc: VocabDoc | null;
  /** Epoch ms of the most recent successful load, or `null` when nothing is
   *  active. Display-only — never exported, never logged. */
  readonly loadedAt: number | null;
  /** The most recent rejection, if the most recent attempt to load a file
   *  failed. Cleared on the next successful load and on `clearVocabulary()`. */
  readonly lastRejection: (VocabRejection | VocabOperationFailure) | null;
}

const EMPTY_STATE: VocabState = { doc: null, loadedAt: null, lastRejection: null };

let state: VocabState = EMPTY_STATE;
let hydrated = false;
const listeners = new Set<() => void>();

function setState(next: VocabState): void {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Re-validate the persisted cache through the exact same parser a freshly
 * uploaded file goes through, and fail closed — return `null`, meaning "no
 * vocabulary active, render the original shipped wording" — for anything
 * missing, corrupt, or written by a schema version this build no longer
 * understands. The cache is never trusted on the strength of merely existing.
 */
function readCache(storage?: VocabStorageLike): VocabDoc | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(VOCAB_STORAGE_KEY);
    if (raw === null) return null;
    const result = parseVocabularyJSON(raw);
    return result.ok ? result.doc : null;
  } catch {
    return null;
  }
}

function writeCache(doc: VocabDoc, storage?: VocabStorageLike): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(VOCAB_STORAGE_KEY, JSON.stringify(doc));
    return true;
  } catch {
    /* Quota or private-mode refusal is a hard boundary: applying in memory
     * would make the active state diverge from what a reload can recover. */
    return false;
  }
}

function removeCache(storage?: VocabStorageLike): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(VOCAB_STORAGE_KEY);
    return true;
  } catch {
    /* A refusal leaves the durable cache unknown, so memory must stay put. */
    return false;
  }
}

/** Hydrate in-memory state from the persisted cache, once per module
 *  lifetime (once per page load, in practice). Lazy rather than a top-level
 *  side effect, so importing this module in a non-DOM test never touches
 *  `localStorage` unless something actually asks for the vocabulary. */
function ensureHydrated(storage?: VocabStorageLike): void {
  if (hydrated) return;
  hydrated = true;
  const cached = readCache(storage);
  if (cached) state = { doc: cached, loadedAt: null, lastRejection: null };
}

/**
 * The active vocabulary's entries, or `null` when nothing is loaded — what
 * `translate()` in `resolve.ts` reads on every lookup. Synchronous by
 * necessity: `translate()` has no way to await anything mid-render.
 */
export function getActiveVocabularyEntries(): Readonly<Record<string, string>> | null {
  ensureHydrated();
  return state.doc?.entries ?? null;
}

export function getVocabularySnapshot(): VocabState {
  ensureHydrated();
  return state;
}

export function subscribeVocabulary(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Validate and, on success, activate a user-picked file. On rejection, the
 * active vocabulary — including a previously loaded one — is left completely
 * untouched; only `lastRejection` changes, so a settings screen can explain
 * what was wrong without the rest of the app losing what was already working.
 * This is the "a rejected file never applies partially" half of the contract.
 */
let operationGeneration = 0;

export async function loadVocabularyFile(file: File, storage?: VocabStorageLike): Promise<VocabLoadResult> {
  ensureHydrated(storage);
  const generation = ++operationGeneration;
  const result = await validateVocabularyFile(file);
  if (generation !== operationGeneration) return { ok: false, reason: "superseded" };
  if (!result.ok) {
    setState({ ...state, lastRejection: { reason: result.reason, detail: result.detail } });
    return result;
  }
  if (!writeCache(result.doc, storage)) {
    setState({ ...state, lastRejection: { reason: "persistence-failed" } });
    return { ok: false, reason: "persistence-failed" };
  }
  if (generation !== operationGeneration) return { ok: false, reason: "superseded" };
  setState({ doc: result.doc, loadedAt: Date.now(), lastRejection: null });
  return result;
}

/**
 * Purge the cache and restore the original shipped wording immediately —
 * every subsequent `translate()` call sees `entries === null` from the very
 * next render, because `setState` notifies every subscriber synchronously.
 */
export function clearVocabulary(storage?: VocabStorageLike): VocabClearResult {
  ensureHydrated(storage);
  const generation = ++operationGeneration;
  if (!removeCache(storage)) {
    setState({ ...state, lastRejection: { reason: "clear-failed" } });
    return { ok: false, reason: "clear-failed" };
  }
  if (generation !== operationGeneration) return { ok: false, reason: "superseded" };
  setState(EMPTY_STATE);
  return { ok: true };
}

/** Test-only: reset the module singleton between tests without touching
 *  whatever storage mock a test installed on `globalThis`. Mirrors the
 *  `resetApiAuthFetchForTests` / `resetVocabularyForTests` pattern already
 *  used for the other module-level stores in this codebase. */
export function resetVocabularyForTests(): void {
  state = EMPTY_STATE;
  hydrated = false;
  compiledForEntries = null;
  compiledPattern = null;
  compiledLookup = null;
  operationGeneration = 0;
  listeners.clear();
}
