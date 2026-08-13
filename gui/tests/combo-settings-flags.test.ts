/**
 * The combo detail's settings search compiles the flags its builder composed.
 *
 * The last of the bars that took a pattern from the anchored builder and dropped
 * the flags on the floor. `comboSettingsSearch` called `makeMatcher(query,
 * useRegex)` with no third argument, so the matcher pinned `i` no matter what
 * the popover had been set to: the flag chips changed the preview inside the
 * panel and then changed nothing about which of the three Config cards stayed on
 * screen, and a pattern deliberately built as case-sensitive arrived
 * case-insensitive.
 *
 * Two kinds of assertion, because they fail differently:
 *
 *  - behaviour, at the level a user would notice — a case-sensitive pattern
 *    staying case-sensitive over the real English labels these cards render,
 *    and a `g` flag not changing which cards survive;
 *  - the wiring, by exact source string. The behaviour tests pass on a function
 *    nobody hands flags to, because they hand it flags themselves. Only the
 *    second kind fails when the field goes back to owning a query and a mode and
 *    no flags at all, which is the state this change is repairing.
 *
 * The strings are asserted verbatim rather than by pattern, so renaming the
 * state variable is a visible edit here rather than a silently satisfied
 * substring.
 */

import { expect, test } from "bun:test";
import { comboSettingsSearch } from "../src/components/combo-workspace-settings-search";
import { translate } from "../src/i18n/resolve";
import type { FunnyLevels, TFn } from "../src/i18n/shared";
import { DEFAULT_SEARCH_FLAGS } from "../src/shell/settings-search";

const FUNNY: FunnyLevels = { en: 3, yue: 3 };

/**
 * The real English resolver, not a stub that echoes keys back.
 *
 * The whole point of this search is that a card is findable by the words it
 * actually renders, so a fake `t` returning `"cws.target.weight"` would let a
 * pattern match the id and prove nothing about the label. It also means the
 * case-sensitivity pair below is a real one: "Weight" is a targets label, while
 * the lowercase "weight" that distinguishes it lives in the strategy card's
 * round-robin hint.
 */
const t: TFn = (key, vars) => translate("en", FUNNY, key, vars);

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

test("a pattern composed as case-sensitive stays case-sensitive", () => {
  // "Weight" is a label on the targets card. The strategy card carries only the
  // lowercase word, inside "balance traffic by weight" — so under the pinned `i`
  // both cards survived a pattern the user had deliberately made exact.
  const sensitive = comboSettingsSearch("Weight", true, t, "");
  expect(sensitive.matches("targets")).toBe(true);
  expect(sensitive.matches("strategy")).toBe(false);

  const insensitive = comboSettingsSearch("Weight", true, t, "i");
  expect(insensitive.matches("targets")).toBe(true);
  expect(insensitive.matches("strategy")).toBe(true);
});

test("an unflagged call still behaves exactly as the pinned `i` did", () => {
  // The default is the load-bearing half of the signature change: this function
  // is called from one place today, and a change in what an unflagged call finds
  // would be a silent regression rather than a fix.
  expect(DEFAULT_SEARCH_FLAGS).toBe("i");
  expect(comboSettingsSearch("weight", true, t).matches("targets")).toBe(true);
  expect(comboSettingsSearch("WEIGHT", true, t).matches("targets")).toBe(true);
});

test("`g` and `y` do not change which cards survive", () => {
  // Both advance `lastIndex` between calls, and this matcher is reused four
  // times in one pass — once per card and again over the About tab's text — so a
  // surviving `g` would decide the answer by the order the cards were tested in.
  // Every preset the builder ships sets `g`, so it arrives here legitimately.
  const plain = comboSettingsSearch("target", true, t, "i");
  for (const flags of ["gi", "yi", "gyi"]) {
    const stateful = comboSettingsSearch("target", true, t, flags);
    expect(stateful.hits).toBe(plain.hits);
    expect(stateful.otherHits).toBe(plain.otherHits);
    for (const id of ["identity", "strategy", "targets"] as const) {
      expect(stateful.matches(id)).toBe(plain.matches(id));
    }
  }
});

