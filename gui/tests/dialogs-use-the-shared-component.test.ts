/**
 * A modal you can open with the keyboard and cannot leave with the keyboard is a
 * trap, and this codebase produced one twice.
 *
 * `ProviderDialogs.tsx` hand-rolled its two confirmations as
 * `<div className="dialog-backdrop" onClick={onCancel}>` wrapping
 * `<div className="dialog" role="alertdialog">`. It looks complete and works
 * perfectly with a mouse, which is exactly why it survived review: the file
 * contained no keydown handler at all, and the app's only window-level Escape
 * listener closes the nav drawer and nothing else. So Escape did not close the
 * dialog, focus was never moved into it or trapped inside it, and focus never
 * returned to the control that opened it.
 *
 * `combo-workspace-dialogs.tsx` had the identical pattern, was moved onto the
 * shared `Dialog` for these exact reasons, and says so in its own header — the
 * fix simply never reached the provider workspace. That is the shape this guard
 * exists for: a fix applied to one copy of a duplicated pattern and not the other.
 *
 * `shell/m3-ui.tsx`'s `Dialog` renders a native `<dialog>` via `showModal()`, so
 * the focus trap, Escape handling and focus return come from the platform rather
 * than from listeners somebody has to remember to write.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/** Lines of real code — comment lines are dropped so a doc comment describing the
 *  old pattern (as `ProviderDialogs.tsx` now does) cannot trip the guard. */
function codeLines(text: string): { line: string; n: number }[] {
  let inBlock = false;
  const out: { line: string; n: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (inBlock) { if (line.includes("*/")) inBlock = false; return; }
    if (line.startsWith("/*")) { if (!line.includes("*/")) inBlock = true; return; }
    if (line.startsWith("//") || line.startsWith("*")) return;
    out.push({ line: raw, n: i + 1 });
  });
  return out;
}

describe("modal dialogs come from the shared component", () => {
  test("nothing hand-rolls a dialog backdrop", () => {
    // The marker of the old pattern. A hand-rolled backdrop means a hand-rolled
    // dialog, which means Escape and the focus trap are somebody's to remember.
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      for (const { line, n } of codeLines(readFileSync(file, "utf-8"))) {
        if (/className=["'`][^"'`]*\bdialog-backdrop\b/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${n}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("nothing hand-rolls role=\"alertdialog\" on a plain element", () => {
    // `Dialog` sets the role itself. A literal `role="alertdialog"` in a page or
    // component means an element pretending to be a modal without being one.
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      if (file.endsWith(join("shell", "m3-ui.tsx"))) continue; // the component itself
      for (const { line, n } of codeLines(readFileSync(file, "utf-8"))) {
        if (/role=["']alertdialog["']/.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the provider workspace's dialogs render the shared Dialog", () => {
    // Guards catch a thing done wrongly, never a thing deleted outright: without
    // this, emptying the file passes both assertions above.
    const src = readFileSync(join(SRC, "components", "provider-workspace", "ProviderDialogs.tsx"), "utf-8");
    expect(src).toMatch(/import \{[^}]*\bDialog\b[^}]*\} from "\.\.\/\.\.\/shell\/m3-ui"/);
    expect((src.match(/<Dialog\b/g) || []).length).toBe(2);
  });

  test("the comment-stripper does not hide a real offender", () => {
    // Proves the guard is still looking. `ProviderDialogs.tsx`'s own header now
    // quotes the old markup, so a stripper that was too eager -- or not eager
    // enough -- would silently change what these tests mean.
    const fixture = [
      '/** was: <div className="dialog-backdrop"> */',
      '// also <div className="dialog-backdrop">',
      '  <div className="dialog-backdrop" onClick={onCancel}>',
    ].join("\n");
    const hits = codeLines(fixture).filter(({ line }) => /className=["'`][^"'`]*\bdialog-backdrop\b/.test(line));
    expect(hits.map(h => h.n)).toEqual([3]);
  });
});
