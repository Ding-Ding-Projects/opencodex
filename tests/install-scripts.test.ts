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
    expect(script).not.toContain("bun install -g @bitkyc08/opencodex");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test("PowerShell installer repairs a missing npm global PATH entry", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("function Add-NpmGlobalBinToPath");
    expect(script).toContain('$userPath = [Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)');
    expect(script).toContain('[Environment]::SetEnvironmentVariable("Path", $updatedUserPath, [System.EnvironmentVariableTarget]::User)');
    expect(script).toContain("$env:Path = Add-PathEntry -PathValue $env:Path -Entry $npmPrefix");
    expect(script).toContain("Get-Command ocx.cmd -ErrorAction SilentlyContinue");
    expect(script).toContain("Get-Command ocx -ErrorAction SilentlyContinue");
    expect(script).toContain("& $ocx.Source help");
  });

  test("PowerShell installer keeps PATH entries and avoids case-insensitive duplicates", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain('$existingPath -split ";"');
    expect(script).toContain(".Trim().TrimEnd(\"\\\") -ieq $normalizedEntry");
    expect(script).toContain("return $existingPath");
    expect(script).toContain('return "$existingPath;$Entry"');
    expect(script).toContain('return "$existingPath$Entry"');
    expect(script).toContain("$updatedUserPath -cne $userPath");
  });

  test("PowerShell installer fails closed for invalid prefixes and PATH writes", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("$prefixExitCode = $LASTEXITCODE");
    expect(script).toContain("npm prefix -g returned an empty global bin directory");
    expect(script).toContain("npm prefix -g returned a non-absolute global bin directory");
    expect(script).toContain("-not (Test-Path -LiteralPath $npmPrefix -PathType Container)");
    expect(script).toContain("could not write the current user's PATH or update this process");
    expect(script).toContain("exit 1");
    expect(script).not.toContain("EnvironmentVariableTarget]::Machine");
    expect(script).not.toContain("setx");
  });

  test("PowerShell installer reports unresolved ocx after PATH repair", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("could not be resolved after adding npm's global bin directory");
    expect(script).toContain("'ocx.cmd'/'ocx'");
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
