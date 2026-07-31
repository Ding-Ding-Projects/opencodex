/**
 * The dim sum codename for a release.
 *
 * Every automated build is titled `build 26 — v2.7.42 @ 0db1c763b`, which tells
 * you everything except which one anybody meant. A dish name is memorable in a
 * way a run number is not: "the har gow build" survives a conversation, "26"
 * does not.
 *
 * ## Why it reads the dashboard's own dish table
 *
 * `gui/src/shell/dimsum.ts` already holds the dishes, their Chinese names and
 * their Jyutping, and each one already ships a bundled photo under
 * `gui/public/dimsum/`. Copying that table into a workflow file would create a
 * second one to keep in step, and the failure would be silent: a release named
 * after a dish with no photo still looks like a correct release. Importing the
 * real table means the set of possible codenames is exactly the set of dishes
 * that have art, by construction rather than by discipline.
 *
 * ## Why it is derived from the commit, not the run number
 *
 * A run number is not stable — a re-run publishes the same commit under a
 * different number, and the release would change its name. Hashing the commit
 * SHA means one commit is always the same dish, however many times it is built,
 * and consecutive commits still land on unrelated dishes.
 *
 * This script deliberately does not generate images. The photos are authored
 * elsewhere and bundled; a codename may only ever name a dish that already has
 * one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { DISHES, type DimSumDish } from "../gui/src/shell/dimsum";

/** Where the bundled photos live, relative to the repository root. */
export const PHOTO_DIR = join("gui", "public", "dimsum");

/**
 * FNV-1a over the SHA.
 *
 * Any stable hash would do; this one is four lines and has no dependency. It
 * is not used for anything security-sensitive — it picks a dumpling.
 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32 bits; a plain `*` loses precision
    // past 2^53 and would make the result depend on how far the loop had run.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The dish naming a given commit. Deterministic: same SHA, same dish, always. */
export function codenameFor(sha: string, dishes: DimSumDish[] = DISHES): DimSumDish {
  if (dishes.length === 0) throw new Error("no dishes are available to name a release");
  return dishes[hash(sha) % dishes.length];
}

/**
 * The photo URL for a dish, pinned to the commit being released.
 *
 * Pinned rather than pointing at `main`: a release note is a permanent record,
 * and an image resolved against a moving branch breaks the day the file is
 * renamed — turning every past release note into a broken image at once.
 */
export function photoUrl(repo: string, sha: string, dish: DimSumDish): string {
  return `https://raw.githubusercontent.com/${repo}/${sha}/gui/public/dimsum/${dish.id}.webp`;
}

/** True when the dish's photo is actually present in this checkout. */
export function hasPhoto(dish: DimSumDish, root = process.cwd()): boolean {
  return existsSync(join(root, PHOTO_DIR, `${dish.id}.webp`));
}

/**
 * `bun scripts/release-codename.ts <sha> [repo]` — prints `KEY=value` lines for
 * a workflow to read with `>> $GITHUB_ENV`. Values are single-line by
 * construction (dish names have no newlines), so no heredoc quoting is needed.
 */
if (import.meta.main) {
  const sha = process.argv[2];
  const repo = process.argv[3] ?? "Ding-Ding-Projects/opencodex";
  if (!sha) {
    console.error("usage: bun scripts/release-codename.ts <sha> [owner/repo]");
    process.exit(2);
  }
  const dish = codenameFor(sha);
  // Fail loudly rather than publish a release named after a dish with no photo.
  // A missing image renders as a broken box in the release note, which looks
  // exactly like a correct release to anyone not looking closely.
  if (!hasPhoto(dish)) {
    console.error(`::error::No bundled photo for the chosen dish "${dish.id}" — refusing to name a release after art that does not exist.`);
    process.exit(1);
  }
  const values: Record<string, string> = {
    DISH_ID: dish.id,
    DISH_NAME: dish.name,
    DISH_ZH: dish.zh,
    DISH_JYUTPING: dish.jyutping,
    DISH_PHOTO: photoUrl(repo, sha, dish),
  };
  // `$GITHUB_ENV` is a line-oriented file: a value carrying a newline does not
  // fail, it silently defines whatever the next line happens to look like. No
  // dish name contains one today, which is exactly why this would go unnoticed
  // the day one does.
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) {
      console.error(`::error::${key} contains a line break and cannot be written to the workflow environment.`);
      process.exit(1);
    }
  }
  console.log(Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"));
}
