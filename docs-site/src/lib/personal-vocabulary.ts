/**
 * Bounded, local-only vocabulary storage for the documentation site.
 *
 * The file is user supplied data, not a source of shipped copy. Until a
 * complete payload passes this module's schema, the site keeps its original
 * wording. The same parser is used for uploads and cached browser storage so
 * a cache cannot become trusted merely because it exists.
 */

export const VOCAB_SCHEMA_VERSION = 1 as const;
export const VOCAB_MAX_FILE_BYTES = 64 * 1024;
export const VOCAB_MAX_ENTRIES = 500;
export const VOCAB_MAX_KEY_LENGTH = 80;
export const VOCAB_MAX_VALUE_LENGTH = 200;
export const VOCAB_MAX_DEPTH = 2;
export const VOCAB_STORAGE_KEY = "ocx-docs:vocabulary:v1";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_TOP_LEVEL_KEYS = new Set(["version", "entries"]);

export interface VocabDoc {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

export type VocabRejectReason =
  | "empty-file" | "too-large" | "malformed-json" | "too-deep"
  | "not-an-object" | "unexpected-field" | "missing-field" | "unknown-version"
  | "entries-not-object" | "duplicate-key" | "unsafe-key" | "empty-key"
  | "key-too-long" | "non-string-value" | "value-too-long" | "too-many-entries";

export interface VocabRejection {
  readonly reason: VocabRejectReason;
  readonly detail?: string;
}

export type VocabParseResult =
  | { readonly ok: true; readonly doc: VocabDoc }
  | ({ readonly ok: false } & VocabRejection);

class JsonSyntaxError extends Error {}
class SchemaError extends Error {
  constructor(readonly reason: VocabRejectReason, readonly detail?: string) { super(reason); }
}

const WS = new Set([" ", "\t", "\n", "\r"]);

function parseGuardedJson(text: string): unknown {
  let index = 0;
  const fail = (message: string): never => { throw new JsonSyntaxError(`${message} at ${index}`); };

  function stringValue(): string {
    index++;
    let value = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') { index++; return value; }
      if (char === "\\") {
        index++;
        const escape = text[index];
        if (escape === '"' || escape === "\\" || escape === "/") value += escape;
        else if (escape === "b") value += "\b";
        else if (escape === "f") value += "\f";
        else if (escape === "n") value += "\n";
        else if (escape === "r") value += "\r";
        else if (escape === "t") value += "\t";
        else if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else fail("invalid escape");
        index++;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) fail("control character");
      value += char;
      index++;
    }
    fail("unterminated string");
  }

  function numberValue(): number {
    const start = index;
    if (text[index] === "-") index++;
    if (text[index] === "0") index++;
    else {
      if (!/[1-9]/.test(text[index] ?? "")) fail("invalid number");
      while (/[0-9]/.test(text[index] ?? "")) index++;
    }
    if (text[index] === ".") {
      index++;
      if (!/[0-9]/.test(text[index] ?? "")) fail("invalid number");
      while (/[0-9]/.test(text[index] ?? "")) index++;
    }
    if (text[index] === "e" || text[index] === "E") {
      index++;
      if (text[index] === "+" || text[index] === "-") index++;
      if (!/[0-9]/.test(text[index] ?? "")) fail("invalid number");
      while (/[0-9]/.test(text[index] ?? "")) index++;
    }
    return Number(text.slice(start, index));
  }

  function objectValue(depth: number): Record<string, unknown> {
    if (depth > VOCAB_MAX_DEPTH) throw new SchemaError("too-deep");
    index++;
    const value: Record<string, unknown> = {};
    const seen = new Set<string>();
    while (WS.has(text[index] ?? "")) index++;
    if (text[index] === "}") { index++; return value; }
    while (index < text.length) {
      while (WS.has(text[index] ?? "")) index++;
      if (text[index] !== '"') fail("expected object key");
      const key = stringValue();
      if (UNSAFE_KEYS.has(key)) throw new SchemaError("unsafe-key", key);
      if (seen.has(key)) throw new SchemaError("duplicate-key", key);
      seen.add(key);
      while (WS.has(text[index] ?? "")) index++;
      if (text[index] !== ":") fail("expected colon");
      index++;
      value[key] = valueAt(depth + 1);
      while (WS.has(text[index] ?? "")) index++;
      if (text[index] === "}") { index++; return value; }
      if (text[index] !== ",") fail("expected comma");
      index++;
    }
    fail("unterminated object");
  }

  function arrayValue(depth: number): unknown[] {
    if (depth > VOCAB_MAX_DEPTH) throw new SchemaError("too-deep");
    index++;
    const value: unknown[] = [];
    while (WS.has(text[index] ?? "")) index++;
    if (text[index] === "]") { index++; return value; }
    while (index < text.length) {
      value.push(valueAt(depth + 1));
      while (WS.has(text[index] ?? "")) index++;
      if (text[index] === "]") { index++; return value; }
      if (text[index] !== ",") fail("expected comma");
      index++;
    }
    fail("unterminated array");
  }

  function valueAt(depth: number): unknown {
    while (WS.has(text[index] ?? "")) index++;
    const char = text[index];
    if (char === "{") return objectValue(depth);
    if (char === "[") return arrayValue(depth);
    if (char === '"') return stringValue();
    if (char === "-" || /[0-9]/.test(char ?? "")) return numberValue();
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    fail("unexpected token");
  }

  const value = valueAt(1);
  while (WS.has(text[index] ?? "")) index++;
  if (index !== text.length) fail("trailing input");
  return value;
}

