import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("install scripts", () => {
  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("5.9.3");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.3.14");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/claude-code-models.gif");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.cliCommand !== 'ocx') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("opencodex dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("POSIX installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.sh");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("npm install -g @bitkyc08/opencodex");
    expect(script).toContain("command -v ocx");
    expect(script).toContain("ocx help");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install");
  });

  test("PowerShell installer matches the Node launcher prerequisite", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain("& $npm.Source install -g @bitkyc08/opencodex");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toContain("Get-Command ocx.cmd");
    expect(script).toContain("Get-Command ocx");
    expect(script).toContain("& $ocx.Source help");
    expect(script).toContain("install-path.ps1");
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test.skipIf(process.platform !== "win32")("PowerShell installer repairs npm global PATH safely", async () => {
    const script = await readText("scripts/install-path.ps1");
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $directory = 'C:\\Users\\tester\\AppData\\Roaming\\npm'
      $state = @{ UserPath = 'C:\\Windows\\System32;C:\\Tools'; ProcessPath = 'C:\\Windows\\System32'; WrittenUserPath = $null; WrittenProcessPath = $null }
      $result = Add-NpmGlobalBinToUserPath -NpmGlobalBin $directory -TestDirectory { param($path) $path -eq $directory } -ReadUserPath { $state.UserPath } -WriteUserPath { param($path) $state.WrittenUserPath = $path } -ReadProcessPath { $state.ProcessPath } -WriteProcessPath { param($path) $state.WrittenProcessPath = $path }
      [pscustomobject]@{ UserPath = $state.WrittenUserPath; ProcessPath = $state.WrittenProcessPath; UserChanged = $result.UserPathChanged; ProcessChanged = $result.ProcessPathChanged } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      UserPath: "C:\\Windows\\System32;C:\\Tools;C:\\Users\\tester\\AppData\\Roaming\\npm",
      ProcessPath: "C:\\Users\\tester\\AppData\\Roaming\\npm;C:\\Windows\\System32",
      UserChanged: true,
      ProcessChanged: true,
    });
    expect(script).toContain('[Environment]::SetEnvironmentVariable("Path", $Path, "User")');
    expect(script).not.toContain('SetEnvironmentVariable("Path", $Path, "Machine")');
  });

  test.skipIf(process.platform !== "win32")("PowerShell PATH repair is idempotent and case-insensitive", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $directory = 'C:\\Users\\tester\\AppData\\Roaming\\npm'
      $state = @{ UserPath = 'C:\\Tools; c:\\users\\TESTER\\appdata\\roaming\\NPM\\;C:\\TOOLS;C:\\Users\\tester\\AppData\\Roaming\\npm'; ProcessPath = 'C:\\Tools; C:\\USERS\\tester\\AppData\\Roaming\\npm' ; WriteCount = 0 }
      $result = Add-NpmGlobalBinToUserPath -NpmGlobalBin $directory -TestDirectory { $true } -ReadUserPath { $state.UserPath } -WriteUserPath { $state.WriteCount++ } -ReadProcessPath { $state.ProcessPath } -WriteProcessPath { $state.WriteCount++ }
      [pscustomobject]@{ WriteCount = $state.WriteCount; UserChanged = $result.UserPathChanged; ProcessChanged = $result.ProcessPathChanged } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      WriteCount: 0,
      UserChanged: false,
      ProcessChanged: false,
    });
  });

  test.skipIf(process.platform !== "win32")("PowerShell PATH repair leaves the user update failure visible", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      try {
        Add-NpmGlobalBinToUserPath -NpmGlobalBin 'C:\\Users\\tester\\AppData\\Roaming\\npm' -TestDirectory { $true } -ReadUserPath { 'C:\\Windows\\System32' } -WriteUserPath { throw 'access denied' } -ReadProcessPath { 'C:\\Windows\\System32' } -WriteProcessPath { throw 'should not run' }
        'unexpected-success'
      } catch {
        $_.Exception.Message
      }
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("access denied");
  });

  test.skipIf(process.platform !== "win32")("PowerShell PATH repair reports a process refresh failure without undoing the user repair", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ WrittenUserPath = $null }
      $result = Add-NpmGlobalBinToUserPath -NpmGlobalBin 'C:\\Users\\tester\\AppData\\Roaming\\npm' -TestDirectory { $true } -ReadUserPath { 'C:\\Windows\\System32' } -WriteUserPath { param($path) $state.WrittenUserPath = $path } -ReadProcessPath { 'C:\\Windows\\System32' } -WriteProcessPath { throw 'process environment unavailable' }
      [pscustomobject]@{ UserPath = $state.WrittenUserPath; UserChanged = $result.UserPathChanged; ProcessChanged = $result.ProcessPathChanged; ProcessRefreshFailed = $result.ProcessPathRefreshFailed } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      UserPath: "C:\\Windows\\System32;C:\\Users\\tester\\AppData\\Roaming\\npm",
      UserChanged: true,
      ProcessChanged: false,
      ProcessRefreshFailed: true,
    });
  });

  test("PowerShell installer documentation explains current-user PATH repair", async () => {
    const docs = await readText("docs-site/src/content/docs/getting-started/installation.md");

    expect(docs).toContain(".\\scripts\\install.ps1");
    expect(docs).toContain("current user's npm global");
    expect(docs).toContain("does not require administrator");
  });

  test("Node launcher handles npm self-update before starting Bun", async () => {
    const launcher = await readText("bin/ocx.mjs");

    expect(launcher).toContain('process.argv[2] === "update"');
    expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
    expect(launcher).toContain('return String(currentVersion).includes("-preview.") ? "preview" : "latest"');
    expect(launcher).toContain("!isBunGlobalInstall()");
    expect(launcher).toContain("repairCodexShimIfNeeded()");
    expect(launcher).toContain("runNpmSelfUpdate()");
  });

  test("release helper watches the workflow run it just dispatched", async () => {
    const script = await readText("scripts/release.ts");

    expect(script).toContain("waitForReleaseWorkflowRun");
    expect(script).toContain("gh run list --workflow release.yml --branch");
    expect(script).toContain("--commit");
    expect(script).toContain("createdAt,databaseId,headSha,status,url");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
  });
});
