import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  runServiceAcceptance,
  SERVICE_CLASS_PROFILES,
} from "../scripts/disposable-host/codex-service-composed-acceptance";

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
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "ocx-service-acceptance-"));
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
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "ocx-service-acceptance-"));
    writeFileSync(join(root, "disposable-host-attestation.json"), JSON.stringify({ hostId: "test-host", nonce: "stale", owner: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`, expiresAt: new Date(Date.now() - 1).toISOString() }));
    let called = false;
    await expect(runServiceAcceptance({ profile: "P10", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter: { install: () => { called = true; }, start: () => {}, probe: () => { throw new Error("should not probe"); }, restart: () => {}, stop: () => {}, uninstall: () => {}, verifyGone: () => {} } })).rejects.toThrow(/stale/);
    expect(called).toBe(false);
  });

  test("consumes a valid attestation nonce before lifecycle work", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "ocx-service-acceptance-"));
    writeFileSync(join(root, "disposable-host-attestation.json"), JSON.stringify({ hostId: "test-host", nonce: "one-use", owner: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    let pid = 1;
    const adapter = { install: () => {}, start: () => {}, probe: () => ({ service: "opencodex" as const, status: "ok" as const, pid: pid++, port: 1, hostname: "127.0.0.1", coordinator: "ready" as const, sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40) }), restart: () => {}, stop: () => {}, uninstall: () => {}, verifyGone: () => {} };
    const first = await runServiceAcceptance({ profile: "P09", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter });
    expect(first.status).toBe("verified");
    await expect(runServiceAcceptance({ profile: "P09", hostRoot: root, disposableHost: "1", sourceCommit: "a".repeat(40), buildCommit: "b".repeat(40), adapter })).rejects.toThrow(/attestation/);
  });
});
