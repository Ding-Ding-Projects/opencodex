/**
 * Every label `TypographyEditor` can render.
 *
 * The rows filter *themselves* against the search predicate — that is what stops
 * a table of labels going stale the first time one is reworded, because a row
 * that no longer matches its own label simply stops appearing and the bug is
 * visible. But the search bar above still needs the same list twice over: to say
 * "nothing matched" honestly, and to give the regex builder a sample of the real
 * strings a pattern will run against.
 *
 * Its own module rather than an export from the editor: a file that exports both
 * a component and a constant loses Fast Refresh for the component, so editing
 * the editor would reset every open popover in it.
 */

import type { TKey } from "../../i18n/shared";

export const TYPOGRAPHY_LABEL_KEYS = [
  "font.family", "type.size", "type.weight", "type.slant", "type.obliqueAngle",
  "type.underline", "type.underlineColor", "type.underlineThickness",
  "type.strike", "type.overline",
  "type.caps", "type.script",
  "type.color", "type.highlight", "type.outline", "type.outlineColor",
  "type.shadowX", "type.shadowY", "type.shadowBlur", "type.shadowColor",
  "type.glow", "type.glowColor",
  "type.letterSpacing", "type.wordSpacing", "type.lineHeight", "type.baseline",
  "type.direction", "type.align",
] as const satisfies readonly TKey[];
