import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => Bun.file(new URL(path, root)).text();

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectInOrder(source: string, first: string, second: string): void {
  const firstAt = source.indexOf(first);
  const secondAt = source.indexOf(second, firstAt + first.length);
  expect(firstAt).toBeGreaterThanOrEqual(0);
  expect(secondAt).toBeGreaterThan(firstAt);
}

describe("automatic CLI launch policy wiring", () => {
  test("ensure, tray direct, and GUI use soft direct starts with PID-scoped readiness", async () => {
    const source = await read("src/cli/index.ts");
    const ensure = slice(source, "async function handleEnsure(", "async function handleTrayProxyStart(");
    const tray = slice(source, "async function handleTrayProxyStart(", "async function handleTrayProxyRestart(");
    const gui = slice(source, 'case "gui"', 'case "service"');

    for (const branch of [ensure, tray, gui]) {
      expect(branch).toContain("proxyStartArgv(process.argv[1])");
      expect(branch).toContain("directProxyEnv()");
      expect(branch).not.toContain('"--port"');
    }
    expect(ensure).toContain("expectedPid: child.pid");
    expect(tray).toContain("return child.pid");
    expect(gui).toContain("expectedPid: child.pid");
  });

  test("explicit restart bypasses ensure and uses the service-aware verified coordinator", async () => {
    const source = await read("src/cli/index.ts");
    const restart = slice(source, 'case "restart"', 'case "health"');
    const coordinator = slice(source, "async function handleTrayProxyRestart(", "async function stopTrackedProxyForCli(");
    expect(restart).toContain("await handleTrayProxyRestart()");
    expect(restart).not.toContain("handleEnsure()");
    expect(coordinator).toContain("return outcome.safeToRestart");
    expect(coordinator).toContain("if (ok) process.exitCode = exitCodeBeforeRestart");
  });

  test("start probes liveness even when the pid file is missing", async () => {
    const source = await read("src/cli/index.ts");
    const start = slice(source, "async function handleStart(", "async function handleEnsure(");
    expect(start).toContain(
      "const owner = await findProxyOwnerBeforeJournalRecovery({ probeConfiguredPort: true });",
    );
  });

  test("start serializes the final probe/bind and rechecks identity after a collision", async () => {
    const source = await read("src/cli/index.ts");
    const start = slice(source, "async function handleStart(", "async function handleEnsure(");
    const lockAt = start.indexOf("await acquireProxyStartLock()");
    const finalProbeAt = start.indexOf("const racedLive = await findLiveProxy()", lockAt);
    const bindAt = start.indexOf("server = startServer(port)", finalProbeAt);
    const publishAt = start.indexOf("writeRuntimePort({", bindAt);
    const releaseAt = start.indexOf("startLock.release()", publishAt);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(finalProbeAt).toBeGreaterThan(lockAt);
    expect(bindAt).toBeGreaterThan(finalProbeAt);
    expect(publishAt).toBeGreaterThan(bindAt);
    expect(releaseAt).toBeGreaterThan(publishAt);
    expect(start).toContain("const collisionLive = await waitForProxyIdentity({");
    expect(start).toContain("refusing a duplicate fallback daemon");
  });

  test("generic explicit start never edits TCP rows while reclaiming its hard pin", async () => {
    const source = await read("src/cli/index.ts");
    const choose = slice(source, "async function chooseListenPort(", "async function handleStart(");
    expect(choose).toContain("killOcxHolders: false");
    expect(choose).not.toContain("dropTcpRows: false");
  });

  test("Claude and OpenCode implicit bootstraps are soft and unsupervised", async () => {
    const claude = await read("src/cli/claude.ts");
    const opencode = await read("src/cli/opencode.ts");
    for (const source of [claude, opencode]) {
      expect(source).toContain("proxyStartArgv(process.argv[1])");
      expect(source).toContain("expectedPid: child.pid");
    }
    expect(claude).toContain("env: directProxyEnv()");
    expect(opencode).toContain("directProxyEnv(withTokenFile");
  });

  test("losing convenience launchers adopt the identity-checked winner after their exact child loses", async () => {
    const index = await read("src/cli/index.ts");
    const ensure = slice(index, "async function handleEnsure(", "async function handleTrayProxyStart(");
    const gui = slice(index, 'case "gui"', 'case "service"');
    const claude = slice(
      await read("src/cli/claude.ts"),
      "async function ensureProxyForClaude(",
      "const CLAUDE_INSTALL_HINT",
    );
    const opencode = slice(
      await read("src/cli/opencode.ts"),
      "async function ensureProxyForOpencode(",
      "const OPENCODE_INSTALL_HINT",
    );

    expectInOrder(
      ensure,
      "waitForProxyIdentity({ expectedPid: child.pid })",
      "await waitForProxyIdentity()",
    );
    expectInOrder(
      gui,
      "waitForProxyIdentity({ expectedPid: child.pid })",
      "await waitForProxyIdentity()",
    );
    expectInOrder(
      claude,
      "waitForProxyIdentity({ expectedPid: child.pid, intervalMs: 250 })",
      "waitForProxyIdentity({ intervalMs: 250 })",
    );
    expectInOrder(
      opencode,
      "waitForProxyIdentity({ expectedPid: child.pid, intervalMs: 250 })",
      "waitForProxyIdentity({ intervalMs: 250 })",
    );

    for (const launcher of [ensure, gui, claude, opencode]) {
      expect(launcher).not.toContain("while (true)");
      expect(launcher).not.toContain("new Promise<void>(() => {})");
    }
  });

  test("detached convenience starts observe spawn errors before unref", async () => {
    const index = await read("src/cli/index.ts");
    const launchers = [
      slice(index, "async function handleEnsure(", "async function handleTrayProxyStart("),
      slice(index, 'case "gui"', 'case "service"'),
      slice(
        await read("src/cli/claude.ts"),
        "async function ensureProxyForClaude(",
        "const CLAUDE_INSTALL_HINT",
      ),
      slice(
        await read("src/cli/opencode.ts"),
        "async function ensureProxyForOpencode(",
        "const OPENCODE_INSTALL_HINT",
      ),
    ];

    for (const launcher of launchers) {
      expectInOrder(launcher, "const child = spawn(", 'child.on("error"');
      expectInOrder(launcher, 'child.on("error"', "child.unref()");
    }
  });

  test("dashboard in-place restart remains hard-pinned but strips a leaked service marker", async () => {
    const source = await read("src/server/management/system-restart.ts");
    const spawn = slice(source, "function spawnDetachedStart(", "/**\n * Accept a drain-and-restart request");
    expect(spawn).toContain("proxyStartArgv(process.argv[1], port)");
    expect(spawn).toContain("env: directProxyEnv()");
    expect(spawn).toContain("await waitForRestartChild(childPid)");
  });
});
