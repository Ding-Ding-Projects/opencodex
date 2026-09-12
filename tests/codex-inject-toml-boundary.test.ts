// Regression: inject.ts's line-splicing root/table boundary detection used to be
// `lines.findIndex(l => /^\s*\[/.test(l))`, repeated verbatim in
// setRootOpenaiBaseUrl/stripInjectedOpenaiBaseUrl/stripExistingModelProvider/
// stripRootRoutedModel/setRootModelProvider/setRootModelCatalogPath, and mirrored in
// paths.ts's readRootTomlString and injected-marker.ts's rootTomlString/
// hasInjectedOpenaiBaseUrl. That naive check has no notion of "am I inside a
// multi-line TOML construct": a nested array or a triple-quoted string whose own
// continuation line starts with `[` (both perfectly legal TOML) was misread as the
// document's first real table header, so injection spliced `openai_base_url` (and
// its ownership marker) into the middle of that array or string.
//
// The fix replaces every one of those call sites with `firstStructuralTableIndex`
// (src/codex/toml-structure.ts), a small lexical scanner extracted from
// subagent-defaults.ts's already-tested line scanner (markStructuralLines /
// splitSourceLines) that tracks multiline-string state and bracket/brace depth
// across physical lines, so a `[` inside an unclosed array or string body is never
// mistaken for a table header.
//
// This file also covers the separate model_catalog_json ownership fix: basename-only
// matching used to treat any file merely named "opencodex-catalog.json" as
// opencodex-owned regardless of directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let codexHome: string;

beforeAll(() => {
  codexHome = mkdtempSync(join(tmpdir(), "ocx-toml-boundary-"));
  process.env.CODEX_HOME = codexHome;
});

afterAll(() => {
  delete process.env.CODEX_HOME;
  rmSync(codexHome, { recursive: true, force: true });
});

