import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runServiceAcceptance,
  SERVICE_CLASS_PROFILES,
} from "../scripts/disposable-host/codex-service-composed-acceptance";

// The repository root this file lives under, used only by the cleanliness check below.
const REPO_ROOT = join(import.meta.dir, "..");
const SCRATCH_PREFIX = "ocx-service-acceptance-";

// `TEMP` is a Windows-only environment variable. The previous
// `mkdtempSync(join(process.env.TEMP ?? ".", SCRATCH_PREFIX))` fell back to "." (the
// repository root, since Bun resolves relative paths against the process cwd) on Linux
// and macOS, which both littered the repo root with scratch directories this file never
// cleaned up, and produced a *relative* hostRoot — tripping runServiceAcceptance's own
// "OCX_DISPOSABLE_HOST_ROOT must be an absolute disposable-host path" guard. `tmpdir()` is
// always absolute, so using it fixes both: no litter, and a hostRoot the guard accepts.
const scratchRoots: string[] = [];

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  scratchRoots.push(root);
  return root;
}

afterAll(() => {
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop()!, { recursive: true, force: true });
  }
});

describe("disposable-host service acceptance contract", () => {
  test("enumerates exactly the deferred WP13 service classes", () => {
    expect(SERVICE_CLASS_PROFILES).toEqual(["P09", "P10", "P18", "P34", "P35", "P36"]);
  });

  test("refuses to run on an ordinary workstation and emits no artifacts", async () => {
    const result = await runServiceAcceptance({
      profile: "P09",
      hostRoot: undefined,
      disposableHost: undefined,
    });
    expect(result.status).toBe("refused");
    expect(result.phases).toEqual([]);
  });

  test("runs the owned install/start/probe/restart/probe/stop/uninstall lifecycle", async () => {
    const root = scratchRoot();
    writeFileSync(join(root, "disposable-host-attestation.json"), JSON.stringify({ hostId: "test-host", nonce: "one-use", owner: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const calls: string[] = [];
    let pid = 700;
    const adapter = {
      install: () => { calls.push("install"); },
      start: () => { calls.push("start"); },
      probe: () => { calls.push("probe"); return { service: "opencodex" as const, status: "ok" as const, pid: pid++, port: 10100, hostname: "127.0.0.1", coordinator: "ready" as const, sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40) }; },
      restart: () => { calls.push("restart"); },
      stop: () => { calls.push("stop"); },
      uninstall: () => { calls.push("uninstall"); },
      verifyGone: () => { calls.push("verify-gone"); },
    };
    const result = await runServiceAcceptance({ profile: "P09", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter });
    expect(result.status).toBe("verified");
    expect(calls).toEqual(["install", "start", "probe", "restart", "probe", "stop", "uninstall", "verify-gone"]);
  });

  test("rejects stale attestation before invoking a service operation", async () => {
    const root = scratchRoot();
    writeFileSync(join(root, "disposable-host-attestation.json"), JSON.stringify({ hostId: "test-host", nonce: "stale", owner: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`, expiresAt: new Date(Date.now() - 1).toISOString() }));
    let called = false;
    await expect(runServiceAcceptance({ profile: "P10", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter: { install: () => { called = true; }, start: () => {}, probe: () => { throw new Error("should not probe"); }, restart: () => {}, stop: () => {}, uninstall: () => {}, verifyGone: () => {} } })).rejects.toThrow(/stale/);
    expect(called).toBe(false);
  });

  test("consumes a valid attestation nonce before lifecycle work", async () => {
    const root = scratchRoot();
    writeFileSync(join(root, "disposable-host-attestation.json"), JSON.stringify({ hostId: "test-host", nonce: "one-use", owner: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    let pid = 1;
    const adapter = { install: () => {}, start: () => {}, probe: () => ({ service: "opencodex" as const, status: "ok" as const, pid: pid++, port: 1, hostname: "127.0.0.1", coordinator: "ready" as const, sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40) }), restart: () => {}, stop: () => {}, uninstall: () => {}, verifyGone: () => {} };
    const first = await runServiceAcceptance({ profile: "P09", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter });
    expect(first.status).toBe("verified");
    await expect(runServiceAcceptance({ profile: "P09", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter })).rejects.toThrow(/attestation/);
  });

  // Regression for the TEMP-fallback bug: every scratch root above must land under the OS
  // temp directory, never under the repository root, and this file must leave none behind
  // even though the tests above never delete a root themselves (afterAll does that). This
  // runs last in file-declaration order, after every scratchRoot() call above has executed.
  test("leaves no scratch directory behind in the repository root", () => {
    const leaked = readdirSync(REPO_ROOT).filter(name => name.startsWith(SCRATCH_PREFIX));
    expect(leaked).toEqual([]);
    expect(scratchRoots.length).toBeGreaterThan(0);
    for (const root of scratchRoots) {
      expect(root.startsWith(REPO_ROOT)).toBe(false);
    }
  });
});
