/**
 * Key resolution — the one path from a key to the string a user reads.
 *
 * Lifted out of `provider.tsx` so it can be exercised without a React tree.
 * That is not tidiness: the funny-level promise is about *rendered* copy, and a
 * test that only reads `voice.ts` proves the overlay exists, not that the app
 * shows it. These functions are what `t()` calls, so a test calling them is
 * testing the same thing the screen does.
 */

import {
  DICTS, FUNNY_DEFAULT, PARTIAL_DICTS, interpolate, voiceLangsFor,
  type FunnyLevels, type Locale, type TKey, type Vars,
} from "./shared";
import { en } from "./en";
import { M3_EN, M3_OVERRIDES, type M3Key } from "./m3";
import { voiceFor, type FunnyLevel, type VoiceLang } from "./voice";
import { applyVocabularyToTemplate, getActiveVocabularyEntries } from "./personal-vocabulary";
import { isSchoolModeActive } from "../school-mode/client";

/**
 * Resolution order for one voice track: the funny-level variant, then the
 * locale's product dictionary, then its partial dictionary, then its M3
 * overrides, then English in the same order. A key that exists nowhere renders
 * as itself, which makes a typo obvious in the UI instead of silently blank.
 *
 * The funny variant comes first on purpose: it is the only layer the user
 * changes at runtime, so everything under it is a default the level may style.
 */
export function resolveTrack(locale: Locale, voice: VoiceLang, level: FunnyLevel, key: TKey): string {
  const styled = voiceFor(voice, key, level);
  if (styled !== null) return styled;

  const full = (DICTS as Partial<Record<Locale, Partial<Record<TKey, string>>>>)[locale];
  const partial = PARTIAL_DICTS[locale];
  return full?.[key]
    ?? partial?.[key]
    ?? M3_OVERRIDES[locale as keyof typeof M3_OVERRIDES]?.[key as M3Key]
    ?? (en as Partial<Record<TKey, string>>)[key]
    ?? M3_EN[key as M3Key]
    ?? key;
}

/**
 * The one separator between the two halves of a bilingual string.
 *
 * It is a constant rather than a literal at each site because three separate
 * pieces of code have to agree on it exactly — the one that joins the halves,
 * the one that splits a value back apart, and the one that merges a list of
 * them. A stray missing space in any of the three would not fail to compile; it
 * would quietly stop a value being recognised as bilingual, which renders as the
 * old doubled text rather than as an error.
 */
const BILINGUAL_SEP = " · ";

/**
 * Bilingual mode renders both tracks, English first.
 *
 * English stays the primary reading and Cantonese follows it as a compact
 * secondary label after a middle dot — the progressive-disclosure shape, not two
 * stacked paragraphs, so a nav rail or a chip does not double in height.
 *
 * The two are joined only when they actually differ. An untranslated key falls
 * back to English in the Cantonese track as well, so joining unconditionally
 * would print those strings twice — which reads as a rendering bug rather than
 * as a bilingual interface.
 */
export function resolveKey(locale: Locale, funny: FunnyLevels, key: TKey): string {
  const tracks = voiceLangsFor(locale);
  if (tracks.length === 1) {
    const only = tracks[0]!;
    return resolveTrack(locale, only, funny[only], key);
  }
  const english = resolveTrack("en", "en", funny.en, key);
  const cantonese = resolveTrack("yue", "yue", funny.yue, key);
  return cantonese && cantonese !== english ? `${english}${BILINGUAL_SEP}${cantonese}` : english;
}

/**
 * The two halves of a bilingual string, for a surface that wants to lay them
 * out itself rather than take the joined form — a two-line list item, a chip
 * with a secondary label, a tooltip. `secondary` is empty when the tracks agree,
 * so a caller never renders the same sentence twice.
 */
export function bilingualParts(locale: Locale, funny: FunnyLevels, key: TKey): { primary: string; secondary: string } {
  const tracks = voiceLangsFor(locale);
  if (tracks.length === 1) {
    const only = tracks[0]!;
    return { primary: resolveTrack(locale, only, funny[only], key), secondary: "" };
  }
  const primary = resolveTrack("en", "en", funny.en, key);
  const cantonese = resolveTrack("yue", "yue", funny.yue, key);
  return { primary, secondary: cantonese && cantonese !== primary ? cantonese : "" };
}

/**
 * The two halves of a value that already came out of `t()` in bilingual mode,
 * or `null` when the value is not a bilingual pair.
 *
 * Exactly one separator is required, not "at least one". A value with none is
 * plainly not bilingual — a model id, a port, a count, a file path. A value with
 * several is something else again, and the distinction matters: a list of
 * bilingual labels naively joined with a comma reads
 * `Language · 語言, Theme · 主題`, and taking the first and second pieces of that
 * would put "Theme" in the Cantonese clause and drop it from the English one.
 * Both of those cases are used unchanged in both halves, which is exactly what
 * the old joined-template behaviour did for *every* value — so an unrecognised
 * shape degrades to the previous rendering rather than to a mangled one.
 *
 * `joinBilingual` exists so that a caller building such a list produces a single
 * well-formed pair instead of falling into that second case by accident.
 */
function bilingualHalves(value: string): [string, string] | null {
  const halves = value.split(BILINGUAL_SEP);
  return halves.length === 2 ? [halves[0]!, halves[1]!] : null;
}

/** The variables as one track sees them: each bilingual pair reduced to its half. */
function trackVars(vars: Vars | undefined, index: 0 | 1): Vars | undefined {
  if (!vars) return undefined;
  const filled: Vars = {};
  for (const [name, value] of Object.entries(vars)) {
    const halves = typeof value === "string" ? bilingualHalves(value) : null;
    filled[name] = halves ? halves[index] : value;
  }
  return filled;
}

