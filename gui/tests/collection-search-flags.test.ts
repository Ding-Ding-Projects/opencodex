/**
 * Every collection search compiles the flags the user actually chose.
 *
 * The defect these guard: ten search bars each built `new RegExp(query, "i")`
 * directly. The anchored builder had started handing a pattern *and* its flags
 * back, so those bars took the pattern and dropped the flags on the floor —
 * which meant the flag chips inside the popover changed the preview and then
 * changed nothing about the list behind it, and a pattern deliberately composed
 * as case-sensitive arrived case-insensitive. `Logs.tsx` was fixed first; these
 * are the rest.
 *
 * Two kinds of assertion, because they fail differently:
 *
 *  - a HAND-WRITTEN inventory of the surfaces that must carry the contract. A
 *    rule alone cannot catch a surface that never adopted it: a check shaped
 *    "wherever flags are held, hold them correctly" passes cleanly on a file
 *    that holds none. The list below is the thing that fails when a bar is
 *    missing, so a new bar has to be added to it in the same change that adds
 *    the bar;
 *  - behaviour, at the level the user would notice — a case-sensitive pattern
 *    staying case-sensitive, and a `g` flag not making a list drop every other
 *    row.
 */

import { expect, test } from "bun:test";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher, stripStatefulFlags } from "../src/shell/settings-search";
import { filterVoices } from "../src/shell/narrator-voices";
import type { VoiceOption } from "../src/shell/narrator-voices";

/**
 * The source with whole-line comments dropped.
 *
 * Only whole-line ones — a line whose trimmed form starts `//`, `*` or `/*` — so
 * this can never delete real code and turn a negative assertion into a false
 * pass. It exists because these files now *explain* the construct they stopped
 * using, and a `not.toContain` on that construct's name would otherwise punish
 * the code for documenting itself.
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter(line => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

interface SearchBar {
  /** How the report names it when the row fails. */
  name: string;
  /** Where the flags state lives and the matcher is called. */
  state: string;
  /** Where the builder trigger and the chip row are rendered; often the same file. */
  render: string;
  /** The exact matcher call, so a renamed state variable cannot satisfy this. */
  matcher: string;
  /** The exact `useState` line that seeds the flags. */
  holdsFlags: string;
  /** The write-back from the builder's `onApply`, which is the half that was missing. */
  writesBack: string;
  /** The id the chip row's state line carries, unique per bar on a shared screen. */
  flagsId: string;
}

/**
 * The eleven bars. Hand-written, and deliberately so.
 *
 * Nine surfaces, eleven fields: Appearance carries a page search and a typography
 * search, and Language & voice carries a page search plus one voice picker per
 * narrator track. Those pairs are listed separately because each owns its own
 * query, its own mode and its own flags — one shared flag set would mean turning
 * on `u` in one field silently recompiled the other.
 */
