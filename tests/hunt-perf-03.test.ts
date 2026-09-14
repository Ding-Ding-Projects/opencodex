import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogModelSupportsServiceTier } from "../src/server/request-log";
import { resetCatalogRevisionCachesForTests } from "../src/codex/catalog/parsing";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * PERF-03: catalogModelSupportsServiceTier() (src/server/request-log.ts) is
 * invoked from the Responses-request hot path (src/server/responses/core.ts,
 * ~line 900) once per outbound request whenever a service tier is requested
 * or configured. It has no cache of its own: every call re-reads CODEX_HOME's
 * config.toml (via readCodexCatalogPath) AND re-reads-and-JSON.parses the
 * entire model catalog file (via readCatalog), then does a linear .find()
 * over the models array. None of that work depends on anything that changes
 * between requests within a session, so repeated calls with the identical
 * (modelId, serviceTier) pair should not force a fresh disk read every time.
 *
 * This guard counts real fs.readFileSync calls rather than asserting a
 * timing threshold, so it is stable across hosts: it is red as long as every
 * call re-reads the catalog from disk, and turns green once a correct fix
 * caches the parsed catalog (invalidated on the file's own revision, the same
 * pattern already used for usage.jsonl in src/usage/log.ts).
 */
describe("hunt-perf-03: catalogModelSupportsServiceTier re-reads the catalog on every call", () => {
  let dir = "";
  let previousCodexHome: string | undefined;

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (dir) { try { removeTempDir(dir); } catch { /* best-effort */ } dir = ""; }
    // Every test in this file gets a fresh mkdtemp path, so the revision memo cannot serve a
    // stale hit across tests on its own -- this is belt-and-suspenders isolation, not a
    // requirement for the assertions above and below to pass.
    resetCatalogRevisionCachesForTests();
  });

  test("repeated calls with the same model/tier do not share a cached parsed catalog", () => {
    previousCodexHome = process.env.CODEX_HOME;
    dir = mkdtempSync(join(tmpdir(), "ocx-catalog-service-tier-"));
    process.env.CODEX_HOME = dir;
    writeFileSync(
      join(dir, "opencodex-catalog.json"),
      JSON.stringify({
        models: [{ slug: "gpt-5.5", id: "gpt-5.5", service_tiers: [{ id: "priority" }] }],
      }),
    );

    let catalogReadCount = 0;
    const originalReadFileSync = fs.readFileSync;
    // Wrap (not replace) the real implementation so behavior is unchanged --
    // this only counts how many times the catalog file's bytes get re-read.
    // spyOn (not direct assignment) is required: the fs ESM namespace exports
    // are read-only bindings that reject a plain property assignment.
    const spy = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      const target = String(args[0]);
      if (target.endsWith("opencodex-catalog.json")) catalogReadCount += 1;
      return originalReadFileSync(...(args as [never]));
    });

    try {
      catalogModelSupportsServiceTier("gpt-5.5", "priority");
      catalogModelSupportsServiceTier("gpt-5.5", "priority");
      catalogModelSupportsServiceTier("gpt-5.5", "priority");
    } finally {
      spy.mockRestore();
    }

    // Currently red: 3 calls with the identical (modelId, serviceTier) pair
    // still read and JSON.parse the whole catalog file 3 times. A cache keyed
    // on the catalog file's own revision would read it once and turn this
    // green.
    expect(catalogReadCount).toBeLessThanOrEqual(1);
  });

  test("a modified catalog file is re-read and its new content is used on the next call", () => {
    previousCodexHome = process.env.CODEX_HOME;
    dir = mkdtempSync(join(tmpdir(), "ocx-catalog-service-tier-revision-"));
    process.env.CODEX_HOME = dir;
    const catalogPath = join(dir, "opencodex-catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        models: [{ slug: "gpt-5.5", id: "gpt-5.5", service_tiers: [{ id: "priority" }] }],
      }),
    );

    let catalogReadCount = 0;
    const originalReadFileSync = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      const target = String(args[0]);
      if (target.endsWith("opencodex-catalog.json")) catalogReadCount += 1;
      return originalReadFileSync(...(args as [never]));
    });

    try {
      // Call twice on the SAME content first: this is what actually proves invalidation below,
      // as opposed to a no-cache implementation that would also happen to see fresh content on
      // every call. Without this pair, the two assertions after the rewrite hold trivially even
      // with no caching at all, since "always re-read" also picks up a subsequent edit.
      expect(catalogModelSupportsServiceTier("gpt-5.5", "priority")).toBe(true);
      expect(catalogModelSupportsServiceTier("gpt-5.5", "priority")).toBe(true);
      expect(catalogReadCount).toBe(1);

      // Rewrite with a genuinely different (longer) body rather than merely touching mtime, so
      // the revision key (size + mtime) cannot collide with the cached one even on a filesystem
      // with coarse mtime resolution -- gpt-5.5 also loses its priority tier in the new body,
      // so this proves the fresh bytes are actually used, not merely re-read and discarded.
      writeFileSync(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: "gpt-5.5", id: "gpt-5.5", service_tiers: [] },
            { slug: "gpt-5.6", id: "gpt-5.6", service_tiers: [{ id: "priority" }] },
          ],
        }),
      );

      expect(catalogModelSupportsServiceTier("gpt-5.5", "priority")).toBe(false);
      expect(catalogReadCount).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