test("the cross-tab note is computed under the same flags as the cards", () => {
  // A miss on Config that hits About is the one result a user acts on rather
  // than re-reads, so it has to obey the flags too. "Runtime" is the About card's
  // title; nothing on Config carries it.
  const sensitive = comboSettingsSearch("Runtime", true, t, "");
  expect(sensitive.hits).toBe(0);
  expect(sensitive.otherHits).toBe(1);
  expect(sensitive.otherTabs).toEqual([t("cws.tab.about")]);

  // Same word, wrong case, still exact: no hit anywhere rather than a hit the
  // pattern did not ask for.
  const missed = comboSettingsSearch("runtime", true, t, "");
  expect(missed.otherHits).toBe(0);
  expect(missed.otherTabs).toEqual([]);
});

test("plain text is untouched by the flags", () => {
  // The flags describe a regex this mode never compiles, so a substring search
  // over visible labels stays case-insensitive whatever they say.
  expect(comboSettingsSearch("WEIGHT", false, t, "").matches("targets")).toBe(true);
  expect(comboSettingsSearch("weight", false, t, "").matches("strategy")).toBe(true);
  // …and a metacharacter is still a literal until the user opts in.
  expect(comboSettingsSearch("Weigh.", false, t, "").matches("targets")).toBe(false);
});

test("an untouched field hides nothing, whatever flags it is holding", () => {
  const idle = comboSettingsSearch("", true, t, "gimsuy");
  expect(idle.active).toBe(false);
  expect(idle.matches("identity")).toBe(true);
  expect(idle.matches("strategy")).toBe(true);
  expect(idle.matches("targets")).toBe(true);
  // No cross-tab claim about a search nobody has run yet.
  expect(idle.otherHits).toBe(0);
});

test("an unusable pattern still reports its error and matches nothing", () => {
  const broken = comboSettingsSearch("(unclosed", true, t, "");
  expect(broken.error).toBeTruthy();
  expect(broken.matches("identity")).toBe(false);
  expect(broken.hits).toBe(0);
});

test("an unsupported flag is reported rather than swallowed", () => {
  // Compile failure has the same shape as a bad pattern: the message is kept and
  // nothing matches, so the note the panel shows and the cards it renders agree.
  const bogus = comboSettingsSearch("Weight", true, t, "ii");
  expect(bogus.error).toBeTruthy();
  expect(bogus.matches("targets")).toBe(false);
});

test("the search function passes its flags to the shared matcher", async () => {
  const source = await read("components/combo-workspace-settings-search.tsx");
  expect(source).toContain("makeMatcher(query, useRegex, flags)");
  // The default is what keeps an unflagged caller on today's behaviour.
  expect(source).toContain("flags = DEFAULT_SEARCH_FLAGS");
  // Nothing here compiles its own regex: the cap, the stateful-flag strip and
  // the error shape all live in the shared matcher.
  expect(source).not.toContain("new RegExp(");
});

test("the panel holds its own flags and writes both halves back", async () => {
  const panel = await read("components/combo-workspace-detail-panel.tsx");

  // Flags are state, not a constant pinned at the call site.
  expect(panel).toContain("const [settingsFlags, setSettingsFlags] = useState(DEFAULT_SEARCH_FLAGS)");
  expect(panel).toContain("comboSettingsSearch(settingsQuery, settingsRegex, t, settingsFlags)");

  // The half that was missing: the builder hands back a pattern *and* its flags.
  expect(panel).toContain("setSettingsQuery(pattern);");
  expect(panel).toContain("setSettingsFlags(appliedFlags);");
  // …and the round trip is bidirectional, so reopening the popover shows the set
  // already in force rather than resetting it to the default.
  expect(panel).toContain("flags={settingsFlags}");
});

test("the panel renders the chip row and the field points at its state line", async () => {
  const panel = await read("components/combo-workspace-detail-panel.tsx");

  expect(panel).toContain('const SETTINGS_FLAGS_ID = "cws-settings-flags-state"');
  expect(panel).toContain("<SearchFlagsRow");
  expect(panel).toContain("onFlagsChange={setSettingsFlags}");
  expect(panel).toContain("id={SETTINGS_FLAGS_ID}");
  // Bound only in regex mode, because that is the only mode in which the row
  // renders — a description pointing at an id nothing rendered is announced as
  // nothing at all.
  expect(panel).toContain("aria-describedby={settingsRegex ? SETTINGS_FLAGS_ID : undefined}");
});