const BARS: SearchBar[] = [
  {
    name: "API keys — model catalog",
    state: "pages/ApiKeys.tsx",
    render: "pages/api-keys-panels.tsx",
    matcher: "settingsMatcher(modelQuery, useRegex, modelFlags)",
    holdsFlags: "const [modelFlags, setModelFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "onModelFlagsChange(appliedFlags)",
    flagsId: "api-models-flags-state",
  },
  {
    name: "Appearance — page settings search",
    state: "pages/Appearance.tsx",
    render: "pages/Appearance.tsx",
    matcher: "makeMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    flagsId: "appearance-regex-flags-state",
  },
  {
    name: "Appearance — typography element search",
    state: "pages/Appearance.tsx",
    render: "pages/Appearance.tsx",
    matcher: "makeMatcher(typeQuery, typeRegex, typeFlags)",
    holdsFlags: "const [typeFlags, setTypeFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setTypeQuery(pattern); setTypeFlags(appliedFlags)",
    flagsId: "appearance-type-flags-state",
  },
  {
    name: "Changelog — entry search",
    state: "pages/Changelog.tsx",
    render: "pages/Changelog.tsx",
    matcher: "settingsMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    flagsId: "cl-regex-flags-state",
  },
  {
    name: "Grok — model group search",
    state: "pages/Grok.tsx",
    render: "pages/Grok.tsx",
    matcher: "settingsMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    flagsId: "grok-regex-flags-state",
  },
  {
    name: "Language & voice — page settings search",
    state: "pages/LanguageVoice.tsx",
    render: "pages/LanguageVoice.tsx",
    matcher: "useMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    flagsId: "lang-regex-flags-state",
  },
  {
    name: "Language & voice — per-track voice picker",
    state: "pages/LanguageVoice.tsx",
    render: "pages/LanguageVoice.tsx",
    matcher: "filterVoices(resolution.candidates, query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    // Per track rather than a literal: two narrator tracks render this component
    // side by side, and one shared id would make both fields describe one line.
    flagsId: "`ocx-narrator-flags-${tag}`",
  },
  {
    name: "Notifications — history search",
    state: "pages/Notifications.tsx",
    render: "pages/Notifications.tsx",
    matcher: "settingsMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    flagsId: "notif-regex-flags-state",
  },
  {
    name: "Storage — cleanup policy settings search",
    state: "pages/Storage.tsx",
    render: "pages/Storage.tsx",
    matcher: "makeSettingsMatcher(query, regexOn, regexFlags)",
    holdsFlags: "const [regexFlags, setRegexFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "onQuery(pattern); onFlags(appliedFlags)",
    flagsId: "storage-regex-flags-state",
  },
  {
    name: "Subagents — model search",
    state: "pages/Subagents.tsx",
    render: "pages/Subagents.tsx",
    matcher: "settingsMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "setQuery(pattern); setFlags(appliedFlags)",
    flagsId: "sub-regex-flags-state",
  },
  {
    name: "Usage — model search",
    state: "pages/Usage.tsx",
    render: "pages/Usage.tsx",
    matcher: "settingsMatcher(query, useRegex, flags)",
    holdsFlags: "const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS)",
    writesBack: "onModelQuery(pattern); onFlags(appliedFlags)",
    flagsId: "usage-models-flags-state",
  },
];

/* --------------------------------------------- the inventory, surface by surface -- */

test("the inventory names eleven bars across nine surfaces", () => {
  // A count, so deleting a row to make the suite green is a visible edit rather
  // than a silent one.
  expect(BARS).toHaveLength(11);
  expect(new Set(BARS.map(bar => bar.state)).size).toBe(9);
  // Every flags id is distinct: two bars on one screen must not describe each
  // other's chip row.
  expect(new Set(BARS.map(bar => bar.flagsId)).size).toBe(BARS.length);
});

for (const bar of BARS) {
  test(`${bar.name} compiles the flags its builder composed`, async () => {
    const state = await read(bar.state);
    const render = await read(bar.render);

    // Flags are state, not a pinned constant.
    expect(state).toContain(bar.holdsFlags);
    // …and they reach the matcher. Asserted as the whole call, so renaming the
    // state variable cannot leave a matcher still compiling something else.
    expect(state).toContain(bar.matcher);
    // The builder is told what this field compiles, so its preview agrees…
    expect(render).toContain("flags={");
    // …and what it composes is written back. This is the half that was missing:
    // taking the pattern and leaving the flags is exactly the reported defect.
    expect(render).toContain(bar.writesBack);
    // The flags are visible and correctable rather than silent.
    expect(render).toContain("<SearchFlagsRow");
    expect(render).toContain(bar.flagsId);
  });
}

test("no listed surface compiles a hard-coded pattern any more", async () => {
  for (const path of new Set(BARS.map(bar => bar.state))) {
    const source = codeOnly(await read(path));
    // The exact regression: a compile that pins its own flags and therefore
    // ignores whatever the builder beside the field composed.
    expect(source).not.toContain('new RegExp(query');
    expect(source).not.toContain('new RegExp(trimmed');
    expect(source).not.toContain('new RegExp(modelQuery');
    expect(source).not.toContain('new RegExp(q,');
  }
});

/* --------------------------------------------------------------------- behaviour -- */

