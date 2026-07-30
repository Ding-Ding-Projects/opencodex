/**
 * Generate the docs site's static Material 3 token block.
 *
 * The site and the dashboard must not drift apart, so the tokens are not hand
 * authored here — they come out of the dashboard's own engine
 * (`gui/src/theme/m3.ts`) at the default seed. Same seed, same buildScheme,
 * same roles.
 *
 * These literals exist only so the *first paint* is already Material 3. The
 * runtime appearance script overwrites all of them the moment it has read the
 * visitor's stored preferences; without the static block there would be a
 * flash of unstyled Starlight before that happens.
 *
 *   bun scripts/gen-docs-m3-tokens.ts > docs-site/src/styles/m3-tokens.css
 */

import {
  DEFAULT_SEED,
  SHAPE_TOKENS,
  buildScheme,
  densityTokens,
  elevationTokens,
  typeTokens,
} from "../gui/src/theme/m3";

/** Matches `DEFAULT_PREFS.density` in `gui/src/theme/prefs-context.ts`. */
const DEFAULT_DENSITY = 4;

function block(selector: string, dark: boolean, includeShared: boolean): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(buildScheme(DEFAULT_SEED, dark))) {
    lines.push(`  --m3-${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(elevationTokens(dark))) {
    lines.push(`  ${key}: ${value};`);
  }
  // Density, type and shape do not vary by theme, so they are emitted once.
  if (includeShared) {
    for (const [key, value] of Object.entries(densityTokens(DEFAULT_DENSITY))) lines.push(`  ${key}: ${value};`);
    for (const [key, value] of Object.entries(typeTokens(1))) lines.push(`  ${key}: ${value};`);
    for (const [key, value] of Object.entries(SHAPE_TOKENS)) lines.push(`  ${key}: ${value};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

const out = [
  "/* ===========================================================================",
  "   Material 3 role tokens for the docs site — GENERATED, do not hand-edit.",
  "",
  `   Source: gui/src/theme/m3.ts at seed ${DEFAULT_SEED}, density ${DEFAULT_DENSITY}.`,
  "   Regenerate with:  bun scripts/gen-docs-m3-tokens.ts > docs-site/src/styles/m3-tokens.css",
  "",
  "   Starlight pins `data-theme` on the root, so dark is the unqualified",
  "   default and light is authored as an override — the same shape the",
  "   dashboard uses.",
  "   =========================================================================== */",
  "",
  block(":root,\n:root[data-theme='dark']", true, true),
  "",
  block(":root[data-theme='light']", false, false),
  "",
].join("\n");

console.log(out);
