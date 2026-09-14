import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOwnedConfigPath } from "../src/lib/config-ownership";
import { removeTempDir } from "./helpers/temp-dir";

// COR-01: recordOwnedConfigPath caches a FAILED ownership claim forever, in memory,
// for as long as the process lives, even after the on-disk reason for the failure
// (a pre-existing, unowned file sharing the directory) is gone. Two config
// directories in the exact same on-disk state (empty, no ownership metadata) must
// be claimable the same way; today they are not, purely because of prior in-process
// call history for one specific path. See src/lib/config-ownership.ts:236-241:
// `recordOwnedConfigPath` caches whatever `loadOwnership(configDir) ??
// createOwnership(configDir)` returns, including `null`, and the only cache
// invalidation trigger is `!existsSync(configDir)` (config-ownership.ts:232), which
// never fires for a directory that stays present but merely becomes empty.
describe("hunt-correct-COR-01: config ownership cache never reconsiders a directory that becomes claimable", () => {
  test("a directory that was briefly non-empty stays permanently unclaimable, unlike an identical fresh one", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-hunt-cor01-"));
    const dirStale = join(parent, "config-stale");
    const dirFresh = join(parent, "config-fresh");
    const foreignPath = join(dirStale, "personal.txt");
    mkdirSync(dirStale);
    writeFileSync(foreignPath, "keep me\n");

    try {
      // First observation: the directory is non-empty and carries no ownership
      // metadata, so claiming it is correctly refused. That refusal gets cached
      // in-process, keyed only by the resolved directory path.
      expect(recordOwnedConfigPath(dirStale, join(dirStale, "config.json"))).toBe(false);

      // The only thing that made the directory unclaimable is now gone. On disk,
      // dirStale is in the identical state as any other freshly created, empty
      // config directory.
      rmSync(foreignPath);
      mkdirSync(dirFresh);

      // A directory that has always been in this exact state (empty, unowned)
      // claims successfully...
      const freshResult = recordOwnedConfigPath(dirFresh, join(dirFresh, "config.json"));
      expect(freshResult).toBe(true);

      // ...but dirStale, now in the SAME on-disk state, must behave the same way.
      // It does not: the stale cached `null` from the first call is reused forever,
      // so every future call for this path is silently refused even though nothing
      // on disk still blocks it. This is exactly the failure mode the module's own
      // ownership tracking exists to avoid: `usage.jsonl`, `config.json`, and every
      // other state file recordOwnedConfigPath is called for (see the call sites
      // across src/config.ts, src/service.ts, src/codex/shim.ts, etc.) silently stop
      // being tracked for clean uninstall for the rest of this process's life.
      const staleResult = recordOwnedConfigPath(dirStale, join(dirStale, "config.json"));
      expect(staleResult).toBe(freshResult);
    } finally {
      removeTempDir(parent);
    }
  });
});