test("a pattern composed as case-sensitive stays case-sensitive", () => {
  // The user-visible defect, in one assertion. Under the old hard-coded `"i"`
  // both of these matched, so turning the `i` chip off in the builder changed
  // the panel's preview and nothing else.
  const sensitive = settingsMatcher("Sonnet", true, "");
  expect(sensitive.test("Sonnet")).toBe(true);
  expect(sensitive.test("sonnet")).toBe(false);

  const insensitive = settingsMatcher("Sonnet", true, "i");
  expect(insensitive.test("sonnet")).toBe(true);
});

test("the shipped default is still case-insensitive", () => {
  // Nothing about carrying flags may change what an untouched field does.
  expect(DEFAULT_SEARCH_FLAGS).toBe("i");
  expect(settingsMatcher("sonnet", true).test("SONNET")).toBe(true);
});

test("a `g` flag does not make a list drop every other row", () => {
  // `g` survives `lastIndex` between calls, so a matcher reused down a list
  // returns true, false, true, false — and which rows vanish depends only on the
  // order they were tested in. Every preset the builder ships sets `g`, so this
  // arrives legitimately and is dropped rather than refused.
  const matcher = settingsMatcher("row", true, "gi");
  const rows = ["row one", "row two", "row three", "row four"];
  expect(rows.filter(row => matcher.test(row))).toEqual(rows);
});

test("`y` is dropped for the same reason as `g`", () => {
  const matcher = settingsMatcher("row", true, "yi");
  const rows = ["row one", "row two", "row three"];
  expect(rows.filter(row => matcher.test(row))).toEqual(rows);
});

test("stripStatefulFlags drops only the stateful pair", () => {
  // The chip row derives its "these were ignored" line by calling this, so the
  // row and the matcher cannot disagree about what was dropped.
  expect(stripStatefulFlags("gimsuy")).toBe("imsu");
  expect(stripStatefulFlags("imsu")).toBe("imsu");
  expect(stripStatefulFlags("")).toBe("");
});

test("plain text stays case-insensitive whatever the flags say", () => {
  // The flags describe the regex the builder composes, so they take effect only
  // in the mode that compiles one. A user typing `weekly` to find `Weekly` in
  // plain-text mode is not making a mistake the search should punish.
  expect(settingsMatcher("weekly", false, "").test("Weekly")).toBe(true);
  expect(settingsMatcher("WEEKLY", false, "").test("weekly")).toBe(true);
});

/* ------------------------------------------------------- the two deliberate forks -- */

const VOICES: VoiceOption[] = [
  { name: "Aria", lang: "en-US", uri: "a", source: "local" },
  { name: "HiuMaan", lang: "zh-HK", uri: "b", source: "edge" },
  { name: "aria-lowercase", lang: "en-GB", uri: "c", source: "local" },
] as VoiceOption[];

test("the voice picker honours the flags it is given", () => {
  expect(filterVoices(VOICES, "Aria", true, "").map(v => v.uri)).toEqual(["a"]);
  expect(filterVoices(VOICES, "Aria", true, "i").map(v => v.uri)).toEqual(["a", "c"]);
});

test("the voice picker defaults to the case-insensitive flags it used to hard-code", () => {
  // An older caller that passes no flags must behave exactly as before.
  expect(filterVoices(VOICES, "aria", true).map(v => v.uri)).toEqual(["a", "c"]);
});

test("an unusable pattern leaves the voice list alone rather than blanking it", () => {
  // This deliberately parts company with `settingsMatcher`, which matches nothing
  // on a compile failure. A half-typed pattern must not blank a list of 322
  // voices while the user is still typing it, so the error is reported beside the
  // field and the list is untouched.
  expect(filterVoices(VOICES, "([", true).map(v => v.uri)).toEqual(["a", "b", "c"]);
  // Whereas the shared matcher, used by the settings-shaped searches, does not
  // show rows the user never asked for.
  expect(settingsMatcher("([", true).test("anything")).toBe(false);
  expect(settingsMatcher("([", true).error).not.toBeNull();
});

test("a `g` flag does not thin the voice list either", () => {
  const kept = filterVoices(VOICES, "a", true, "gi");
  expect(kept.map(v => v.uri)).toEqual(["a", "b", "c"]);
});
