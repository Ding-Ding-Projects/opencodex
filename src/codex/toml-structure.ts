/**
 * Shared TOML lexical-scanning primitive for finding the document's structural
 * root boundary.
 *
 * The naive way to find "where does the TOML root end" is
 * `lines.findIndex(l => /^\s*\[/.test(l))` — treat the first line that starts
 * with `[` as the first table header. That is wrong: a line starting with `[`
 * can also be a continuation line of a root-level multi-line array (perfectly
 * legal TOML — an array element can itself be `[1, 2]`) or a line inside a
 * root triple-quoted/literal string body. Naively trusting it makes the root
 * boundary land in the middle of the array or string, and anything spliced in
 * at that "boundary" corrupts the construct instead of landing at the real
 * document root.
 *
 * This module tracks just enough state — multiline-string state and
 * unclosed `[...]` / `{...}` depth — to know whether a `[` at the start of a
 * line is really a table header, without building a full value tree. It is
 * extracted from the line scanner `subagent-defaults.ts` already used for its
 * own `[agents]` table handling (`markStructuralLines`), so every place in
 * this codebase that needs the document-root boundary — inject.ts, paths.ts,
 * injected-marker.ts, project-config-warnings.ts, and subagent-defaults.ts
 * itself — shares one lexical implementation instead of several ad hoc,
 * naive copies.
 *
 * This is intentionally NOT a TOML parser: it classifies physical lines, it
 * never builds values, and it has no notion of key paths or table nesting
 * beyond "line does/doesn't start a real table header".
 */

export type MultilineStringKind = "basic" | "literal" | null;

export interface StructuralScanState {
  multiline: MultilineStringKind;
  squareDepth: number;
  curlyDepth: number;
}

/** Fresh scan state for the start of a document. */
export function createStructuralScanState(): StructuralScanState {
  return { multiline: null, squareDepth: 0, curlyDepth: 0 };
}

/**
 * Advance `state` past one physical line of TOML source, in document order.
 * Returns whether the line STARTED in structural position — i.e. not already
 * inside a multiline string or an unclosed array/inline-table — which is what
 * the caller needs to know before trusting a leading `[` on this same line as
 * a real table header.
 *
 * `state` must be threaded across every physical line of the document in
 * order: it is exactly the multiline-string and bracket/brace depth carried
 * across line boundaries, mirroring how TOML's own lexer treats a document as
 * one continuous character stream, not independent lines.
 */
export function advanceStructuralScan(state: StructuralScanState, text: string): boolean {
  const structural = state.multiline === null && state.squareDepth === 0 && state.curlyDepth === 0;
  let single: "basic" | "literal" | null = null;

  for (let index = 0; index < text.length;) {
    if (state.multiline === "basic") {
      if (text.startsWith('"""', index)) {
        state.multiline = null;
        index += 3;
      } else if (text[index] === "\\") {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (state.multiline === "literal") {
      if (text.startsWith("'''", index)) {
        state.multiline = null;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }
    if (single === "basic") {
      if (text[index] === "\\") index += 2;
      else if (text[index] === '"') {
        single = null;
        index += 1;
      } else index += 1;
      continue;
    }
    if (single === "literal") {
      if (text[index] === "'") single = null;
      index += 1;
      continue;
    }

    if (text[index] === "#") break;
    if (text.startsWith('"""', index)) {
      state.multiline = "basic";
      index += 3;
    } else if (text.startsWith("'''", index)) {
      state.multiline = "literal";
      index += 3;
    } else if (text[index] === '"') {
      single = "basic";
      index += 1;
    } else if (text[index] === "'") {
      single = "literal";
      index += 1;
    } else if (text[index] === "[") {
      state.squareDepth += 1;
      index += 1;
    } else if (text[index] === "]") {
      state.squareDepth = Math.max(0, state.squareDepth - 1);
      index += 1;
    } else if (text[index] === "{") {
      state.curlyDepth += 1;
      index += 1;
    } else if (text[index] === "}") {
      state.curlyDepth = Math.max(0, state.curlyDepth - 1);
      index += 1;
    } else {
      index += 1;
    }
  }

  return structural;
}

const ROOT_TABLE_HEADER_START = /^\s*\[/;

/**
 * Index of the first physical line that is a genuine TOML table header
 * (`[table]` or `[[array-of-tables]]`) at the document's structural top
 * level — not a continuation line of a root multi-line array, not a line
 * inside a root triple-quoted/literal string, and not otherwise nested inside
 * an unclosed `[...]`/`{...}` construct. Returns -1 when the document has no
 * such line, meaning every line belongs to the document root.
 *
 * This is the drop-in, correct replacement for
 * `lines.findIndex(l => /^\s*\[/.test(l))` everywhere that expression was
 * used to find "where does the TOML root end".
 */
export function firstStructuralTableIndex(lines: readonly string[]): number {
  const state = createStructuralScanState();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const structural = advanceStructuralScan(state, line);
    if (structural && ROOT_TABLE_HEADER_START.test(line)) return index;
  }
  return -1;
}
