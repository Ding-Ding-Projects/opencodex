import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isServiceOwnershipError, ServiceOwnershipError } from "../src/service";

const CLI_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
const SERVICE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "service.ts"), "utf8");
const MANAGEMENT_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "server", "management-api.ts"), "utf8");
const PROCESS_CONTROL_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "lib", "process-control.ts"), "utf8");

function sliceFn(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

// `src/cli/index.ts` runs its command switch on import, so the handlers cannot be called from a
// test. Wiring assertions therefore read the source — the house pattern established by
// tests/stale-state-purge.test.ts and tests/uninstall.test.ts.
describe("Grok fence lifecycle wiring", () => {
  test("handleStart syncs the Grok fence outside the Desktop-3P try", () => {
    const startFn = sliceFn(CLI_SOURCE, "async function handleStart(", "async function handleEnsure(");
    const registryAt = startFn.indexOf("buildDesktop3pRegistry(");
    const registryCatchAt = startFn.indexOf("/* best-effort — registry rebuilds on first /v1/models call */", registryAt);
    const grokSyncAt = startFn.indexOf('await import("../grok/sync")');

    expect(registryCatchAt).toBeGreaterThan(registryAt);
    // Nested inside the registry try, a catalog throw skipped the fence entirely.
    expect(grokSyncAt).toBeGreaterThan(registryCatchAt);
  });

  test("ensure uses a soft direct start and syncs the observed/configured host on each branch", () => {
    const ensureFn = sliceFn(CLI_SOURCE, "async function handleEnsure(", "async function handleTrayProxyStart(");
    const spawnAt = ensureFn.indexOf("const child = spawn");
    const liveBranch = ensureFn.slice(0, spawnAt);
    const spawnBranch = ensureFn.slice(spawnAt);

    // live.hostname is what the proxy ACTUALLY bound; config.hostname may have drifted.
    expect(liveBranch).toContain("live.hostname ? { hostname: live.hostname }");
    expect(spawnBranch).toContain("config.hostname ? { hostname: config.hostname }");
    expect(spawnBranch).toContain("proxyStartArgv(process.argv[1])");
    expect(spawnBranch).toContain("env: directProxyEnv()");
    expect(spawnBranch).not.toContain('"--port"');
  });

  test("handleStop gates proxy/config teardown behind verified manager and proxy stops", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    const managerAt = stopFn.indexOf("stopManager:");
    const proxyAt = stopFn.indexOf("stopProxy:");
    const teardownAt = stopFn.indexOf("teardown:");
    expect(stopFn).toContain("await runStopSequence({");
    expect(managerAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeGreaterThan(managerAt);
    expect(teardownAt).toBeGreaterThan(proxyAt);
    expect(stopFn).toContain("if (!outcome.safeToRestart) reportUnsafeStop(outcome)");
  });

  test("a refused Grok strip makes ocx stop fail instead of reporting success", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    expect(stopFn).toContain("else if (!g.ok)");
    expect(stopFn).toContain("clean = false");
  });

  test("a refused proxy stop reports WHY, not just that it failed", () => {
    const proxyFn = sliceFn(CLI_SOURCE, "async function stopTrackedProxyForCli(", "function reportUnsafeStop(");
    const reportFn = sliceFn(CLI_SOURCE, "function reportUnsafeStop(", "async function handleStop(");
    // Stop errors escape to runStopSequence, which blocks teardown and preserves the detail.
    expect(proxyFn).toContain("await stopProxy(pid, {");
    expect(proxyFn).not.toContain("catch {");
    expect(reportFn).toContain("outcome.error instanceof Error ? outcome.error.message");
    expect(reportFn).toContain("Proxy stop is not verified: ${detail}");
  });

  test("handleStop returns its outcome so restart and the tray can react", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    // process.exit() inside handleStop would strand runTrayProxyRestart's start() half.
    expect(stopFn).toContain("process.exitCode = 1");
    expect(stopFn).toContain("return outcome");
    expect(stopFn).not.toContain("process.exit(1)");

    const restartCase = sliceFn(CLI_SOURCE, 'case "restart"', 'case "health"');
    expect(restartCase).toContain("await handleTrayProxyRestart()");
    expect(restartCase).not.toContain("handleEnsure()");
  });

  test("handleStop treats an incomplete native Codex restore as a stop failure", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    expect(stopFn).toContain("if (r.success) console.log");
    expect(stopFn).toContain("clean = false");
    expect(stopFn).toContain("console.error(`⚠️  ${r.message}`)");
  });

  test("the daemon's exit cleanup keeps the OCX_SERVICE exclusion and adds the ownership check", () => {
    const startFn = sliceFn(CLI_SOURCE, "const syncCleanup = () => {", "let shuttingDown = false;");
    // Crash/respawn under a service manager must still keep the fence.
    expect(startFn).toContain("!process.env.OCX_SERVICE && serviceEnvironmentOwnedHere()");
  });

  test("signal shutdown reports and exits nonzero when native Codex restore is incomplete", () => {
    const startFn = sliceFn(CLI_SOURCE, "async function handleStart(", "async function handleStop(");
    expect(startFn).toContain("if (!restored.success)");
    expect(startFn).toContain("cleanupSucceeded = false");
    expect(startFn).toContain("Native Codex restore failed during shutdown");
    expect(startFn).toContain("process.exit(restored ? 0 : 1)");
  });
});