describe("[FIX] TOML root-boundary detection is blind to legal nested-array continuation lines", () => {
  test("a root nested array followed by the user's own openai_base_url: the override is recognized, not misread as living past the first table header", async () => {
    const { setRootOpenaiBaseUrl } = await import("../src/codex/inject");

    // Perfectly legal TOML: a root-level array of arrays (e.g. a coordinate/matrix
    // setting), followed — still at the document ROOT — by the user's own
    // openai_base_url, and only THEN the first real table.
    const config = [
      'model_reasoning_effort = "high"',
      "coordinates = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      'openai_base_url = "https://my-custom-endpoint.example.com/v1"',
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");

    const result = setRootOpenaiBaseUrl(config, 10100);

    // The user's own root openai_base_url, which sits AFTER the nested array but
    // still strictly before the first real [table], is recognized as a user-owned
    // override and left alone (keptUserBaseUrl: true) — the same as the sibling
    // case already covered for a simple (non-nested) config in codex-inject.test.ts.
    expect(result.keptUserBaseUrl).toBe(true);
    expect(result.content).toBe(config);
  });

  test("with no existing override, injection lands at the true document root, before the first table header, leaving the array untouched (exact insertion-point semantics preserved)", async () => {
    const { setRootOpenaiBaseUrl } = await import("../src/codex/inject");

    const config = [
      "coordinates = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");

    const result = setRootOpenaiBaseUrl(config, 10100);

    // No existing root openai_base_url in this fixture, so injection proceeds.
    expect(result.keptUserBaseUrl).toBe(false);

    // The array is left byte-for-byte intact, and the marker + key are spliced in
    // right before the blank line that precedes the first real table header — the
    // same blank-line walk-back the injector already applies for a plain (non-nested)
    // config, never inside the array itself.
    const lines = result.content.split("\n");
    expect(lines[0]).toBe("coordinates = [");
    expect(lines[1]).toBe("  [1, 2],");
    expect(lines[2]).toBe("  [3, 4],");
    expect(lines[3]).toBe("]");
    expect(lines[4]).toContain("Auto-injected by opencodex");
    expect(lines[5]).toStartWith("openai_base_url");
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe("[model_providers.openai]");
    expect((result.content.match(/openai_base_url/g) ?? []).length).toBe(1);
  });

  test("Bun's own TOML parser confirms the injected output stays valid TOML and the array round-trips unchanged", async () => {
    const { setRootOpenaiBaseUrl } = await import("../src/codex/inject");
    const config = [
      "coordinates = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");

    // The input is legal TOML before injection.
    const before = Bun.TOML.parse(config) as { coordinates: unknown };
    expect(before.coordinates).toEqual([[1, 2], [3, 4]]);

    const result = setRootOpenaiBaseUrl(config, 10100);

    // Injection never turns parseable TOML into unparseable TOML: the marker + key
    // land at the real root, not spliced into the `coordinates` array literal.
    expect(() => Bun.TOML.parse(result.content)).not.toThrow();
    const after = Bun.TOML.parse(result.content) as { coordinates: unknown; openai_base_url: string };
    expect(after.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(after.openai_base_url).toBe("http://127.0.0.1:10100/v1");
  });

  test("end-to-end injectCodexConfig() writes a parseable config.toml with routing actually landed", async () => {
    const { injectCodexConfig } = await import("../src/codex/inject");

    const original = [
      "coordinates = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const result = await injectCodexConfig(10100);
    const written = readFileSync(join(codexHome, "config.toml"), "utf8");

    // The top-level entry point real callers use (ocx start) reports success and
    // the config.toml it just wrote is real, parseable TOML with routing live.
    expect(result.success).toBe(true);
    expect(result.message).toContain("openai_base_url");
    expect(() => Bun.TOML.parse(written)).not.toThrow();
    const parsed = Bun.TOML.parse(written) as { coordinates: unknown; openai_base_url: string };
    expect(parsed.coordinates).toEqual([[1, 2], [3, 4]]);
    expect(parsed.openai_base_url).toBe("http://127.0.0.1:10100/v1");
  });
});

describe("[FIX] model_catalog_json ownership is resolved against this install's real catalog path, not decided by basename alone", () => {
  test("stripOpencodexConfig preserves a user's OWN model_catalog_json that merely shares opencodex's filename in a different directory", async () => {
    const { stripOpencodexConfig } = await import("../src/codex/inject");

    // A user's own, hand-maintained catalog file that happens to share opencodex's
    // exact filename but lives in a completely different, user-owned directory —
    // never this install's own $CODEX_HOME/opencodex-catalog.json.
    const content = [
      'model_catalog_json = "/home/user/my-own-catalogs/opencodex-catalog.json"',
      'model = "gpt-5.5"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");

    const stripped = stripOpencodexConfig(content);

    // Restore only ever removes catalog paths that opencodex itself wrote (i.e.
    // paths under this install's own catalog directory), never a user's own file
    // just because it shares a filename.
    expect(stripped).toContain("/home/user/my-own-catalogs/opencodex-catalog.json");
  });
});

describe("[FIX] idempotency (inject twice == inject once), including the previously-dangerous nested-array shape", () => {
  test("sound case: an ordinary config is unchanged by a second inject", async () => {
    const { injectCodexConfig } = await import("../src/codex/inject");
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const first = await injectCodexConfig(10100);
    const afterFirst = readFileSync(join(codexHome, "config.toml"), "utf8");
    const second = await injectCodexConfig(10100);
    const afterSecond = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(afterSecond).toBe(afterFirst);
    expect((afterSecond.match(/openai_base_url/g) ?? []).length).toBe(1);
    expect((afterSecond.match(/Auto-injected by opencodex/g) ?? []).length).toBe(1);
  });

  test("nested-array root config: repeated inject is idempotent and the document stays valid TOML throughout", async () => {
    const { injectCodexConfig } = await import("../src/codex/inject");
    const original = [
      "coordinates = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const first = await injectCodexConfig(10100);
    const afterFirst = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(() => Bun.TOML.parse(afterFirst)).not.toThrow();
    expect((Bun.TOML.parse(afterFirst) as { coordinates: unknown }).coordinates).toEqual([[1, 2], [3, 4]]);

    const second = await injectCodexConfig(10100);
    const afterSecond = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(afterSecond).toBe(afterFirst);
    expect((afterSecond.match(/openai_base_url/g) ?? []).length).toBe(1);
    expect((afterSecond.match(/Auto-injected by opencodex/g) ?? []).length).toBe(1);
  });
});

describe("[FIX] the same root-boundary blindness also affected a multi-line STRING, not just a nested array", () => {
  test("a root triple-quoted string whose body has a bracket-led line no longer corrupts the user's own string data", async () => {
    const { setRootOpenaiBaseUrl } = await import("../src/codex/inject");

    // A perfectly legal root multi-line basic string, e.g. free-form operator
    // notes some teams keep directly in config.toml. Its second physical line
    // happens to start with "[" as plain text (a bracketed note), which is
    // completely unremarkable inside a string body.
    const config = [
      "notes = \"\"\"",
      "[reminder] rotate the shared API key monthly",
      "\"\"\"",
      'openai_base_url = "https://my-custom-endpoint.example.com/v1"',
      "",
      "[model_providers.openai]",
      'name = "OpenAI"',
      "",
    ].join("\n");

    // Confirm the input is legal TOML and the string round-trips before injection.
    const before = Bun.TOML.parse(config) as { notes: string };
    expect(before.notes).toContain("[reminder] rotate the shared API key monthly");

    const result = setRootOpenaiBaseUrl(config, 10100);

    // The user's own root openai_base_url (which sits after the closing """, still
    // strictly before the first real [table]) is recognized and kept — the marker
    // is never spliced into the middle of the `notes` string body.
    expect(result.keptUserBaseUrl).toBe(true);
    expect(result.content).toBe(config);
  });
});
