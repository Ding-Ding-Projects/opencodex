import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProxyStartLock, ProxyStartLockTimeoutError } from "../src/lib/proxy-start-lock";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("proxy startup lock", () => {
  test("serializes two real processes so the second cannot pass the startup gate early", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-start-lock-"));
    dirs.push(home);
    const events = join(home, "events.txt");
    const helper = join(import.meta.dir, "helpers", "proxy-start-lock-child.ts");
    const first = Bun.spawn([process.execPath, helper, home, events, "first", "300"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODEX_HOME: home },
    });

    const deadline = Date.now() + 5_000;
    while ((!existsSync(events) || !readFileSync(events, "utf8").includes("first:acquired")) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(existsSync(events)).toBe(true);
    const second = Bun.spawn([process.execPath, helper, home, events, "second", "0"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODEX_HOME: home },
    });

    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    const rows = readFileSync(events, "utf8").trim().split(/\r?\n/);
    const timestamp = (prefix: string) => Number(rows.find(row => row.startsWith(prefix))?.split(":")[2]);
    expect(timestamp("second:acquired")).toBeGreaterThanOrEqual(timestamp("first:released"));
  });

  test("reclaims a stale partial owner record using strict filename PID evidence", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-start-lock-partial-"));
    dirs.push(home);
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const lockDir = join(home, "proxy-start.lock");
    const owner = join(lockDir, "999999-1-00000000-0000-4000-8000-000000000001.json");
    mkdirSync(lockDir);
    closeSync(openSync(owner, "wx"));

    try {
      const lock = await acquireProxyStartLock({
        timeoutMs: 100,
        intervalMs: 1,
        staleMs: 100,
        now: () => Date.now() + 1_000,
        isAlive: pid => {
          expect(pid).toBe(999999);
          return false;
        },
      });
      expect(existsSync(owner)).toBe(false);
      lock.release();
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test("does not reclaim a live or changed partial owner record", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-start-lock-guard-"));
    dirs.push(home);
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const lockDir = join(home, "proxy-start.lock");
    const owner = join(lockDir, "999998-1-00000000-0000-4000-8000-000000000002.json");
    mkdirSync(lockDir);
    closeSync(openSync(owner, "wx"));

    try {
      await expect(acquireProxyStartLock({
        timeoutMs: 0,
        staleMs: 0,
        now: () => Date.now() + 1_000,
        isAlive: () => true,
      })).rejects.toBeInstanceOf(ProxyStartLockTimeoutError);
      expect(existsSync(owner)).toBe(true);

      await expect(acquireProxyStartLock({
        timeoutMs: 0,
        staleMs: 0,
        now: () => Date.now() + 1_000,
        isAlive: () => {
          writeFileSync(owner, "changed-during-revalidation", "utf8");
          return false;
        },
      })).rejects.toBeInstanceOf(ProxyStartLockTimeoutError);
      expect(readFileSync(owner, "utf8")).toBe("changed-during-revalidation");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });
});
