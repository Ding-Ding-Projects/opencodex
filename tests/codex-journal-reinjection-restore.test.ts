import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * Regression guard: `markJournalInjectedState` must keep tracking the current
 * round's injected bytes, not just the first round's.
 *
 * `markJournalInjectedState` used to record `injectedConfigHash` only once per
 * journal ("if (journal.injectedConfigHash) return;" in src/codex/journal.ts).
 * A second injection round while the same journal is still open (the proxy
 * restarts on a new port without a clean `ocx stop` in between -- the exact
 * scenario `writeJournal`'s own doc comment calls the "#477 fix" for reusing
 * an existing native snapshot) writes fresh routing to config.toml. With the
 * hash frozen at round one, that second round's own bytes no longer match the
 * recorded fingerprint, and `restoreJournalState` cannot tell that mismatch
 * apart from a real user edit -- so it refused to restore the user's real
 * original config, even though nothing the user did caused the mismatch.
 */

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runScript(codexHome: string, script: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", status: result.status ?? 1 };
}

describe("codex-journal re-injection: injectedConfigHash after a second injection round", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ocx-journal-stale-hash-"));
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  test("markJournalInjectedState advances the hash on a second call instead of freezing at the first round's", () => {
    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const { writeJournal, markJournalInjectedState } = require("./src/codex/journal");

      // Native, pre-injection user config.
      fs.writeFileSync(configPath, 'model_provider = "openai"\\n', "utf8");
      writeJournal();

      // Round 1 injection (e.g. proxy started on port 10101).
      const B1 = 'model_provider = "opencodex"\\n\\n[model_providers.opencodex]\\nbase_url = "http://127.0.0.1:10101"\\n';
      fs.writeFileSync(configPath, B1, "utf8");
      markJournalInjectedState(B1, null);
      const afterRound1 = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), "utf8"));

      // Round 2 injection (proxy restarted on a NEW port, no clean stop in between,
      // no user edit at all -- purely opencodex's own second round of routing).
      const B2 = 'model_provider = "opencodex"\\n\\n[model_providers.opencodex]\\nbase_url = "http://127.0.0.1:20202"\\n';
      fs.writeFileSync(configPath, B2, "utf8");
      markJournalInjectedState(B2, null);
      const afterRound2 = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), "utf8"));

      const crypto = require("crypto");
      const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
      console.log(JSON.stringify({
        hashAfterRound1: afterRound1.injectedConfigHash,
        hashAfterRound2: afterRound2.injectedConfigHash,
        expectedHashForB1: sha256(B1),
        expectedHashForB2: sha256(B2),
      }));
    `);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);

    // Round 1 sets the baseline fingerprint...
    expect(out.hashAfterRound1).toBe(out.expectedHashForB1);
    // ...and round 2 must ADVANCE it to the current injected bytes (B2), not
    // stay frozen at round 1's hash, even though B2 is 100% opencodex-authored.
    expect(out.hashAfterRound2).toBe(out.expectedHashForB2);
  });

  test("a second injection round does not block restoreJournalState from restoring the real original", () => {
    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const { writeJournal, markJournalInjectedState, restoreJournalState } = require("./src/codex/journal");

      const original = 'model_provider = "openai"\\ntrust_level = "trusted"\\n';
      fs.writeFileSync(configPath, original, "utf8");
      writeJournal();

      const B1 = 'model_provider = "opencodex"\\n\\n[model_providers.opencodex]\\nbase_url = "http://127.0.0.1:10101"\\n';
      fs.writeFileSync(configPath, B1, "utf8");
      markJournalInjectedState(B1, null);

      // Second round: still no user edit anywhere -- just opencodex re-injecting
      // on a different port after a restart, exactly as writeJournal's own "#477"
      // comment says must be tolerated.
      const B2 = 'model_provider = "opencodex"\\n\\n[model_providers.opencodex]\\nbase_url = "http://127.0.0.1:20202"\\n';
      fs.writeFileSync(configPath, B2, "utf8");
      markJournalInjectedState(B2, null);

      const result = restoreJournalState();
      console.log(JSON.stringify({
        configRestored: result.configRestored,
        complete: result.complete,
        finalConfig: fs.readFileSync(configPath, "utf8"),
        original,
      }));
    `);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);

    // Expected/correct behavior: no genuine user edit ever happened, so the
    // journal's real original config should be restorable.
    expect(out.configRestored).toBe(true);
    expect(out.finalConfig).toBe(out.original);
  }, 15_000);
});