function validateShape(value: unknown): VocabParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "not-an-object" };
  const top = value as Record<string, unknown>;
  for (const key of Object.keys(top)) if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) return { ok: false, reason: "unexpected-field", detail: key };
  if (!("version" in top)) return { ok: false, reason: "missing-field", detail: "version" };
  if (!("entries" in top)) return { ok: false, reason: "missing-field", detail: "entries" };
  if (top.version !== VOCAB_SCHEMA_VERSION) return { ok: false, reason: "unknown-version" };
  const source = top.entries;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return { ok: false, reason: "entries-not-object" };
  const entriesSource = source as Record<string, unknown>;
  const keys = Object.keys(entriesSource);
  if (keys.length > VOCAB_MAX_ENTRIES) return { ok: false, reason: "too-many-entries" };
  const entries: Record<string, string> = {};
  for (const key of keys) {
    if (key.length === 0) return { ok: false, reason: "empty-key" };
    if (key.length > VOCAB_MAX_KEY_LENGTH) return { ok: false, reason: "key-too-long", detail: key };
    const replacement = entriesSource[key];
    if (typeof replacement !== "string") return { ok: false, reason: "non-string-value", detail: key };
    if (replacement.length > VOCAB_MAX_VALUE_LENGTH) return { ok: false, reason: "value-too-long", detail: key };
    entries[key] = replacement;
  }
  return { ok: true, doc: { version: VOCAB_SCHEMA_VERSION, entries } };
}

export function parseVocabularyJSON(raw: string): VocabParseResult {
  if (raw.trim().length === 0) return { ok: false, reason: "empty-file" };
  if (new TextEncoder().encode(raw).byteLength > VOCAB_MAX_FILE_BYTES) return { ok: false, reason: "too-large" };
  try {
    return validateShape(parseGuardedJson(raw));
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, reason: error.reason, detail: error.detail };
    return { ok: false, reason: "malformed-json", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function validateVocabularyFile(file: File): Promise<VocabParseResult> {
  if (file.size === 0) return { ok: false, reason: "empty-file" };
  if (file.size > VOCAB_MAX_FILE_BYTES) return { ok: false, reason: "too-large" };
  return parseVocabularyJSON(await file.text());
}

const PLACEHOLDER = /(\{[a-zA-Z0-9_]+\})/g;
function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Apply only to authored text segments, never to runtime placeholder values. */
export function applyVocabularyToTemplate(template: string, entries: Readonly<Record<string, string>> | null): string {
  if (!entries) return template;
  const terms = Object.keys(entries).sort((left, right) => right.length - left.length);
  if (terms.length === 0) return template;
  const lookup = new Map(Object.entries(entries));
  const pattern = new RegExp(terms.map(escapePattern).join("|"), "g");
  const segments = template.split(PLACEHOLDER);
  for (let i = 0; i < segments.length; i += 2) segments[i] = segments[i]!.replace(pattern, match => lookup.get(match) ?? match);
  return segments.join("");
}

export interface VocabStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VocabState {
  readonly doc: VocabDoc | null;
  readonly loadedAt: number | null;
  readonly lastRejection: VocabRejection | null;
}

const EMPTY_STATE: VocabState = { doc: null, loadedAt: null, lastRejection: null };
let state = EMPTY_STATE;
let hydrated = false;
let operation = 0;
const listeners = new Set<() => void>();

function storageOf(storage?: VocabStorageLike): VocabStorageLike | undefined {
  return storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
}

function setState(next: VocabState): void {
  state = next;
  for (const listener of listeners) listener();
}

function ensureHydrated(storage?: VocabStorageLike): void {
  if (hydrated) return;
  hydrated = true;
  const store = storageOf(storage);
  if (!store) return;
  try {
    const raw = store.getItem(VOCAB_STORAGE_KEY);
    if (raw === null) return;
    const result = parseVocabularyJSON(raw);
    if (result.ok) state = { doc: result.doc, loadedAt: null, lastRejection: null };
    else state = { ...EMPTY_STATE, lastRejection: { reason: result.reason, detail: result.detail } };
  } catch {
    state = { ...EMPTY_STATE, lastRejection: { reason: "malformed-json" } };
  }
}

export function getVocabularySnapshot(): VocabState { ensureHydrated(); return state; }
export function subscribeVocabulary(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadVocabularyFile(file: File, storage?: VocabStorageLike): Promise<VocabParseResult> {
  ensureHydrated(storage);
  const ticket = ++operation;
  const result = await validateVocabularyFile(file);
  if (ticket !== operation) return result;
  if (!result.ok) {
    setState({ ...state, lastRejection: { reason: result.reason, detail: result.detail } });
    return result;
  }
  try { storageOf(storage)?.setItem(VOCAB_STORAGE_KEY, JSON.stringify(result.doc)); } catch { /* browser quota: keep this session's valid state */ }
  setState({ doc: result.doc, loadedAt: Date.now(), lastRejection: null });
  return result;
}

export function clearVocabulary(storage?: VocabStorageLike): void {
  operation++;
  try { storageOf(storage)?.removeItem(VOCAB_STORAGE_KEY); } catch { /* already absent or unavailable */ }
  setState(EMPTY_STATE);
}

export function getActiveVocabularyEntries(): Readonly<Record<string, string>> | null {
  return getVocabularySnapshot().doc?.entries ?? null;
}

export function resetVocabularyForTests(): void {
  operation++;
  state = EMPTY_STATE;
  hydrated = false;
  listeners.clear();
}
