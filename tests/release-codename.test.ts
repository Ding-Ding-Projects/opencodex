/**
 * Release codenames.
 *
 * The standing rule is that a release may only be named after a dish that
 * already has a bundled photo — the art is authored elsewhere and this
 * repository never generates it. A codename with no image still produces a
 * release that looks entirely correct in the API and renders as a broken box
 * in the notes, so the guard has to be a test rather than a habit.
 */

import { describe, expect, test } from "bun:test";

import { DISHES } from "../gui/src/shell/dimsum";
import { codenameFor, hasPhoto, photoUrl } from "../scripts/release-codename";

const REPO = "Ding-Ding-Projects/opencodex";

describe("every codename can actually be rendered", () => {
  test("every dish in the table ships a bundled photo", () => {
    // This is the invariant the whole design rests on: because the codename is
    // drawn from the dashboard's own dish table, "has art" is true by
    // construction — but only for as long as that stays true of the table.
    const missing = DISHES.filter(dish => !hasPhoto(dish)).map(dish => dish.id);
    expect(missing).toEqual([]);
  });

  test("a dish with no photo is caught rather than published", () => {
    const invented = { id: "nonexistent-dish", name: "x", zh: "x", jyutping: "x", emoji: "🥟" };
    expect(hasPhoto(invented)).toBe(false);
  });
});

describe("which dish a commit gets", () => {
  test("the same commit always gets the same dish", () => {
    // A re-run publishes the same commit under a different run number. Deriving
    // the name from the run number would rename the release; deriving it from
    // the commit cannot.
    const sha = "0db1c763b9f4a2e1c8d7b6a5f4e3d2c1b0a99887";
    expect(codenameFor(sha).id).toBe(codenameFor(sha).id);
    expect(codenameFor(sha).id).toBe(codenameFor(sha.slice()).id);
  });

  test("different commits do not all land on one dish", () => {
    // A hash that collapsed to a constant would satisfy the determinism case
    // above perfectly while naming every release "har gow".
    const shas = Array.from({ length: 60 }, (_, i) => `commit-number-${i}-abcdef0123456789`);
    const chosen = new Set(shas.map(sha => codenameFor(sha).id));
    expect(chosen.size).toBeGreaterThan(3);
  });

  test("the chosen dish is always one from the table", () => {
    const ids = new Set(DISHES.map(d => d.id));
    for (const sha of ["a", "", "0".repeat(40), "zz", "🥟"]) {
      expect(ids.has(codenameFor(sha).id)).toBe(true);
    }
  });

  test("an empty dish table is an error, not an undefined dish", () => {
    // `dishes[n % 0]` is NaN-indexed and yields undefined, which would surface
    // as `undefined` in a release title rather than as a failure.
    expect(() => codenameFor("abc", [])).toThrow();
  });
});

describe("the photo link in the notes", () => {
  test("is pinned to the released commit, not to a branch", () => {
    // A release note is permanent. An image resolved against `main` breaks the
    // day the file moves, and breaks every past note at the same moment.
    const sha = "0db1c763b9f4a2e1c8d7b6a5f4e3d2c1b0a99887";
    const url = photoUrl(REPO, sha, DISHES[0]);
    expect(url).toContain(`/${sha}/`);
    expect(url).not.toContain("/main/");
    expect(url.endsWith(`${DISHES[0].id}.webp`)).toBe(true);
  });

  test("points at the path the photos are actually bundled under", () => {
    expect(photoUrl(REPO, "sha", DISHES[0])).toContain("/gui/public/dimsum/");
  });
});
