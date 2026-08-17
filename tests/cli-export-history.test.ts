import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExportCommand } from "../src/cli/export";
import { listStateHistory, recordStateSnapshot, recordStateSnapshotBeforeDelete } from "../src/lib/state-history";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * `ocx export` is a credential dump on purpose, so its guards are the feature:
 * no write without --yes, an unmissable warning on stderr even when piping, and
 * a bundle that carries everything restore needs (masking would break restore).
 *
 * The state history is best-effort by contract — a machine without git must
 * behave exactly as if the feature did not exist.
 */

describe("state history", () => {
  /**
   * These tests shell out to `git` several times each — init, add, commit, log
   * — and the first also creates the repository. On a cold Windows CI runner
   * that genuinely takes seconds: the siblings here were already clocking 4.3s
   * against bun's 5000ms default, and the init case finally crossed it.
   *
   * The budget is the honest fix rather than mocking git away: what is being
   * tested IS that a real repository is created and really commits, and a test
   * that stubs the subprocess would stop checking the thing that matters.
   */
  const GIT_TEST_TIMEOUT_MS = 30_000;

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-hist-"));
  });
  afterEach(() => {
    removeTempDir(dir);
  });

  test("first snapshot initialises a local-only repo and commits the state files", async () => {
    writeFileSync(join(dir, "config.json"), '{"port":10100}\n');
    writeFileSync(join(dir, "codex-accounts.json"), "{}\n");
    const committed = await recordStateSnapshot("account added: test", dir);
    // On a machine without git this legitimately returns false; everything
    // below only applies when git exists (CI runners always have it).
    if (!committed) return;
    expect(existsSync(join(dir, ".git"))).toBe(true);
    // Local only: no remote may ever be configured by us.
    const gitConfig = readFileSync(join(dir, ".git", "config"), "utf8");
    expect(gitConfig).not.toContain("[remote");
    // The README warns about secrets in history.
    expect(readFileSync(join(dir, "README-HISTORY.md"), "utf8")).toContain("SECRETS");
    const log = listStateHistory(5, dir);
    expect(log.length).toBe(1);
    expect(log[0]).toContain("account added: test");
  }, GIT_TEST_TIMEOUT_MS);

  test("runtime noise is ignored — only durable state is ever tracked", async () => {
    writeFileSync(join(dir, "config.json"), "{}\n");
    writeFileSync(join(dir, "ocx.pid"), "1234\n");
    writeFileSync(join(dir, "tray-heartbeat.json"), "{}\n");
    if (!(await recordStateSnapshot("state change", dir))) return;
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    // Everything is ignored by default; only the durable files are re-included.
    expect(ignore.startsWith("# opencodex state history")).toBe(true);
    expect(ignore).toContain("\n*\n");
    expect(ignore).toContain("!config.json");
    expect(ignore).toContain("!codex-accounts.json");
    expect(ignore).not.toContain("!ocx.pid");
  }, GIT_TEST_TIMEOUT_MS);

  test("an unchanged tree does not stack empty commits", async () => {
    writeFileSync(join(dir, "config.json"), "{}\n");
    if (!(await recordStateSnapshot("first", dir))) return;
    expect(await recordStateSnapshot("second, nothing changed", dir)).toBe(false);
    expect(listStateHistory(5, dir).length).toBe(1);
  }, GIT_TEST_TIMEOUT_MS);

  test("a newline-bearing reason cannot break the commit message", async () => {
    writeFileSync(join(dir, "config.json"), "{}\n");
    if (!(await recordStateSnapshot("line one\nline two", dir))) return;
    expect(listStateHistory(5, dir)[0]).toContain("line one line two");
  }, GIT_TEST_TIMEOUT_MS);

  test("a missing directory is a no-op, never a throw", async () => {
    expect(await recordStateSnapshot("x", join(dir, "does-not-exist"))).toBe(false);
  });

  /**
   * The undo guarantee. A post-change snapshot alone records only the state with
   * the account already gone, so recovery would depend on some earlier commit
   * happening to contain it — untrue for an account that predates this history,
   * which is exactly the account a user is most likely to delete by mistake.
   * The "before" commit is what makes the credential recoverable.
   */
  test("a deleted account is recoverable from the commit taken before the deletion", async () => {
    // State that predates the history entirely: no snapshot has ever run.
    writeFileSync(join(dir, "config.json"), '{"port":10100}\n');
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      xai: { activeAccountId: "a1", accounts: [{ id: "a1", credential: { refreshToken: "keep-me-rt" } }] },
    }) + "\n");

    const before = await recordStateSnapshotBeforeDelete("before account removal: xai/a1", dir);
    if (!before) return; // no git on this machine — feature is a documented no-op
    // The deletion itself, then its own "after" snapshot.
    writeFileSync(join(dir, "auth.json"), "{}\n");
    expect(await recordStateSnapshot("account removed: xai/a1", dir)).toBe(true);

    const log = listStateHistory(5, dir);
    expect(log.length).toBe(2);
    expect(log[0]).toContain("account removed: xai/a1");
    expect(log[1]).toContain("before account removal: xai/a1");

    // The actual recovery a user would perform, and the credential is really there.
    const recovered = spawnSync("git", ["-C", dir, "show", "HEAD~1:auth.json"], { encoding: "utf8" });
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout).xai.accounts[0].credential.refreshToken).toBe("keep-me-rt");
    // And the deletion did land — the history is not masking the current state.
    const current = spawnSync("git", ["-C", dir, "show", "HEAD:auth.json"], { encoding: "utf8" });
    expect(JSON.parse(current.stdout)).toEqual({});
  }, GIT_TEST_TIMEOUT_MS);

  test("a deletion is never blocked by history: an exhausted budget still returns", async () => {
    writeFileSync(join(dir, "config.json"), "{}\n");
    // A zero budget cannot outrun even a local commit, so this exercises the
    // give-up path. It must resolve false rather than throw or hang — the
    // caller's deletion has to proceed either way.
    expect(await recordStateSnapshotBeforeDelete("before x", dir, 0)).toBe(false);
    // ...and the snapshot it started still serializes, so the index is not left racing.
    await recordStateSnapshot("after x", dir);
    expect(listStateHistory(5, dir).length).toBeGreaterThanOrEqual(1);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("ocx export", () => {
  let home: string;
  let out: string;
  let logged: string[];
  let errored: string[];
  const realLog = console.log;
  const realError = console.error;
  const realHome = process.env.OPENCODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-export-home-"));
    out = mkdtempSync(join(tmpdir(), "ocx-export-out-"));
    process.env.OPENCODEX_HOME = home;
    writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({
      acc1: { generation: 1, credential: { accessToken: "at", refreshToken: "rt", expiresAt: 1, chatgptAccountId: "c1" } },
    }));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "main-at" } }));
    logged = [];
    errored = [];
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { errored.push(args.join(" ")); };
  });

  afterEach(() => {
    console.log = realLog;
    console.error = realError;
    if (realHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = realHome;
    removeTempDir(home);
    removeTempDir(out);
  });

  test("refuses to write without --yes and names what is at stake", async () => {
    const target = join(out, "backup.json");
    expect(await handleExportCommand([target])).toBe(2);
    expect(errored.join("\n")).toContain("SECRETS");
    expect(existsSync(target)).toBe(false);
  });

  test("exports the full bundle with the warning on stderr, unmasked", async () => {
    const target = join(out, "backup.json");
    expect(await handleExportCommand([target, "--yes"])).toBe(0);
    expect(errored.join("\n")).toContain("THIS EXPORT CONTAINS SECRETS");

    const bundle = JSON.parse(readFileSync(target, "utf8"));
    expect(bundle.kind).toBe("opencodex-export");
    expect(bundle.warning).toContain("PLAINTEXT SECRETS");
    // Unmasked by design: a masked backup cannot be restored.
    expect(bundle.codexAccounts.acc1.credential.refreshToken).toBe("rt");
    expect(bundle.auth.tokens.access_token).toBe("main-at");
    expect(bundle.config).toBeTruthy();
  });

  test("stdout mode refuses to print a plaintext-secret backup", async () => {
    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await handleExportCommand(["-", "--yes"])).toBe(2);
    } finally {
      process.stdout.write = realWrite;
    }
    expect(chunks).toEqual([]);
    expect(errored.join("\n")).toContain("THIS EXPORT CONTAINS SECRETS");
    expect(errored.join("\n")).toContain("cannot be written to stdout");
  });
});
