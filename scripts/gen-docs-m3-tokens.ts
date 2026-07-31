/**
 * Refresh the generated token block inside the docs site's single stylesheet.
 *
 * The site and the dashboard must not drift apart, so these values are not hand
 * authored — they come out of the one token engine (`gui/src/theme/m3.ts`, via
 * `shared/m3/tokens.ts`) at the default seed. Same seed, same `buildScheme`,
 * same roles.
 *
 * The literals exist only so the *first paint* is already Material 3. The
 * runtime appearance script overwrites every one of them as soon as it has read
 * the visitor's stored preferences; without the static block there would be a
 * flash of unstyled Starlight before that happens, and a visitor with
 * JavaScript disabled would get no design at all.
 *
 * It is spliced into `docs-site/src/styles/m3.css` between two markers rather
 * than emitted as its own file. The rewrite this belongs to exists because the
 * site had three stylesheets layered over each other in a precedence order
 * nobody could hold in their head; putting the generated values back into a
 * separate file would rebuild the first storey of exactly that.
 *
 *   bun scripts/gen-docs-m3-tokens.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SEED,
  SHAPE_TOKENS,
  buildScheme,
  densityTokens,
  elevationTokens,
  typeTokens,
} from "../shared/m3/tokens";

/** Matches `DEFAULT_APPEARANCE.density` in `docs-site/src/lib/appearance.ts`. */
const DEFAULT_DENSITY = 4;

const SHEET = fileURLToPath(new URL("../docs-site/src/styles/m3.css", import.meta.url));
const START = "/* @generated:m3-tokens — start. Written by scripts/gen-docs-m3-tokens.ts; do not hand-edit. */";
const END = "/* @generated:m3-tokens — end. */";

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
    lines.push("  --m3-type-scale: 1;");
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

const body = [
  START,
  `/* Source: gui/src/theme/m3.ts at seed ${DEFAULT_SEED}, density ${DEFAULT_DENSITY}.`,
  "   Starlight's server render pins data-theme=\"dark\" on <html>, so dark is the",
  "   unqualified default and light is authored as the override. */",
  "",
  block(":root,\n:root[data-theme='dark']", true, true),
  "",
  block(":root[data-theme='light']", false, false),
  END,
].join("\n");

const sheet = readFileSync(SHEET, "utf8");
const from = sheet.indexOf(START);
const to = sheet.indexOf(END);
if (from < 0 || to < 0 || to < from) {
  // Failing loudly beats writing the block twice or appending it to the end,
  // where it would lose to every rule authored above it.
  throw new Error(`Marker pair not found in ${SHEET}. Expected:\n${START}\n…\n${END}`);
}
writeFileSync(SHEET, sheet.slice(0, from) + body + sheet.slice(to + END.length), "utf8");
console.log(`Wrote ${body.split("\n").length} lines of generated tokens into ${SHEET}`);
