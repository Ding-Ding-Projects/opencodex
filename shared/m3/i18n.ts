/**
 * Language modes and funny levels, as machinery rather than as copy.
 *
 * The dashboard already ships the finished version of this idea in
 * `gui/src/i18n/` — `shared.ts` for the mode vocabulary, `voice.ts` for the
 * five-rung overlay, `resolve.ts` for the lookup chain. What it does not ship is
 * a way for a *second* product to use any of it, because every one of those
 * modules is welded to the dashboard's own 2 000-key dictionary: `TKey` is
 * literally `keyof typeof en`, and `VOICE` is a table of the dashboard's
 * sentences. A documentation site has its own copy deck and none of those keys.
 *
 * So the split is: **the algorithm is shared, the sentences are not.** Every
 * function here is generic over the consumer's key type and takes its
 * dictionaries as arguments. Nothing in this file is a string a user reads.
 *
 * ## Why the types come from the dashboard and the code does not
 *
 * `FunnyLevel`, `VoiceLang` and `VoiceCategory` are imported from
 * `gui/src/i18n/voice` with `import type`, which esbuild erases — so this module
 * has a compile-time dependency on the dashboard's vocabulary and a runtime
 * dependency on nothing. That is the whole point: if the dashboard ever grows a
 * sixth funny level or a twelfth voice category, the docs site stops compiling
 * instead of quietly meaning something different by the same word. Importing the
 * *values* would have pulled the dashboard's entire 1 500-line VOICE table into
 * a documentation bundle, which is exactly the copy this file refuses to share.
 *
 * ## What this deliberately does not do
 *
 *  - It does not read or write `localStorage` on its own account. `readFunny` /
 *    `writeFunny` take the storage key from the caller, because a docs visitor
 *    and a dashboard operator are different people and must not share a slider.
 *    (`gui/src/i18n/shared.ts` still hard-codes `ocx-m3:funny`; when that is
 *    retired it calls these with its own key and the duplication ends.)
 *  - It does not touch React. A `client:only` island, an Astro `<script>` and a
 *    test runner all need the same answers, and two of those three have no
 *    component tree.
 *  - It does not decide what "the current mode" is. Resolving a URL locale
 *    against a stored preference is a product question — the docs site answers
 *    it one way (content locale vs. UI mode are different axes), the dashboard
 *    another (there is only one axis) — and a shared guess would be wrong for
 *    both.
 */

import type { FunnyLevel, VoiceCategory, VoiceLang } from "../../gui/src/i18n/voice";

export type { FunnyLevel, VoiceCategory, VoiceLang };

/**
 * The categories a funny level restyles, enumerated so "every category, no
 * exemptions" is testable rather than merely asserted.
 *
 * Restated here rather than re-exported from `voice.ts`: that module's only
 * value export sits in the same file as the dashboard's whole VOICE table, and
 * pulling one constant out of it would ask a bundler's tree-shaker to drop a
 * 60 kB object literal on the strength of a `Partial<Record<…>>` it cannot fully
 * prove is unused. The exhaustiveness check below makes the restatement safe:
 * add a category to the union in `voice.ts` and this file stops compiling.
 */
export const VOICE_CATEGORIES = [
  "destructive",
  "security",
  "financial",
  "accessibility",
  "error",
  "warning",
  "success",
  "progress",
  "empty",
  "guidance",
  "delight",
] as const satisfies readonly VoiceCategory[];

/** Compile-time only: fails if `VoiceCategory` gains a member this list lacks. */
type MissingCategory = Exclude<VoiceCategory, (typeof VOICE_CATEGORIES)[number]>;
const _everyCategoryListed: MissingCategory[] = [];
void _everyCategoryListed;

/** 1 (fully serious) through 5 (maximum playfulness), in slider order. */
export const FUNNY_LEVELS = [1, 2, 3, 4, 5] as const satisfies readonly FunnyLevel[];

/**
 * The two levels, one per voice track.
 *
 * Independent by requirement: a reader may want deadpan English beside playful
 * 廣東話, and one shared slider cannot express that.
 */
export interface FunnyLevels {
  en: FunnyLevel;
  yue: FunnyLevel;
}

/**
 * Level 3 is the default *and* the neutral rung — the level with no entries in
 * any overlay, so it resolves straight through the ordinary dictionary. That is
 * why an overlay never has to restate the shipped wording.
 */
