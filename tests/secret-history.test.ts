/**
 * `src/lib/secret-history.ts` — the encrypted+redacted git history behind the
 * "Secret and display-name mutation history" contract.
 *
 * These spawn a real `git` and a real (non-elevated) PowerShell/DPAPI process
 * for the vault, on the same theory `os-credential-vault.test.ts` and
 * `cli-export-history.test.ts` already state: a mocked git or a mocked vault
 * proves nothing about whether the committed bytes are real, whether a
 * secret ever reaches them in the clear, or whether a restore genuinely
 * recovers what was encrypted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSecretHistoryRetentionDays,
  listSecretHistoryEntries,
  pruneSecretHistoryByRetention,
  recordSecretHistoryMutation,
  resetSecretHistoryQueueForTests,
  restoreSecretHistorySnapshot,
  setSecretHistoryRetentionDays,
} from "../src/lib/secret-history";
import {
  deleteVaultSecret, hasVaultSecret, setCredentialVaultSpawnForTests,
} from "../src/lib/os-credential-vault";
import { removeTempDir } from "./helpers/temp-dir";

// Real git, real DPAPI — see the module doc comment above. The vault and the
// git repository both take longer than bun's 5000ms default on a cold
// Windows runner (the same budget `cli-export-history.test.ts` already
// documents needing), so every test that touches either gets an explicit one.
const GIT_TEST_TIMEOUT_MS = 30_000;

let dir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-secrethist-"));
  // The vault (os-credential-vault.ts) resolves its own file through
  // getConfigDir(), which reads this env var — not the `configDir` parameter
  // every secret-history.ts function otherwise takes. Setting it to the same
  // temp directory keeps the git repo and the vault's ciphertext file
  // isolated together, exactly like os-credential-vault.test.ts does.
  process.env.OPENCODEX_HOME = dir;
  mkdirSync(dir, { recursive: true });
  resetSecretHistoryQueueForTests();
  setCredentialVaultSpawnForTests(null);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  setCredentialVaultSpawnForTests(null);
  resetSecretHistoryQueueForTests();
  if (dir) removeTempDir(dir);
});

function repoGitDir(): string {
  return join(dir, "secret-history", ".git");
}

describe("creation — a totp-entry mutation commits redacted metadata and an encrypted snapshot", () => {
  test("records a commit, never puts the secret in the plaintext redacted field or the raw file bytes", async () => {
    const result = await recordSecretHistoryMutation({
      kind: "totp-entry",
      action: "created",
      redacted: { entries: [{ id: "e1", issuer: "Example", account: "alice@example.com" }], groups: [] },
      sensitive: { entries: [{ id: "e1", secret: "JBSWY3DPEHPK3PXP" }], groups: [] },
    }, dir);

    expect(result.recorded).toBe(true);
    expect(typeof result.hash).toBe("string");
    expect(existsSync(repoGitDir())).toBe(true);

    // Local only, exactly like state-history.ts's own repo.
    const gitConfig = readFileSync(join(repoGitDir(), "config"), "utf8");
    expect(gitConfig).not.toContain("[remote");

    const entries = listSecretHistoryEntries(10, dir);
    expect(entries.length).toBe(1);
    expect(entries[0]!.kind).toBe("totp-entry");
    expect(entries[0]!.action).toBe("created");
    expect(entries[0]!.hasSensitiveSnapshot).toBe(true);

    // The raw committed file, read the same way a curious user with the
    // repository (but not the vault key) would: the secret must not appear
    // anywhere in it, in any form.
    const raw = readFileSync(join(dir, "secret-history", "entry.json"), "utf8");
    expect(raw).not.toContain("JBSWY3DPEHPK3PXP");
    const parsed = JSON.parse(raw);
    expect(parsed.redacted.entries[0].issuer).toBe("Example"); // redacted metadata IS in the clear
    expect(parsed.encrypted.ciphertext).toBeTruthy();
    expect(JSON.stringify(parsed.encrypted)).not.toContain("JBSWY3DPEHPK3PXP");
  }, GIT_TEST_TIMEOUT_MS);

  test("a display-name mutation needs no vault key and still commits", async () => {
    const result = await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed",
      redacted: { previous: "opencodex", next: "My Robot" },
      sensitive: null,
    }, dir);
    expect(result.recorded).toBe(true);
    const entries = listSecretHistoryEntries(10, dir);
    expect(entries[0]!.hasSensitiveSnapshot).toBe(false);
    expect(entries[0]!.redacted).toEqual({ previous: "opencodex", next: "My Robot" });
  }, GIT_TEST_TIMEOUT_MS);
});

describe("edit — an update mutation is its own commit, on top of the create", () => {
  test("two commits exist, newest first, and the redacted field reflects each state", async () => {
    await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1", issuer: "Example", account: "old@example.com" }] },
      sensitive: { entries: [{ id: "e1", secret: "AAAAAAAAAAAAAAAA" }] },
    }, dir);
    await recordSecretHistoryMutation({
      kind: "totp-entry", action: "updated",
      redacted: { entries: [{ id: "e1", issuer: "Example", account: "new@example.com" }] },
      sensitive: { entries: [{ id: "e1", secret: "AAAAAAAAAAAAAAAA" }] },
    }, dir);

    const entries = listSecretHistoryEntries(10, dir);
    expect(entries.length).toBe(2);
    expect(entries[0]!.action).toBe("updated"); // newest first
    expect((entries[0]!.redacted as any).entries[0].account).toBe("new@example.com");
    expect(entries[1]!.action).toBe("created");
    expect((entries[1]!.redacted as any).entries[0].account).toBe("old@example.com");
  }, GIT_TEST_TIMEOUT_MS);
});

describe("removal — a delete is recorded and the encrypted snapshot after it holds no removed secret", () => {
  test("removed entries do not survive into the next encrypted snapshot", async () => {
    await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1" }, { id: "e2" }] },
      sensitive: { entries: [{ id: "e1", secret: "AAAA" }, { id: "e2", secret: "BBBB" }] },
    }, dir);
    await recordSecretHistoryMutation({
      kind: "totp-entry", action: "removed",
      redacted: { entries: [{ id: "e1" }] },
      sensitive: { entries: [{ id: "e1", secret: "AAAA" }] },
    }, dir);

    const entries = listSecretHistoryEntries(10, dir);
    expect(entries[0]!.action).toBe("removed");
    const restored = await restoreSecretHistorySnapshot(entries[0]!.hash, dir);
    expect(restored.ok).toBe(true);
    expect((restored.sensitive as any).entries).toHaveLength(1);
    expect((restored.sensitive as any).entries[0].id).toBe("e1");
  }, GIT_TEST_TIMEOUT_MS);
});

describe("rename — display-name mutations round-trip through listing without a vault key", () => {
  test("reset is recorded distinctly from renamed", async () => {
    await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "opencodex", next: "Mum's Robot" }, sensitive: null,
    }, dir);
    await recordSecretHistoryMutation({
      kind: "display-name", action: "reset", redacted: { previous: "Mum's Robot", next: "opencodex" }, sensitive: null,
    }, dir);
    const entries = listSecretHistoryEntries(10, dir);
    expect(entries.map(e => e.action)).toEqual(["reset", "renamed"]);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("restore — decrypts a past totp-entry snapshot and a display-name value alike", () => {
  test("a restored totp-entry snapshot decrypts to exactly what was encrypted", async () => {
    const created = await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1", issuer: "Example" }] },
      sensitive: { entries: [{ id: "e1", issuer: "Example", secret: "JBSWY3DPEHPK3PXP" }], groups: [] },
    }, dir);
    expect(created.recorded).toBe(true);

    const restored = await restoreSecretHistorySnapshot(created.hash!, dir);
    expect(restored.ok).toBe(true);
    expect(restored.kind).toBe("totp-entry");
    expect((restored.sensitive as any).entries[0].secret).toBe("JBSWY3DPEHPK3PXP");
  }, GIT_TEST_TIMEOUT_MS);

  test("a display-name commit restores its redacted value with no decryption involved", async () => {
    const recorded = await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "opencodex", next: "Second Brain" }, sensitive: null,
    }, dir);
    const restored = await restoreSecretHistorySnapshot(recorded.hash!, dir);
    expect(restored.ok).toBe(true);
    expect(restored.kind).toBe("display-name");
    expect(restored.redacted).toEqual({ previous: "opencodex", next: "Second Brain" });
    expect(restored.sensitive).toBeUndefined();
  }, GIT_TEST_TIMEOUT_MS);

  test("an unknown hash fails closed with not-found, never a throw", async () => {
    await recordSecretHistoryMutation({ kind: "display-name", action: "renamed", redacted: {}, sensitive: null }, dir);
    const restored = await restoreSecretHistorySnapshot("0000000", dir);
    expect(restored.ok).toBe(false);
    expect(restored.reason).toBe("not-found");
  }, GIT_TEST_TIMEOUT_MS);

  test("an invalid hash shape is rejected before ever touching git", async () => {
    const restored = await restoreSecretHistorySnapshot("not a hash!", dir);
    expect(restored.ok).toBe(false);
    expect(restored.reason).toBe("invalid-commit");
  });

  test("restoring against a directory with no repository yet fails closed, not with a throw", async () => {
    const restored = await restoreSecretHistorySnapshot("abc1234", dir);
    expect(restored.ok).toBe(false);
    expect(restored.reason).toBe("not-found");
  });
});

describe("missing vault — a totp-entry mutation refuses to commit rather than write the secret unencrypted", () => {
  test("when the vault is unavailable, nothing is recorded and no entry.json is ever written", async () => {
    // Force every PowerShell/DPAPI call to fail, exactly the seam
    // os-credential-vault.test.ts's own suite is built around.
    setCredentialVaultSpawnForTests((() => {
      throw new Error("simulated: no PowerShell available");
    }) as unknown as typeof import("node:child_process").spawn);

    const result = await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1" }] },
      sensitive: { entries: [{ id: "e1", secret: "SHOULD-NEVER-BE-WRITTEN" }] },
    }, dir);

    expect(result.recorded).toBe(false);
    expect(result.reason).toBe("vault-unavailable");
    // Fail-safe means fail SILENT-TO-DISK too: no commit, no working-tree file
    // holding the secret in any form, encrypted-looking or not.
    expect(existsSync(join(dir, "secret-history", "entry.json"))).toBe(false);
    expect(listSecretHistoryEntries(10, dir)).toEqual([]);
  }, GIT_TEST_TIMEOUT_MS);

  test("a display-name mutation is unaffected — it never needed the vault", async () => {
    setCredentialVaultSpawnForTests((() => {
      throw new Error("simulated: no PowerShell available");
    }) as unknown as typeof import("node:child_process").spawn);

    const result = await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "opencodex", next: "x" }, sensitive: null,
    }, dir);
    expect(result.recorded).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  test("restoring a totp-entry snapshot with the vault unavailable fails closed, and the redacted metadata stays readable via listing", async () => {
    const created = await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1", issuer: "Example" }] },
      sensitive: { entries: [{ id: "e1", secret: "AAAAAAAAAAAAAAAA" }] },
    }, dir);
    expect(created.recorded).toBe(true);

    // The key really is gone, not merely a fresh temp dir with no key yet:
    // delete the stored vault entry so a subsequent read genuinely fails to
    // find it, then also force the transport closed for good measure.
    deleteVaultSecret("secret-history-encryption-key");
    setCredentialVaultSpawnForTests((() => {
      throw new Error("simulated: vault offline");
    }) as unknown as typeof import("node:child_process").spawn);

    const restored = await restoreSecretHistorySnapshot(created.hash!, dir);
    expect(restored.ok).toBe(false);
    expect(restored.reason).toBe("vault-unavailable");

    // The redacted metadata — no secret in it — is still visible without the vault.
    setCredentialVaultSpawnForTests(null);
    const entries = listSecretHistoryEntries(10, dir);
    expect(entries[0]!.redacted).toEqual({ entries: [{ id: "e1", issuer: "Example" }] });
  }, GIT_TEST_TIMEOUT_MS);
});

describe("interrupted commit — a locked git index fails closed rather than corrupting or hanging", () => {
  test("a commit blocked by an index.lock reports commit-failed, and a later attempt (after the lock clears) succeeds", async () => {
    const first = await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "opencodex", next: "one" }, sensitive: null,
    }, dir);
    expect(first.recorded).toBe(true);

    // Simulates a process that was killed mid-commit, or a second writer that
    // never released its lock — a real, reproducible git failure mode rather
    // than a mocked one.
    const lockPath = join(repoGitDir(), "index.lock");
    writeFileSync(lockPath, "", "utf8");

    const second = await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "one", next: "two" }, sensitive: null,
    }, dir);
    expect(second.recorded).toBe(false);
    expect(second.reason).toBe("commit-failed");
    // The interruption did not corrupt the repository — the earlier commit is still there.
    expect(listSecretHistoryEntries(10, dir).length).toBe(1);

    require("node:fs").unlinkSync(lockPath);
    const third = await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "one", next: "three" }, sensitive: null,
    }, dir);
    expect(third.recorded).toBe(true);
    expect(listSecretHistoryEntries(10, dir).length).toBe(2);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("restart recovery — everything needed to browse and restore lives on disk, not in module state", () => {
  test("after the write queue is dropped (simulating a fresh process), listing and restoring still work from the directory alone", async () => {
    const created = await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1", issuer: "Example" }] },
      sensitive: { entries: [{ id: "e1", secret: "RESTART-ME" }] },
    }, dir);
    expect(created.recorded).toBe(true);

    // "Restart" — drop whatever in-process queue state existed. Every function
    // below is called fresh, addressed only by the directory path, exactly as
    // a newly launched proxy process would call them.
    resetSecretHistoryQueueForTests();

    const entries = listSecretHistoryEntries(10, dir);
    expect(entries.length).toBe(1);
    // Not the hash the write call returned — re-derived purely from what
    // `listSecretHistoryEntries` found on disk, so this genuinely exercises
    // "only the directory to go on" rather than reusing in-memory state.
    const rediscoveredHash = entries[0]!.hash;
    const restored = await restoreSecretHistorySnapshot(rediscoveredHash, dir);
    expect(restored.ok).toBe(true);
    expect((restored.sensitive as any).entries[0].secret).toBe("RESTART-ME");
  }, GIT_TEST_TIMEOUT_MS);

  test("a retention policy set before the simulated restart is still honoured after it", async () => {
    for (let i = 0; i < 3; i++) {
      await recordSecretHistoryMutation({
        kind: "display-name", action: "renamed", redacted: { previous: String(i), next: String(i + 1) }, sensitive: null,
      }, dir);
    }
    await setSecretHistoryRetentionDays(365, dir);
    resetSecretHistoryQueueForTests();
    expect(getSecretHistoryRetentionDays(dir)).toBe(365);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("a missing directory / no history yet", () => {
  test("listing returns an empty array rather than throwing", () => {
    expect(listSecretHistoryEntries(10, join(dir, "does-not-exist"))).toEqual([]);
  });

  test("getSecretHistoryRetentionDays defaults to null (keep forever) before any policy is set", () => {
    expect(getSecretHistoryRetentionDays(dir)).toBeNull();
  });
});

describe("retention — pruning discards only what the policy says to, and keeps at least one entry", () => {
  test("an old entry is pruned, a recent one and the vault key it needs both survive", async () => {
    const old = await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "old" }] },
      sensitive: { entries: [{ id: "old", secret: "OLD-SECRET" }] },
    }, dir);
    expect(old.recorded).toBe(true);
    // Back-date the "old" commit far outside a 1-day retention window by
    // rewriting the redacted `at` field is not enough — pruning reads `at`
    // from the committed record itself, so rewrite the record before the
    // next commit lands, then commit fresh "recent" data on top of it.
    const path = join(dir, "secret-history", "entry.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.at = new Date(Date.now() - 10 * 86_400_000).toISOString();
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    // The rewritten file must be staged before `--amend` picks it up — amending
    // with nothing staged only changes the message/dates and keeps the OLD tree,
    // which would leave the committed `entry.json`'s own `at` field unchanged.
    spawnSync("git", ["-C", join(dir, "secret-history"), "add", "--", "entry.json"]);
    spawnSync("git", ["-C", join(dir, "secret-history"), "commit", "--amend", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "totp-entry: created (backdated for test)"], {
      env: { ...process.env, GIT_AUTHOR_DATE: record.at, GIT_COMMITTER_DATE: record.at },
    });

    const recent = await recordSecretHistoryMutation({
      kind: "totp-entry", action: "updated",
      redacted: { entries: [{ id: "recent" }] },
      sensitive: { entries: [{ id: "recent", secret: "RECENT-SECRET" }] },
    }, dir);
    expect(recent.recorded).toBe(true);

    expect(listSecretHistoryEntries(10, dir).length).toBe(2);

    const result = await setSecretHistoryRetentionDays(1, dir);
    expect(result.ok).toBe(true);
    expect(result.prunedCount).toBe(1);

    const after = listSecretHistoryEntries(10, dir);
    // The retention-policy change itself is recorded as one more commit, on
    // top of whatever survived pruning.
    expect(after.some(e => e.action === "retention-changed")).toBe(true);
    expect(after.some(e => (e.redacted as any).entries?.[0]?.id === "recent")).toBe(true);
    expect(after.some(e => (e.redacted as any).entries?.[0]?.id === "old")).toBe(false);

    // The surviving snapshot is still genuinely restorable — pruning rewrote
    // the repository, not the encrypted payload inside the kept commit.
    const recentEntry = after.find(e => (e.redacted as any).entries?.[0]?.id === "recent")!;
    const restored = await restoreSecretHistorySnapshot(recentEntry.hash, dir);
    expect(restored.ok).toBe(true);
    expect((restored.sensitive as any).entries[0].secret).toBe("RECENT-SECRET");
  }, GIT_TEST_TIMEOUT_MS);

  /** Backdates whatever `entry.json` currently holds, in place, on the current HEAD commit. */
  function backdateHead(daysAgo: number): string {
    const path = join(dir, "secret-history", "entry.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    spawnSync("git", ["-C", join(dir, "secret-history"), "add", "--", "entry.json"]);
    spawnSync("git", ["-C", join(dir, "secret-history"), "commit", "--amend", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "backdated for test"], {
      env: { ...process.env, GIT_AUTHOR_DATE: record.at, GIT_COMMITTER_DATE: record.at },
    });
    return record.at as string;
  }

  test("retention never prunes everything to zero — at least the newest entry always survives", async () => {
    await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "only" }] },
      sensitive: { entries: [{ id: "only", secret: "ONLY-SECRET" }] },
    }, dir);
    backdateHead(999);

    // Setting the policy adds its own fresh "retention-changed" commit, so
    // pruning here removes the now-999-day-old "created" commit in favour of
    // that fresh one — no fallback needed yet, exactly one commit remains.
    const setup = await setSecretHistoryRetentionDays(1, dir);
    expect(setup.ok).toBe(true);
    expect(setup.prunedCount).toBe(1);
    const afterSetup = listSecretHistoryEntries(10, dir);
    expect(afterSetup.length).toBe(1);
    expect(afterSetup[0]!.action).toBe("retention-changed");

    // Now backdate that sole survivor too, so the WHOLE repository is old,
    // and prune again with `pruneSecretHistoryByRetention` — which records
    // no commit of its own. This is what actually exercises "every candidate
    // is outside the window", the one case the fallback exists for.
    const backdated = backdateHead(999);
    expect(listSecretHistoryEntries(10, dir)[0]!.at).toBe(backdated);

    const result = await pruneSecretHistoryByRetention(dir);
    expect(result.ok).toBe(true);
    expect(result.prunedCount).toBe(0); // the fallback kept it rather than pruning the last entry
    expect(listSecretHistoryEntries(10, dir).length).toBe(1);
  }, GIT_TEST_TIMEOUT_MS);

  test("null retention (keep forever) prunes nothing", async () => {
    await recordSecretHistoryMutation({
      kind: "display-name", action: "renamed", redacted: { previous: "a", next: "b" }, sensitive: null,
    }, dir);
    const result = await pruneSecretHistoryByRetention(dir);
    expect(result.ok).toBe(true);
    expect(result.prunedCount).toBe(0);
    expect(listSecretHistoryEntries(10, dir).length).toBe(1);
  }, GIT_TEST_TIMEOUT_MS);

  test("rejects a non-positive or fractional retention value without touching the repository", async () => {
    for (const bad of [0, -1, 1.5]) {
      const result = await setSecretHistoryRetentionDays(bad, dir);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid-retention");
    }
    expect(getSecretHistoryRetentionDays(dir)).toBeNull();
  });
});

describe("isolation from state-history.ts's plaintext repository", () => {
  test("secret-history lives in its own subdirectory with its own .git, never inside the config dir's own repo", async () => {
    await recordSecretHistoryMutation({
      kind: "totp-entry", action: "created",
      redacted: { entries: [{ id: "e1" }] },
      sensitive: { entries: [{ id: "e1", secret: "AAAA" }] },
    }, dir);
    expect(existsSync(join(dir, "secret-history", ".git"))).toBe(true);
    // The config dir's OWN top-level .git (state-history.ts's repository) is a
    // completely separate thing this test never creates or touches.
    expect(existsSync(join(dir, ".git"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  test("the vault key ref never collides with any tokenRef state-history.ts or scheduling would plausibly use", () => {
    // hasVaultSecret only throws on a malformed ref — this constant must
    // always be a valid one, or every recordSecretHistoryMutation call for a
    // sensitive payload would throw instead of failing closed.
    expect(() => hasVaultSecret("secret-history-encryption-key")).not.toThrow();
  });
});
