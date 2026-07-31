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
  DICTS, PARTIAL_DICTS, interpolate, voiceLangsFor,
  type FunnyLevels, type Locale, type TKey, type Vars,
} from "./shared";
import { en } from "./en";
import { M3_EN, M3_OVERRIDES, type M3Key } from "./m3";
import { voiceFor, type FunnyLevel, type VoiceLang } from "./voice";

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
  return cantonese && cantonese !== english ? `${english} · ${cantonese}` : english;
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

/** What `t()` returns: the resolved string with its placeholders filled in. */
export function translate(locale: Locale, funny: FunnyLevels, key: TKey, vars?: Vars): string {
  return interpolate(resolveKey(locale, funny, key), vars);
}