export const FUNNY_DEFAULT: FunnyLevel = 3;

/* ------------------------------------------------------------------ voice -- */

export type LevelMap = Partial<Record<FunnyLevel, string>>;

/**
 * One key's voiced wording, both tracks in one entry.
 *
 * English and Cantonese share an entry on purpose: they have to say the same
 * thing at the same level, and two separate tables is how one track ends up two
 * rungs louder than the other. No level is required — an absent level falls
 * through to the neutral dictionary, which is what keeps an overlay a curated
 * few dozen keys rather than a second full translation.
 */
export interface VoiceEntry {
  cat: VoiceCategory;
  en: LevelMap;
  yue: LevelMap;
}

export type VoiceTable<K extends string> = Partial<Record<K, VoiceEntry>>;

export interface Voice<K extends string> {
  /** The voiced string, or null to fall through to the dictionaries. */
  stringFor(lang: VoiceLang, key: K, level: FunnyLevel): string | null;
  /** True when this key has any voiced wording at all in that track. */
  has(lang: VoiceLang, key: K): boolean;
  /** How many keys carry voiced wording in a track — for an honest coverage line. */
  coverage(lang: VoiceLang): number;
  /** Voiced keys, optionally filtered to one category. */
  keys(cat?: VoiceCategory): K[];
  categoryOf(key: K): VoiceCategory | null;
  /** Per-category counts, so a settings page can state real numbers. */
  categoryCoverage(): Record<VoiceCategory, number>;
  /** Which levels this key actually varies at, in ascending order. */
  levelsFor(lang: VoiceLang, key: K): FunnyLevel[];
}

/**
 * Wrap a table in the queries a settings screen and a resolver both need.
 *
 * The coverage functions exist because the promise is "the level restyles every
 * category", not "the level rewrites all two thousand strings" — a settings page
 * that states the real per-category numbers is telling the truth, and one that
 * implies the whole product is rewritten is not.
 */
export function makeVoice<K extends string>(table: VoiceTable<K>): Voice<K> {
  const rows = () => Object.entries(table) as [K, VoiceEntry][];
  const voiced = (entry: VoiceEntry, lang: VoiceLang) => Object.keys(entry[lang]).length > 0;

  return {
    stringFor(lang, key, level) {
      return table[key]?.[lang][level] ?? null;
    },
    has(lang, key) {
      const entry = table[key];
      return !!entry && voiced(entry, lang);
    },
    coverage(lang) {
      return rows().filter(([, entry]) => voiced(entry, lang)).length;
    },
    keys(cat) {
      return rows().filter(([, entry]) => !cat || entry.cat === cat).map(([key]) => key);
    },
    categoryOf(key) {
      return table[key]?.cat ?? null;
    },
    categoryCoverage() {
      const out = Object.fromEntries(VOICE_CATEGORIES.map(c => [c, 0])) as Record<VoiceCategory, number>;
      for (const [, entry] of rows()) out[entry.cat]++;
      return out;
    },
    levelsFor(lang, key) {
      const map = table[key]?.[lang];
      if (!map) return [];
      return FUNNY_LEVELS.filter(level => map[level] !== undefined);
    },
  };
}

/* --------------------------------------------------------------- resolver -- */

export type Vars = Record<string, string | number>;

/** `{name}` substitution. Split/join rather than a regex so a value containing
 *  `$&` cannot smuggle a replacement pattern into the output. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  let out = text;
  for (const key of Object.keys(vars)) out = out.split(`{${key}}`).join(String(vars[key]));
  return out;
}

/**
 * Which voice tracks a mode renders.
 *
 * Generic over the mode string rather than a closed union, because the two
 * consumers have different mode sets — the dashboard has eight, the docs site
 * has "follow the page" plus seven — and the only thing shared is this rule:
 * `yue` is one Cantonese track, `bi` is both, everything else is English-voiced.
 * A mode with its own translated dictionary (`ja`, `ko`, …) still reports the
 * `en` track, which is correct and is why the settings screen must say plainly
 * that the sliders do not restyle those languages.
 */
export function voiceLangsFor(mode: string): VoiceLang[] {
  if (mode === "yue") return ["yue"];
  if (mode === "bi") return ["en", "yue"];
  return ["en"];
}

