import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The retired `ui.tsx` primitives must not come back.
 *
 * `Notice`, `Select`, `SelectOption` and `EmptyState` were deleted once every
 * caller moved to `Banner` / `notify()`, `SelectField` and `Empty`. Nothing stops
 * a future edit from re-adding an export with the old name and quietly restoring
 * the two-tone notice (which had no warning tone, so warnings shipped as errors)
 * or the hand-rolled listbox (which had no native picker on touch). This test is
 * that stop.
 *
 * It checks two things, because either alone is defeatable: the module does not
 * EXPORT the retired names, and no `.tsx`/`.ts` under `src` IMPORTS them.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const UI = join(SRC, "ui.tsx");

/** Names that were deleted. `Tooltip` is deliberately absent — it still ships. */
const RETIRED = ["Notice", "Select", "SelectOption", "EmptyState", "Switch"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("ui.tsx exports Tooltip and nothing that was retired", () => {
  const source = readFileSync(UI, "utf8");
  const exported = [...source.matchAll(/^export (?:function|const|interface|type) (\w+)/gm)]
    .map(match => match[1]);
  expect(exported).toEqual(["Tooltip"]);
  for (const name of RETIRED) {
    // `export function Notice(` — a comment mentioning the name is fine, a real
    // export is not.
    expect(source).not.toMatch(new RegExp(`^export [\\w ]*${name}\\b`, "m"));
  }
});

test("no source file imports a retired primitive from ui.tsx", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file === UI) continue;
    const source = readFileSync(file, "utf8");
    // Only the ui.tsx import specifier matters: `Select` is also a legitimate
    // local name elsewhere (EffortSelect, SelectField), and banning the word
    // outright would fail on those.
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/ui"/g)) {
      const names = match[1]!.split(",").map(part => part.replace(/\btype\b/, "").trim());
      for (const name of names) {
        if ((RETIRED as readonly string[]).includes(name)) {
          offenders.push(`${file.slice(SRC.length + 1)} imports ${name}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("no source file renders the retired legacy elements", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const name of ["Notice", "Select", "EmptyState"]) {
      // The character after the name is what separates a JSX element from a type
      // argument: `<Notice[]>` and `Omit<Notice, "id">` are the notification
      // type, which is unrelated and very much still in use.
      if (new RegExp(`<${name}[\\s/>]`).test(source)) {
        offenders.push(`${file.slice(SRC.length + 1)} renders <${name}>`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
