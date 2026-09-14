/**
 * Source contract for the L10N-02 fix: every "Enter submits" keydown handler
 * in the eight sites the finding named must guard against a composing Enter,
 * not just the one `hunt-l10n-02.test.tsx` drives through a real component.
 *
 * `hunt-l10n-02.test.tsx` proves the behaviour at exactly one call site
 * (`AuthenticatorGroupPicker`). The other seven shared the identical
 * unguarded shape, `if (e.key === "Enter") ...`, with nothing between them
 * and a bare `<input>` to catch it (`TextInput` in `shell/m3-ui.tsx` is a
 * passthrough). A behavioural test per sibling would work, but would also
 * stay silent forever if a future edit quietly dropped the guard back out or
 * added a ninth unguarded handler next to a fixed one, since nothing forces
 * that new code through a mounted-component test. This test reads the actual
 * source of the six files the eight sites live in and asserts, by scanning
 * rather than by trusting a fixed line-number list, that:
 *
 *   - the exact number of Enter-as-submit handlers per file has not changed
 *     (catches a handler vanishing outright, which would otherwise make
 *     every assertion below vacuously pass), and
 *   - every one of them calls `isComposingEnter` before treating the key as
 *     a submit.
 *
 * Handlers are found with a brace-depth walk, not a `[^}]*` regex: each site
 * nests its own `if (...) return;` block before the `Enter` check, so a
 * regex that stops at the first `}` would truncate the match before ever
 * reaching the guard it is supposed to verify.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");

const SITES: { path: string; expectedHandlers: number }[] = [
  { path: "components/authenticator/AuthenticatorGroupPicker.tsx", expectedHandlers: 1 },
  { path: "components/authenticator/AuthenticatorAddDialog.tsx", expectedHandlers: 1 },
  { path: "components/authenticator/SecretHistoryDialog.tsx", expectedHandlers: 2 },
  { path: "pages/VersionHistory.tsx", expectedHandlers: 1 },
  { path: "components/provider-workspace/ProviderModels.tsx", expectedHandlers: 1 },
  { path: "shell/UnlockPrompt.tsx", expectedHandlers: 2 },
];

/**
 * Every `onKeyDown={...}` attribute value in `source` whose body treats
 * `key === "Enter"` as a trigger, returned as the full attribute text
 * (`onKeyDown={...}` including both braces). Matched by counting brace
 * depth from the attribute's opening `{` so the scan ends at the JSX
 * attribute's own closing brace, not at the first `}` met along the way.
 */
function enterHandlers(source: string): string[] {
  const found: string[] = [];
  const marker = "onKeyDown={";
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const openBrace = start + marker.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) throw new Error(`unterminated onKeyDown={ at offset ${start}`);
    const handler = source.slice(start, end + 1);
    searchFrom = end + 1;
    if (/\.key\s*===\s*"Enter"/.test(handler)) found.push(handler);
  }
  return found;
}

describe("hunt-l10n-02 siblings: every Enter-as-submit handler checks isComposing", () => {
  for (const { path, expectedHandlers } of SITES) {
    it(`${path} guards every Enter handler with isComposingEnter`, () => {
      const source = readFileSync(join(SRC_DIR, path), "utf-8");
      const handlers = enterHandlers(source);
      expect(handlers).toHaveLength(expectedHandlers);
      for (const handler of handlers) {
        expect(handler).toMatch(/isComposingEnter\(/);
      }
    });
  }

  it("the scanner actually tells guarded and unguarded handlers apart", () => {
    // Proves the assertions above are testing something real, the same way
    // badge-class-single-owner.test.ts proves its own selector matcher does
    // not just pass by accident.
    const unguarded = 'onKeyDown={e => { if (e.key === "Enter") void submit(); }}';
    const guarded = 'onKeyDown={e => { if (isComposingEnter(e)) return; if (e.key === "Enter") void submit(); }}';
    const unguardedFound = enterHandlers(unguarded);
    expect(unguardedFound).toHaveLength(1);
    expect(unguardedFound[0]).not.toMatch(/isComposingEnter\(/);
    const guardedFound = enterHandlers(guarded);
    expect(guardedFound).toHaveLength(1);
    expect(guardedFound[0]).toMatch(/isComposingEnter\(/);
  });

  it("shell/composing-enter.ts exports the guard both places actually call", () => {
    const helper = readFileSync(join(SRC_DIR, "shell", "composing-enter.ts"), "utf-8");
    expect(helper).toMatch(/export function isComposingEnter/);
    expect(helper).toMatch(/nativeEvent\.isComposing/);
  });

  it("TextInput stays a bare passthrough: the fix is per-site, not centralised", () => {
    // The accepted repair shape guards each call site directly. TextInput
    // quietly intercepting onKeyDown itself would change behaviour for every
    // other consumer that wires its own handler and does not expect that.
    const source = readFileSync(join(SRC_DIR, "shell", "m3-ui.tsx"), "utf-8");
    const start = source.indexOf("export function TextInput(");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextExport = source.indexOf("\nexport ", start + 1);
    const body = nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
    expect(body).not.toMatch(/isComposing/);
    expect(body).not.toMatch(/onKeyDown/);
  });
});