describe("service teardown owns both managed configs", () => {
  test("service stop strips the Grok fence and guards the platform stop on installation", () => {
    const stopCase = sliceFn(SERVICE_SOURCE, 'case "stop":', 'case "status":');
    expect(stopCase).toContain("assertServiceEnvironmentMatchesInstall()");
    expect(stopCase).toContain("stopServiceCommandSafely()");
    expect(stopCase).toContain("return false");
    expect(stopCase).toContain("stripGrokConfig()");
    expect(stopCase).toContain("revertSystemEnv()");
  });

  test("service uninstall strips the Grok fence too", () => {
    const uninstallCase = sliceFn(SERVICE_SOURCE, 'case "uninstall":', "    default:");
    expect(uninstallCase).toContain("stripGrokConfig()");
    expect(uninstallCase).toContain("removeServiceInstallState()");
  });
});

describe("ownership errors are distinguishable", () => {
  test("ownership mismatch is its own error type, plain failures are not", () => {
    expect(isServiceOwnershipError(new ServiceOwnershipError("mismatch"))).toBe(true);
    // Misclassifying an ordinary stop failure would block teardown that is safe to run.
    expect(isServiceOwnershipError(new Error("launchctl exited 1"))).toBe(false);
    expect(isServiceOwnershipError("not an error")).toBe(false);
  });

  test("the guard still throws the documented message", () => {
    expect(new ServiceOwnershipError("Service was installed with CODEX_HOME=/a").message)
      .toContain("Service was installed with CODEX_HOME");
  });
});

describe("POST /api/stop teardown", () => {
  test("refuses with 409 on ownership mismatch instead of throwing a 500", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");

    expect(handler).toContain("isServiceOwnershipError(err)");
    expect(handler).toContain("}, 409, req, config)");
    // The refusal must return BEFORE the shutdown is scheduled: a refused stop keeps running.
    const refusalAt = handler.indexOf("409");
    const shutdownAt = handler.indexOf("drainAndShutdown");
    expect(refusalAt).toBeLessThan(shutdownAt);
  });

  test("strips the Grok fence on an accepted stop", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    expect(handler).toContain('await import("../grok/inject")');
    expect(handler).toContain("stripGrokConfig()");
  });

  test("a 409 does not escalate to a forced kill", () => {
    // Escalating would run the daemon's cleanup and strip shared config while the foreign
    // service keeps the proxy alive — the exact hole the ownership gate exists to close.
    expect(PROCESS_CONTROL_SOURCE).toContain('if (res.status === 409) return "refused"');

    const stopProxyFn = sliceFn(PROCESS_CONTROL_SOURCE, "export async function stopProxy(", "export function killProxy(");
    const refusedAt = stopProxyFn.indexOf('graceful === "refused"');
    const killAt = stopProxyFn.indexOf("killProxy(pid,");
    expect(refusedAt).toBeGreaterThan(-1);
    expect(refusedAt).toBeLessThan(killAt);
    expect(stopProxyFn).toContain("throw new Error(");
  });
});
