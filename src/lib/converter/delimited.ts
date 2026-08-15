/**
 * CSV/TSV <-> JSON — a bounded, dependency-free adapter.
 *
 * Both directions are pure functions with no filesystem or network access,
 * so both are trivially and safely unit-testable with adversarial input.
 * `structured-service.ts` is the fs-facing layer that reads a real source
 * file and writes a real output atomically.
 *
 * ## The lossy disclosure this format always carries
 *
 * A CSV/TSV cell is text. Converting JSON to a table throws away every
 * value's real type — a number, a boolean and `null` all become plain text,
 * and reading the table back gives you strings for every one of them, never
 * the original type. This is disclosed on every `jsonToDelimited` result
 * rather than left for a caller to discover on the far side of a round trip.
 */
import {
  MAX_DELIMITED_CELL_LENGTH,
  MAX_DELIMITED_COLUMNS,
  MAX_DELIMITED_ROWS,
  MAX_STRUCTURED_INPUT_BYTES,
} from "./bounds";

export type DelimitedKind = "csv" | "tsv";

function delimiterFor(kind: DelimitedKind): string {
  return kind === "csv" ? "," : "\t";
}

export type JsonToDelimitedResult =
  | { ok: true; text: string; lossy: true; notes: string[] }
  | { ok: false; reason: string };

/** A flat, JSON-primitive-only cell value — what one table cell can actually hold. */
function cellText(value: unknown, notes: Set<string>): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  notes.add("a nested object or array value was JSON-stringified into its own cell rather than flattened or dropped");
  return JSON.stringify(value);
}

function escapeCell(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Convert an array of flat objects into a CSV/TSV table. The header row is
 * the union of every object's keys, in first-seen order, so a ragged array
 * of objects still produces one consistent table rather than being refused.
 */
export function jsonToDelimited(value: unknown, kind: DelimitedKind): JsonToDelimitedResult {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "only an array of objects can become a table — the top-level JSON value is not an array" };
  }
  if (value.length > MAX_DELIMITED_ROWS) {
    return { ok: false, reason: `the array has ${value.length} entries, over the ${MAX_DELIMITED_ROWS} row limit` };
  }
  const notes = new Set<string>([
    "every cell became plain text — numbers, booleans and null all lose their original JSON type and read back as strings",
  ]);

  const columns: string[] = [];
  const columnSet = new Set<string>();
  for (const row of value) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, reason: "every array entry must be a plain object to become a table row" };
    }
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!columnSet.has(key)) {
        if (columns.length >= MAX_DELIMITED_COLUMNS) {
          return { ok: false, reason: `the table has more than ${MAX_DELIMITED_COLUMNS} distinct columns` };
        }
        columnSet.add(key);
        columns.push(key);
      }
    }
  }

  const delimiter = delimiterFor(kind);
  const lines: string[] = [columns.map(c => escapeCell(c, delimiter)).join(delimiter)];
  for (const row of value as Record<string, unknown>[]) {
    const cells: string[] = [];
    for (const column of columns) {
      const text = cellText(row[column], notes);
      if (text.length > MAX_DELIMITED_CELL_LENGTH) {
        return { ok: false, reason: `cell in column "${column}" is ${text.length} characters, over the ${MAX_DELIMITED_CELL_LENGTH} character limit` };
      }
      cells.push(escapeCell(text, delimiter));
    }
    lines.push(cells.join(delimiter));
  }

  return { ok: true, text: lines.join("\r\n"), lossy: true, notes: [...notes] };
}

export type DelimitedToJsonResult =
  | { ok: true; value: Record<string, string>[] }
  | { ok: false; boundary: "too-large" | "malformed"; reason: string };

interface ParsedRow {
  cells: string[];
}

/** A minimal, bounded RFC-4180-shaped tokenizer: quotes, doubled-quote escaping, CRLF/LF rows. */
function tokenizeRows(text: string, delimiter: string): { ok: true; rows: ParsedRow[] } | { ok: false; reason: string } {
  const rows: ParsedRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function endCell(): boolean {
    if (cell.length > MAX_DELIMITED_CELL_LENGTH) return false;
    cells.push(cell);
    cell = "";
    return true;
  }
  function endRow(): boolean {
    if (!endCell()) return false;
    if (cells.length > MAX_DELIMITED_COLUMNS) return false;
    rows.push({ cells });
    cells = [];
    if (rows.length > MAX_DELIMITED_ROWS) return false;
    return true;
  }

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.length === 0) { inQuotes = true; i++; continue; }
    if (ch === delimiter) { if (!endCell()) return { ok: false, reason: "a cell exceeds the maximum cell length" }; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") {
      if (!endRow()) return { ok: false, reason: "the table exceeds a row, column or cell-length limit" };
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (inQuotes) return { ok: false, reason: "an opening quote is never closed" };
  if (cell.length > 0 || cells.length > 0) {
    if (!endRow()) return { ok: false, reason: "the table exceeds a row, column or cell-length limit" };
  }
  return { ok: true, rows };
}

/**
 * Parse a CSV/TSV table into an array of objects keyed by the header row.
 * Deliberately never infers a type from a cell's text: every value stays a
 * string, matching the lossy disclosure `jsonToDelimited` already states —
 * there is no ambiguity here about whether "007" meant a number or a string.
 */
export function delimitedToJson(text: string, kind: DelimitedKind): DelimitedToJsonResult {
  if (text.length > MAX_STRUCTURED_INPUT_BYTES) {
    return { ok: false, boundary: "too-large", reason: `the input is ${text.length} characters, over the ${MAX_STRUCTURED_INPUT_BYTES} character limit` };
  }
  if (text.trim().length === 0) return { ok: true, value: [] };

  const delimiter = delimiterFor(kind);
  const tokenized = tokenizeRows(text, delimiter);
  if (!tokenized.ok) return { ok: false, boundary: "malformed", reason: tokenized.reason };
  const rows = tokenized.rows;
  if (rows.length === 0) return { ok: true, value: [] };

  const header = rows[0].cells;
  if (new Set(header).size !== header.length) {
    return { ok: false, boundary: "malformed", reason: "the header row has duplicate column names" };
  }

  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].cells;
    if (cells.length !== header.length) {
      return { ok: false, boundary: "malformed", reason: `row ${r + 1} has ${cells.length} column(s), the header declares ${header.length}` };
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) record[header[c]] = cells[c];
    out.push(record);
  }
  return { ok: true, value: out };
}
