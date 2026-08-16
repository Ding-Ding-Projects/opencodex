/**
 * A translated string must never reach the screen with a `{placeholder}` still
 * in it. One did: the dashboard's 30-day coverage hint rendered
 *
 *   100% coverage · 覆蓋率 {pct}
 *
 * and shipped that way in `assets/shots/notification-centre.png`.
 *
 * The cause is specific and easy to write again. `t(key, vars)` runs
 * `interpolate()` (i18n/shared.ts), which uses `split(token).join(value)` and
 * therefore replaces EVERY occurrence. The call site had instead written
 * `t(key).replace("{pct}", value)` -- and `String.replace` with a *string*
 * pattern substitutes only the FIRST match. In English that is invisible,
 * because the string holds one placeholder. In bilingual mode `t()` has already
 * joined both languages into a single string, so there are two, and only the
 * English one got filled in.
 *
 * That is why this is a guard and not just a fix: the bug is invisible in the
 * default language and appears only in a mode most tests do not render.
 *
 * Two assertions, aimed at different halves:
 *
 *   - no source file may call `.replace("{...}")` on a `t(...)` result. This is
 *     the mechanical cause, and it is greppable.
 *   - every key that declares a placeholder must declare the SAME placeholders
 *     in every locale. A key whose Cantonese half is missing `{pct}` entirely
 *     would silently drop the number rather than show a token -- the opposite
 *     failure, equally wrong, and not caught by the rule above.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe("translated strings never render a raw placeholder", () => {
  it("no call site substitutes into a t() result with String.replace", () => {
    // `t(...).replace("{x}", ...)` and the `.replaceAll` spelling alike -- even
    // `replaceAll` is wrong here, because it bypasses `vars` and a reader
    // cannot tell which placeholders a key actually declares.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf-8");
      // Deliberately line-scoped: a `[\s\S]*?` bridge would run past the end of
      // the statement and match a `.replace` belonging to something else
      // entirely.
      text.split(/\r?\n/).forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        if (/\bt\([^)]*\)\s*\.\s*replace(All)?\(\s*["'`]\{/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("a key's placeholders are identical in every locale", async () => {
    // Each locale module exports a named table (`export const en = {...}`),
    // not a default -- `en` additionally defines the `TKey` type from its own
    // keys, which is why it is the base here.
    const locales = ["en", "yue", "zh", "de", "ja", "ko", "ru"] as const;
    const loaded = await Promise.all(
      locales.map(async name => {
        const mod = await import(`../src/i18n/${name}`) as Record<string, unknown>;
        const table = mod[name] as Record<string, string> | undefined;
        if (!table) throw new Error(`locale module ${name} has no exported \`${name}\` table`);
        return [name, table] as const;
      }),
    );

    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(m => m[1]!).sort();

    /**
     * Only keys that are actually CALLED with vars are checked.
     *
     * Not every `{word}` in a translation is an interpolation token. The
     * `modal.baseUrlPlaceholder*` strings say "Replace the {placeholder} in the
     * Base URL with your actual Account ID" -- the braces are literal prose
     * being shown to the user, and German rendering it `{Platzhalter}` and
     * Chinese `{占位符}` are correct translations, not bugs. An earlier draft of
     * this test flagged all four as defects.
     *
     * A key nobody passes vars to cannot have the substitution bug this file
     * exists for, so `t("key", {` is the discriminator. It reads the call sites
     * with a line-scoped regex, which misses a key whose name is computed at
     * runtime -- stated rather than papered over, since the alternative is an
     * allowlist that grows and eventually hides a real one.
     */
    const calledWithVars = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      if (file.includes(`${join("src", "i18n")}`)) continue;
      for (const m of readFileSync(file, "utf-8").matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/g)) {
        calledWithVars.add(m[1]!);
      }
    }
    // If this ever empties out, the regex above stopped matching and the whole
    // assertion would pass vacuously -- the exact shape of a guard that quietly
    // stops guarding.
    expect(calledWithVars.size).toBeGreaterThan(10);

    const [, base] = loaded[0]!;
    const mismatches: string[] = [];
    for (const key of Object.keys(base)) {
      if (!calledWithVars.has(key)) continue;
      const want = placeholders(base[key] ?? "");
      if (want.length === 0) continue;
      for (const [name, table] of loaded.slice(1)) {
        const value = table[key];
        // A key absent from a locale falls back to English, which is a
        // translation gap rather than a placeholder bug -- not this test's job.
        if (value === undefined) continue;
        const got = placeholders(value);
        if (got.join(",") !== want.join(",")) {
          mismatches.push(`${key}: en has [${want}], ${name} has [${got}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
