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
    expect(pkg.scripts?.["verify:gui-dist"]).toBe("bun scripts/verify-gui-dist.ts");
    expect(pkg.scripts?.prepack).toBe("bun run verify:gui-dist && bun run prepare:package");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/claude-code-models.gif");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
  });

  test("GUI builds stamp their source identity before packaging", async () => {
    const guiPkg = JSON.parse(await readText("gui/package.json")) as { scripts?: Record<string, string> };
    const index = await readText("gui/index.html");

    expect(guiPkg.scripts?.build).toContain("bun ../scripts/stamp-gui-build.ts");
    expect(index).toContain('<meta name="opencodex-ui-generation" content="material-3"');
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

  test.skipIf(process.platform !== "win32")("Get-OcxCommandPaths mirrors PATH resolution order, not PowerShell's own command table", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $files = @('C:\\Tools\\ocx.exe', 'C:\\Users\\tester\\AppData\\Roaming\\npm\\ocx.cmd')
      $found = Get-OcxCommandPaths -PathValue 'C:\\Tools;C:\\Users\\tester\\AppData\\Roaming\\npm;C:\\Nothing' -TestFile { param($p) $files -contains $p }
      ConvertTo-Json -InputObject $found -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      "C:\\Tools\\ocx.exe",
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\ocx.cmd",
    ]);
  });

  test.skipIf(process.platform !== "win32")("Get-OcxCommandPaths follows the supplied PATHEXT order across all executable suffixes", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $files = @('C:\\Tools\\ocx.com', 'C:\\Tools\\ocx.exe', 'C:\\Tools\\ocx.bat', 'C:\\Tools\\ocx.cmd')
      $found = Get-OcxCommandPaths -PathValue 'C:\\Tools' -PathextValue '.COM;.EXE;.BAT;.CMD' -TestFile { param($p) $files -contains $p }
      ConvertTo-Json -InputObject $found -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(["C:\\Tools\\ocx.com"]);
  });

  test.skipIf(process.platform !== "win32")("desktop PATH repair exposes a transaction rollback instead of false success", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Other'; Process = 'C:\\Other'; Writes = 0 }
      $result = Add-DesktopCliPath -BinDir 'C:\\Stable\\cli-bin' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p; $state.Writes++ } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p; $state.Writes++ } -ReadMachinePath { '' } -ResolvedOcxPaths @() -ForceFailure
      [pscustomobject]@{ Ok = $result.Ok; Recovered = $result.TransactionRecovered; User = $state.User; Process = $state.Process } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Recovered: true, User: "C:\\Other", Process: "C:\\Other" });
  });

  test.skipIf(process.platform !== "win32")("desktop PATH apply uses compare-before-write and reports a concurrent write", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Other'; Process = 'C:\\Other' }
      $result = Add-DesktopCliPath -BinDir 'C:\\Stable\\cli-bin' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p + ';C:\\Concurrent' } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadMachinePath { '' } -ResolvedOcxPaths @()
      [pscustomobject]@{ Ok = $result.Ok; Conflict = $result.PathConflict; RollbackFailed = $result.RollbackFailed; User = $state.User } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Conflict: true, RollbackFailed: true, User: "C:\\Other;C:\\Stable\\cli-bin;C:\\Concurrent" });
  });

  test.skipIf(process.platform !== "win32")("desktop PATH rollback uses compare-before-restore and preserves a concurrent edit", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Other'; Process = 'C:\\Other'; UserWrites = 0 }
      $result = Add-DesktopCliPath -BinDir 'C:\\Stable\\cli-bin' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.UserWrites++; if ($state.UserWrites -gt 1) { $state.User = 'C:\\Concurrent' } else { $state.User = $p } } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadMachinePath { '' } -ResolvedOcxPaths @() -ForceFailure
      [pscustomobject]@{ Ok = $result.Ok; Recovered = $result.TransactionRecovered; RollbackFailed = $result.RollbackFailed; User = $state.User } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Recovered: false, RollbackFailed: true, User: "C:\\Concurrent" });
  });

  test.skipIf(process.platform !== "win32")("uninstall removes only an exact owned shim and its exact user PATH entry", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Other;C:\\Stable\\cli-bin;C:\\Data'; Process = 'C:\\Stable\\cli-bin;C:\\Other'; Shim = '@echo off'; ShimExists = $true; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent '@echo off' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) $state.ShimExists = $false } -ReadClaim { param($p) $state.Shim } -RestoreClaim { param($p) $state.ShimExists = $true } -RemoveClaim { param($p) $state.ShimExists = $false } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @() } -RemoveDirectory { $state.DirExists = $false }
      [pscustomobject]@{ Ok = $result.Ok; Owned = $result.Owned; User = $state.User; Process = $state.Process; ShimExists = $state.ShimExists; DirExists = $state.DirExists } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: true, Owned: true, User: "C:\\Other;C:\\Data", Process: "C:\\Other", ShimExists: false, DirExists: false });
  });

  test.skipIf(process.platform !== "win32")("uninstall preserves an edited shim and every PATH/data entry", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Other;C:\\Stable\\cli-bin;C:\\Data'; Process = 'C:\\Stable\\cli-bin;C:\\Other'; Shim = 'user-owned'; ShimExists = $true; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent 'generated' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) $state.ShimExists = $false } -ReadClaim { param($p) $state.Shim } -RestoreClaim { param($p) $state.ShimExists = $true } -RemoveClaim { param($p) $state.ShimExists = $false } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @() } -RemoveDirectory { $state.DirExists = $false }
      [pscustomobject]@{ Ok = $result.Ok; Owned = $result.Owned; User = $state.User; Process = $state.Process; Shim = $state.Shim; ShimExists = $state.ShimExists; DirExists = $state.DirExists } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: true, Owned: false, User: "C:\\Other;C:\\Stable\\cli-bin;C:\\Data", Process: "C:\\Stable\\cli-bin;C:\\Other", Shim: "user-owned", ShimExists: true, DirExists: true });
  });

  test.skipIf(process.platform !== "win32")("uninstall preserves a concurrent replacement and its quarantine claim", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Stable\\cli-bin'; Process = 'C:\\Stable\\cli-bin'; Shim = 'generated'; Claim = 'generated'; ShimExists = $true; ClaimExists = $false; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent 'generated' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) $state.ShimExists = $true; $state.Shim = 'replacement'; $state.ClaimExists = $true } -ReadClaim { param($p) $state.Claim } -RestoreClaim { param($p) throw 'destination occupied' } -RemoveClaim { param($p) $state.ClaimExists = $false } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @() } -RemoveDirectory { $state.DirExists = $false }
      [pscustomobject]@{ Ok = $result.Ok; Conflict = $result.ReplacementConflict; ClaimPath = $result.ClaimPath; Shim = $state.Shim; ClaimExists = $state.ClaimExists; User = $state.User } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Conflict: true, ClaimPath: "C:\\Stable\\claim.tmp", Shim: "replacement", ClaimExists: true, User: "C:\\Stable\\cli-bin" });
  });

  test.skipIf(process.platform !== "win32")("uninstall refuses an occupied quarantine claim without reporting a false claim path", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Stable\\cli-bin'; Process = 'C:\\Stable\\cli-bin'; Shim = 'generated'; ShimExists = $true; ClaimExists = $true; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent 'generated' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) throw 'claim destination occupied' } -ReadClaim { param($p) $state.Shim } -RestoreClaim { param($p) throw 'must not restore an unclaimed shim' } -RemoveClaim { param($p) throw 'must not remove an unclaimed shim' } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @() } -RemoveDirectory { throw 'must not remove directory' }
      [pscustomobject]@{ Ok = $result.Ok; Recovered = $result.TransactionRecovered; RollbackFailed = $result.RollbackFailed; ClaimPath = $result.ClaimPath; ShimExists = $state.ShimExists; ClaimExists = $state.ClaimExists } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Recovered: true, RollbackFailed: false, ClaimPath: null, ShimExists: true, ClaimExists: true });
  });

  test.skipIf(process.platform !== "win32")("uninstall PATH apply uses compare-before-write and preserves a concurrent PATH edit", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Stable\\cli-bin'; Process = 'C:\\Stable\\cli-bin'; Shim = 'generated'; ShimExists = $true; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent 'generated' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = 'C:\\Concurrent' } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) $state.ShimExists = $false } -ReadClaim { param($p) $state.Shim } -RestoreClaim { param($p) $state.ShimExists = $true } -RemoveClaim { param($p) $state.ShimExists = $false } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @() } -RemoveDirectory { $state.DirExists = $false }
      [pscustomobject]@{ Ok = $result.Ok; Conflict = $result.PathConflict; RollbackFailed = $result.RollbackFailed; User = $state.User; ShimExists = $state.ShimExists } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Conflict: true, RollbackFailed: true, User: "C:\\Concurrent", ShimExists: true });
  });

  test.skipIf(process.platform !== "win32")("uninstall keeps a stable directory that contains unrelated data", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Stable\\cli-bin'; Process = 'C:\\Stable\\cli-bin'; Shim = 'generated'; ShimExists = $true; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent 'generated' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) $state.ShimExists = $false } -ReadClaim { param($p) $state.Shim } -RestoreClaim { param($p) $state.ShimExists = $true } -RemoveClaim { param($p) $state.ShimExists = $false } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @('unrelated-data.json') } -RemoveDirectory { $state.DirExists = $false }
      [pscustomobject]@{ Ok = $result.Ok; Removed = $result.Removed; DirRemoved = $result.StableDirRemoved; DirExists = $state.DirExists } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: true, Removed: true, DirRemoved: false, DirExists: true });
  });

  test.skipIf(process.platform !== "win32")("uninstall rolls PATH and shim back when stable-directory removal fails", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $state = @{ User = 'C:\\Other;C:\\Stable\\cli-bin'; Process = 'C:\\Stable\\cli-bin;C:\\Other'; Shim = 'generated'; ShimExists = $true; DirExists = $true }
      $result = Remove-OcxPathRegistration -BinDir 'C:\\Stable\\cli-bin' -ShimPath 'C:\\Stable\\cli-bin\\ocx.cmd' -ExpectedShimContent 'generated' -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p } -ReadShim { [pscustomobject]@{ Exists = $state.ShimExists; Content = $state.Shim } } -NewClaimPath { 'C:\\Stable\\claim.tmp' } -ClaimShim { param($p) $state.ShimExists = $false } -ReadClaim { param($p) $state.Shim } -RestoreClaim { param($p) $state.ShimExists = $true } -RemoveClaim { param($p) $state.ShimExists = $false } -TestShim { $state.ShimExists } -TestDirectory { $state.DirExists } -GetDirectoryEntries { @() } -RemoveDirectory { throw 'sharing violation' } -CreateDirectory { $state.DirExists = $true }
      [pscustomobject]@{ Ok = $result.Ok; Recovered = $result.TransactionRecovered; User = $state.User; Process = $state.Process; Shim = $state.Shim; ShimExists = $state.ShimExists } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ Ok: false, Recovered: true, User: "C:\\Other;C:\\Stable\\cli-bin", Process: "C:\\Stable\\cli-bin;C:\\Other", Shim: "generated", ShimExists: true });
  });

  test.skipIf(process.platform !== "win32")("Get-OcxCommandPaths returns nothing when no directory has an ocx binary", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $found = Get-OcxCommandPaths -PathValue 'C:\\Tools;C:\\Windows' -TestFile { $false }
      ConvertTo-Json -InputObject $found -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("[]");
  });

  test.skipIf(process.platform !== "win32")("Resolve-OcxPathCollision does nothing when this fork's directory already wins", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $directory = 'C:\\Users\\tester\\AppData\\Roaming\\npm'
      $writes = @{ User = $null; Process = $null }
      $result = Resolve-OcxPathCollision -NpmGlobalBin $directory -ResolvedOcxPaths @('C:\\Users\\tester\\AppData\\Roaming\\npm\\ocx.cmd') -ReadMachinePath { 'C:\\Windows\\System32' } -ReadUserPath { $directory } -WriteUserPath { param($p) $writes.User = $p } -ReadProcessPath { $directory } -WriteProcessPath { param($p) $writes.Process = $p }
      [pscustomobject]@{ Collision = $result.Collision; Reordered = $result.Reordered; MachineBlocked = $result.MachineBlocked; WroteUser = ($null -ne $writes.User); WroteProcess = ($null -ne $writes.Process) } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Collision: false,
      Reordered: false,
      MachineBlocked: false,
      WroteUser: false,
      WroteProcess: false,
    });
  });

  test.skipIf(process.platform !== "win32")("Resolve-OcxPathCollision reorders the user PATH ahead of a colliding user-scope install", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $directory = 'C:\\Users\\tester\\AppData\\Roaming\\npm'
      $state = @{ User = 'C:\\Windows\\System32;C:\\Other\\ocx-install;' + $directory; Process = 'C:\\Other\\ocx-install;' + $directory }
      $result = Resolve-OcxPathCollision -NpmGlobalBin $directory -ResolvedOcxPaths @('C:\\Other\\ocx-install\\ocx.cmd', ($directory + '\\ocx.cmd')) -ReadMachinePath { 'C:\\Windows\\System32' } -ReadUserPath { $state.User } -WriteUserPath { param($p) $state.User = $p } -ReadProcessPath { $state.Process } -WriteProcessPath { param($p) $state.Process = $p }
      [pscustomobject]@{ Collision = $result.Collision; Reordered = $result.Reordered; MachineBlocked = $result.MachineBlocked; Winner = $result.Winner; User = $state.User; Process = $state.Process } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.Collision).toBe(true);
    expect(parsed.Reordered).toBe(true);
    expect(parsed.MachineBlocked).toBe(false);
    expect(parsed.Winner).toBe("C:\\Other\\ocx-install\\ocx.cmd");
    // Our directory is now first in both the persisted user PATH and this process's PATH,
    // and the stray duplicate of our own directory further down is not doubled.
    expect(parsed.User).toBe("C:\\Users\\tester\\AppData\\Roaming\\npm;C:\\Windows\\System32;C:\\Other\\ocx-install");
    expect(parsed.Process).toBe("C:\\Users\\tester\\AppData\\Roaming\\npm;C:\\Other\\ocx-install");
  });

  test.skipIf(process.platform !== "win32")("Resolve-OcxPathCollision reports (never silently ignores) a collision it cannot fix on the machine PATH", async () => {
    const scriptPath = fileURLToPath(new URL("scripts/install-path.ps1", root));
    const escapedPath = scriptPath.replace(/'/g, "''");
    const probe = `
      . '${escapedPath}'
      $directory = 'C:\\Users\\tester\\AppData\\Roaming\\npm'
      $writes = @{ User = $null; Process = $null }
      $result = Resolve-OcxPathCollision -NpmGlobalBin $directory -ResolvedOcxPaths @('C:\\Program Files\\upstream-ocx\\ocx.exe') -ReadMachinePath { 'C:\\Windows\\System32;C:\\Program Files\\upstream-ocx' } -ReadUserPath { $directory } -WriteUserPath { param($p) $writes.User = $p } -ReadProcessPath { $directory } -WriteProcessPath { param($p) $writes.Process = $p }
      [pscustomobject]@{ Collision = $result.Collision; Reordered = $result.Reordered; MachineBlocked = $result.MachineBlocked; Winner = $result.Winner; WroteUser = ($null -ne $writes.User); WroteProcess = ($null -ne $writes.Process) } | ConvertTo-Json -Compress
    `;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      Collision: true,
      Reordered: false,
      MachineBlocked: true,
      Winner: "C:\\Program Files\\upstream-ocx\\ocx.exe",
      WroteUser: false,
      WroteProcess: false,
    });
  });

  test("PowerShell installer checks for and reports a colliding 'ocx' on PATH", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Resolve-OcxPathCollision");
    expect(script).toContain("Get-OcxCommandPaths");
    // The collision check must simulate a fresh shell's PATH (machine + the
    // now-repaired persisted user PATH), never the live process's $env:Path —
    // Add-NpmGlobalBinToUserPath already prepends our directory there, which
    // would hide a real collision that a brand-new shell would still hit.
    expect(script).toContain('[Environment]::GetEnvironmentVariable("Path", "Machine")');
    expect(script).not.toContain("-ResolvedOcxPaths (Get-OcxCommandPaths -PathValue $env:Path)");
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
    expect(launcher).toContain('["install", "-g", `${PKG}@${latest}`]');
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