export interface DeckConfig<K extends string, M extends string> {
  /**
   * The complete base deck. Every key resolves here or nowhere, which is what
   * makes a missing translation a fallback rather than a blank label.
   */
  base: Readonly<Record<K, string>>;
  /** Per-mode dictionaries, each free to be partial. */
  dicts: Partial<Record<M, Partial<Record<K, string>>>>;
  voice: Voice<K>;
}

export interface Resolver<K extends string, M extends string> {
  resolveTrack(mode: M, track: VoiceLang, level: FunnyLevel, key: K): string;
  resolveKey(mode: M, funny: FunnyLevels, key: K): string;
  bilingualParts(mode: M, funny: FunnyLevels, key: K): { primary: string; secondary: string };
  translate(mode: M, funny: FunnyLevels, key: K, vars?: Vars): string;
}

/**
 * Bind a deck to the lookup chain.
 *
 * Order, per track: the funny-level variant, then the mode's own dictionary,
 * then the base deck, then the key itself. The variant comes first because it is
 * the only layer the reader changes at runtime — everything under it is a
 * default the level is allowed to restyle. A key that exists nowhere renders as
 * its own name, so a typo is visible in the interface instead of silently blank.
 */
export function makeResolver<K extends string, M extends string>(
  config: DeckConfig<K, M>,
): Resolver<K, M> {
  const { base, dicts, voice } = config;

  const resolveTrack: Resolver<K, M>["resolveTrack"] = (mode, track, level, key) => {
    const styled = voice.stringFor(track, key, level);
    if (styled !== null) return styled;
    return dicts[mode]?.[key] ?? base[key] ?? key;
  };

  /**
   * Bilingual renders English first with Cantonese as a compact secondary after
   * a middle dot — progressive disclosure, not two stacked paragraphs, so a tab
   * label or a chip does not double in height at the width where it is already
   * tightest.
   *
   * Joined only when the two actually differ. An untranslated key falls back to
   * English in the Cantonese track too, so joining unconditionally would print
   * the same sentence twice, which reads as a rendering bug rather than as a
   * bilingual interface.
   */
  const parts: Resolver<K, M>["bilingualParts"] = (mode, funny, key) => {
    const tracks = voiceLangsFor(mode);
    if (tracks.length === 1) {
      const only = tracks[0]!;
      return { primary: resolveTrack(mode, only, funny[only], key), secondary: "" };
    }
    const primary = resolveTrack("en" as M, "en", funny.en, key);
    const cantonese = resolveTrack("yue" as M, "yue", funny.yue, key);
    return { primary, secondary: cantonese && cantonese !== primary ? cantonese : "" };
  };

  const resolveKey: Resolver<K, M>["resolveKey"] = (mode, funny, key) => {
    const { primary, secondary } = parts(mode, funny, key);
    return secondary ? `${primary} · ${secondary}` : primary;
  };

  return {
    resolveTrack,
    resolveKey,
    bilingualParts: parts,
    translate: (mode, funny, key, vars) => interpolate(resolveKey(mode, funny, key), vars),
  };
}

/* -------------------------------------------------------------- storage -- */

export function clampFunny(value: unknown): FunnyLevel {
  const n = Math.round(Number(value));
  return (n >= 1 && n <= 5 ? n : FUNNY_DEFAULT) as FunnyLevel;
}

/**
 * Read both levels from storage, clamping on the way in.
 *
 * Clamped at read rather than trusted, for the same reason the appearance
 * preferences are: a hand-edited or corrupted entry must not be able to select a
 * level that has no wording, which would render the interface as bare key names
 * with no route back to the setting that would fix it.
 */
export function readFunny(storageKey: string, storage?: Pick<Storage, "getItem">): FunnyLevels {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(storageKey) || "null");
    if (!raw || typeof raw !== "object") return { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT };
    const row = raw as Partial<FunnyLevels>;
    return { en: clampFunny(row.en), yue: clampFunny(row.yue) };
  } catch {
    return { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT };
  }
}

export function writeFunny(
  storageKey: string,
  levels: FunnyLevels,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage ?? localStorage).setItem(storageKey, JSON.stringify(levels));
  } catch {
    // Private browsing or a full quota. The level still applies to this page,
    // which beats refusing the change the reader just made.
  }
}