/**
 * Merge several possibly-bilingual strings into one bilingual string.
 *
 * A caller that lists translated names — the settings a save was refused for,
 * say — cannot simply `join(", ")` them in bilingual mode, because the result
 * carries one separator per item and is no longer a pair anything can split. It
 * has to be regrouped: all the English, then all the Cantonese, with the single
 * separator between the two groups.
 *
 *   ["Language · 語言", "Theme · 主題"]  ->  "Language, Theme · 語言, 主題"
 *
 * An item with no Cantonese half is used in both groups, and when no item has
 * one — every single-track locale, and a bilingual list of untranslated names —
 * the two groups come out identical and the plain join is returned, keeping the
 * rule that the halves are only joined when they actually differ.
 */
export function joinBilingual(values: string[], separator: string): string {
  const halves = values.map(bilingualHalves);
  const english = values.map((value, i) => halves[i]?.[0] ?? value).join(separator);
  const cantonese = values.map((value, i) => halves[i]?.[1] ?? value).join(separator);
  return cantonese === english ? english : `${english}${BILINGUAL_SEP}${cantonese}`;
}

/**
 * What `t()` returns: the resolved string with its placeholders filled in.
 *
 * In bilingual mode the template is resolved *per track* and each variable's
 * matching half is interpolated into each, so English gets the English name and
 * Cantonese gets the Cantonese one.
 *
 * Doing that here rather than in a helper a caller must remember to reach for is
 * the point. The joined-then-interpolated form substituted the whole value into
 * both halves, and when the value had itself come from `t()` it was already
 * `English · 廣東話`, so the result read
 *
 *   Edit appearance: Filled buttons · 實心按鈕 · 改外觀：Filled buttons · 實心按鈕
 *
 * — the name twice in each half, with the English name sitting inside the
 * Cantonese clause. That was first noticed on the element context menu and fixed
 * there alone, behind an opt-in helper; by the time anyone looked again the same
 * shape had reached the settings-save notices and a dozen other call sites,
 * because the default was the broken path and the fix was the thing you had to
 * know to ask for. Inverting that is the actual repair. Nothing has to opt in,
 * and a call site added tomorrow is right without its author having read this.
 *
 * Single-track locales keep the old path exactly: one template, one set of
 * variables, and no separator to look for. Splitting there would be a new bug
 * rather than a fix, because a value that happens to contain the separator
 * character is a value, not a pair, and half of it would silently disappear.
 *
 * ## The personal-vocabulary boundary
 *
 * This is also the one place the user's local vocabulary — see
 * `personal-vocabulary.ts` — is ever applied. It runs on the *resolved
 * template*, after `resolveTrack`/`bilingualParts` but strictly before
 * `interpolate`, which is what keeps it from ever touching a value that
 * arrived through `vars`: a model id, a path, a command, a server's own error
 * text. Those are substituted in afterwards, so a vocabulary term can only ever
 * match the dictionary's own authored words. With no vocabulary loaded — the
 * default, and the state every existing caller of `translate` was written
 * against — `applyVocabularyToTemplate` is a same-string no-op, so this changes
 * nothing about how any of the above behaves until a user actually uploads a
 * file.
 *
 * ## The School Mode boundary
 *
 * This is also the one place School Mode (`../school-mode/client`) is ever
 * applied. While it is active, every one of `locale`, `funny` and the
 * personal vocabulary is overridden before anything below runs: `locale`
 * forces `"en"` (the contract's "apps force English presentation", covering
 * every shipped language, not only Cantonese/bilingual), `funny` forces the
 * neutral house voice on both tracks (the contract's "funny-level...
 * capabilities behave as if they are not installed" — not merely quieter,
 * gone, which for a voice overlay means the default level rather than any
 * level the user actually chose), and the vocabulary is dropped entirely
 * (same reasoning as above). The caller's real `locale`/`funny` arguments,
 * and whatever vocabulary file is loaded, are left completely untouched in
 * storage — this only changes what one call renders, which is what lets "the
 * user's prior choices remain stored and return only after the mode is
 * turned off" hold without this function needing to know anything about
 * persistence.
 *
 * Gating here rather than in each caller is deliberate: `settings-drafts.tsx`
 * also calls `translate()` directly (for a settings-saved notification), and
 * gating there too would be a second place this could quietly drift out of
 * step with the first.
 */
export function translate(locale: Locale, funny: FunnyLevels, key: TKey, vars?: Vars): string {
  const forced = isSchoolModeActive();
  const effectiveLocale: Locale = forced ? "en" : locale;
  const effectiveFunny: FunnyLevels = forced ? { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT } : funny;
  const vocabulary = forced ? null : getActiveVocabularyEntries();
  const tracks = voiceLangsFor(effectiveLocale);
  if (tracks.length === 1) {
    const only = tracks[0]!;
    const template = applyVocabularyToTemplate(resolveTrack(effectiveLocale, only, effectiveFunny[only], key), vocabulary);
    return interpolate(template, vars);
  }
  const parts = bilingualParts(effectiveLocale, effectiveFunny, key);
  const primary = applyVocabularyToTemplate(parts.primary, vocabulary);
  const secondary = applyVocabularyToTemplate(parts.secondary, vocabulary);
  const english = interpolate(primary, trackVars(vars, 0));
  if (!secondary) return english;
  const cantonese = interpolate(secondary, trackVars(vars, 1));
  return cantonese === english ? english : `${english}${BILINGUAL_SEP}${cantonese}`;
}
