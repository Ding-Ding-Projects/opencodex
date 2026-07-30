import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExportCommand } from "../src/cli/export";
import { listStateHistory, recordStateSnapshot } from "../src/lib/state-history";

/**
 * `ocx export` is a credential dump on purpose, so its guards are the feature:
 * no write without --yes, an unmissable warning on stderr even when piping, and
 * a bundle that carries everything restore needs (masking would break restore).
 *
 * The state history is best-effort by contract — a machine without git must
 * behave exactly as if the feature did not exist.
 */

describe("state history", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-hist-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
  });

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
  });

  test("an unchanged tree does not stack empty commits", async () => {
    writeFileSync(join(dir, "config.json"), "{}\n");
    if (!(await recordStateSnapshot("first", dir))) return;
    expect(await recordStateSnapshot("second, nothing changed", dir)).toBe(false);
    expect(listStateHistory(5, dir).length).toBe(1);
  });

  test("a newline-bearing reason cannot break the commit message", async () => {
    writeFileSync(join(dir, "config.json"), "{}\n");
    if (!(await recordStateSnapshot("line one\nline two", dir))) return;
    expect(listStateHistory(5, dir)[0]).toContain("line one line two");
  });

  test("a missing directory is a no-op, never a throw", async () => {
    expect(await recordStateSnapshot("x", join(dir, "does-not-exist"))).toBe(false);
  });
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
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
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

  test("stdout mode keeps the payload clean and the warning on stderr", async () => {
    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await handleExportCommand(["-", "--yes"])).toBe(0);
    } finally {
      process.stdout.write = realWrite;
    }
    // stdout parses as the bundle alone; the warning went to stderr.
    const bundle = JSON.parse(chunks.join(""));
    expect(bundle.kind).toBe("opencodex-export");
    expect(errored.join("\n")).toContain("THIS EXPORT CONTAINS SECRETS");
  });
});
