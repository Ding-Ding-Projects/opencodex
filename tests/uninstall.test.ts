import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("full uninstall command", () => {
  test("CLI exposes a one-shot local state cleanup command", async () => {
    const cli = await readText("src/cli/index.ts");

    expect(cli).toContain('case "uninstall"');
    expect(cli).toContain("async function handleUninstall()");
    expect(cli).toContain("uninstallServiceIfInstalled");
    expect(cli).toContain("uninstallCodexShim");
    expect(cli).toContain("restoreNativeCodex");
    expect(cli).toContain("removeOwnedConfigState(getConfigDir())");
    expect(cli).not.toContain("rmSync(getConfigDir()");
  });

  test("CLI exposes explicit legacy history recovery command", async () => {
    const cli = await readText("src/cli/index.ts");

    expect(cli).toContain("ocx recover-history --legacy-openai");
    expect(cli).toContain("function handleRecoverHistory()");
    expect(cli).toContain("restoreLegacyOpenaiHistory");
  });

  test("service cleanup has a quiet best-effort helper", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("export function uninstallServiceIfInstalled()");
    expect(service).toContain("uninstallLaunchd");
    expect(service).toContain("uninstallWindows");
    expect(service).toContain("uninstallSystemd");
  });

  test("full uninstall proves manager and proxy stop before deleting service assets", async () => {
    const cli = await readText("src/cli/index.ts");
    const uninstallBody = cli.slice(cli.indexOf("async function handleUninstall()"), cli.indexOf("async function handleStatus()"));
    const proxyStop = cli.slice(
      cli.indexOf("async function stopTrackedProxyForCli()"),
      cli.indexOf("function reportUnsafeStop("),
    );

    expect(uninstallBody).toContain("await runStopSequence({");
    expect(uninstallBody).toContain("stopManager:");
    expect(uninstallBody).toContain("stopProxy:");
    expect(uninstallBody).toContain("if (!stopOutcome.safeToRestart)");
    expect(uninstallBody).toContain('runStep("service removed"');
    expect(proxyStop).toContain("await stopProxy(pid);");
    expect(uninstallBody).toContain("uninstallServiceIfInstalled()");
    expect(uninstallBody.indexOf("stopManager:")).toBeLessThan(uninstallBody.indexOf("stopProxy:"));
    expect(uninstallBody.indexOf("if (!stopOutcome.safeToRestart)")).toBeLessThan(uninstallBody.indexOf('runStep("service removed"'));
  });
});
