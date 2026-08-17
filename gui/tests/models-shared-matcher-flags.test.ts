/**
 * `makeMatcher` compiles the flags the builder composed, and keeps everything else.
 *
 * This is the shared matcher behind six surfaces — the models screen, the Claude
 * Desktop lane, the provider workspace, the combo workspace, the account pool and
 * the dashboard — every one of which used to get a pinned `"i"` no matter what the
 * anchored builder beside the field had composed. The reported defect is small to
 * describe and easy to miss: a user turns the `i` chip off, the popover's preview
 * updates, and the list behind it carries on matching case-insensitively.
 *
 * The flags parameter therefore has a default, and half of these assertions exist
 * to prove the default is the old behaviour rather than a new one. Six surfaces
 * call this function and none of them was touched, so a change in what an
 * unflagged call finds would be a silent regression across all six at once.
 */

import { expect, test } from "bun:test";
import { makeMatcher } from "../src/pages/models-shared";
import { DEFAULT_SEARCH_FLAGS } from "../src/shell/settings-search";

test("an unflagged call behaves exactly as the pinned `i` did", () => {
  // The load-bearing assertion for the six untouched callers.
  expect(DEFAULT_SEARCH_FLAGS).toBe("i");
  expect(makeMatcher("sonnet", true).test("SONNET")).toBe(true);
  expect(makeMatcher("GPT", true).test("openai/gpt-5")).toBe(true);
});

test("a pattern composed as case-sensitive stays case-sensitive", () => {
  // The user-visible defect, in one pair. Under the pinned `"i"` both matched.
  const sensitive = makeMatcher("Sonnet", true, "");
  expect(sensitive.test("Sonnet")).toBe(true);
  expect(sensitive.test("sonnet")).toBe(false);

  expect(makeMatcher("Sonnet", true, "i").test("sonnet")).toBe(true);
});

test("`g` does not make a model list drop every other row", () => {
  // `g` carries `lastIndex` between calls, so a matcher reused down a list returns
  // true, false, true, false. Every preset the builder ships sets it, so it
  // arrives legitimately and is dropped rather than refused.
  const matcher = makeMatcher("gpt", true, "gi");
  const rows = ["openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-4.1", "openai/gpt-4o"];
  expect(rows.filter(row => matcher.test(row))).toEqual(rows);
});

test("`y` is dropped for the same reason as `g`", () => {
  const matcher = makeMatcher("claude", true, "yi");
  const rows = ["anthropic/claude-opus", "anthropic/claude-sonnet", "anthropic/claude-haiku"];
  expect(rows.filter(row => matcher.test(row))).toEqual(rows);
});

test("plain text is untouched by the flags", () => {
  // The flags describe a regex this mode never compiles, so a substring search
  // over visible text stays case-insensitive whatever they say.
  expect(makeMatcher("gpt", false, "").test("openai/GPT-5")).toBe(true);
  expect(makeMatcher("GPT", false, "").test("openai/gpt-5")).toBe(true);
  // …and a metacharacter is still a literal until the user opts in.
  expect(makeMatcher("gpt.5", false, "").test("gpt-5")).toBe(false);
});

test("the trim, the empty query and the error shape all survive carrying flags", () => {
  // An untouched field matches everything, whatever flags it is holding.
  expect(makeMatcher("", true, "").test("anything")).toBe(true);
  expect(makeMatcher("   ", true, "gimsuy").test("anything")).toBe(true);
  // Surrounding whitespace is trimmed off the pattern, not compiled into it.
  expect(makeMatcher("  gpt  ", true, "").test("openai/gpt-5")).toBe(true);

  const broken = makeMatcher("(unclosed", true, "");
  expect(broken.error).toBeTruthy();
  // An unusable pattern matches nothing here, so the error a surface reports and
  // the rows it shows can never disagree.
  expect(broken.test("anything")).toBe(false);
});

test("the 400-character cap still truncates rather than compiling the whole pattern", () => {
  const long = makeMatcher(`${"a".repeat(400)}b`, true, "");
  expect(long.error).toBeNull();
  expect(long.test("a".repeat(400))).toBe(true);
});

test("an unsupported flag is reported rather than swallowed", () => {
  // Compile failure is the same shape as a bad pattern: message kept, nothing matched.
  const bogus = makeMatcher("gpt", true, "ii");
  expect(bogus.error).toBeTruthy();
  expect(bogus.test("openai/gpt-5")).toBe(false);
});
