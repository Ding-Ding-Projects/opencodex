import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * bin/ocx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");

describe("ocx.mjs npm launcher (source invariants)", () => {
  test("npm spawns go through a shell on Windows (Node ≥18.20 EINVALs shell-less .cmd spawns)", () => {
    const spawnSites = source.match(/spawnSync\(npm,[\s\S]*?\}\)/g) ?? [];
    expect(spawnSites.length).toBe(2);
    for (const site of spawnSites) {
      expect(site).toContain("shell: winShell");
    }
    expect(source).toContain('const winShell = process.platform === "win32";');
  });

  test("--tag is allowlisted before reaching shell-joined spawn args", () => {
    expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
    expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
  });
});

describe.skipIf(process.platform === "win32")("ocx.mjs legacy shim convergence", () => {
  function runLauncher(refreshExit: number, nativeState: "valid" | "missing" = "valid") {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-shim-refresh-"));
    const packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
    const packageBin = join(packageRoot, "bin");
    const runtimeRoot = join(root, "runtime");
    const runtimeBin = join(runtimeRoot, "bin");
    const fakeBun = join(runtimeBin, "bun");
    const log = join(root, "bun.log");
    const goLog = join(root, "go.log");
    const poisonLog = join(root, "poison.log");
    const home = join(root, "home");
    const wrapper = join(root, "codex");
    const backup = join(root, "codex.opencodex-real");
    mkdirSync(runtimeBin, { recursive: true });
    mkdirSync(join(packageBin, "native"), { recursive: true });
    mkdirSync(join(packageRoot, "src", "update"), { recursive: true });
    mkdirSync(home, { recursive: true });
    copyFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), join(packageBin, "ocx.mjs"));
    copyFileSync(join(import.meta.dir, "..", "bin", "native-runtime.mjs"), join(packageBin, "native-runtime.mjs"));
    copyFileSync(join(import.meta.dir, "..", "src", "update", "tray-update-plan.mjs"), join(packageRoot, "src", "update", "tray-update-plan.mjs"));
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "2.7.41" }));
    const script = `#!/bin/sh\nprintf 'guard=%s %s\\n' "$OCX_SHIM_RUNTIME_REFRESH_GUARD" "$*" >> "$OCX_TEST_BUN_LOG"\ncase "$*" in *refresh-runtime*) exit "$OCX_TEST_REFRESH_EXIT";; esac\nexit 0\n`;
    writeFileSync(fakeBun, script + "#".repeat(1_000_000), "utf8");
    chmodSync(fakeBun, 0o755);
    writeFileSync(join(runtimeRoot, "install.js"), `require('node:fs').appendFileSync(${JSON.stringify(poisonLog)}, 'install.js\\n')`);
    const target = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const native = join(packageBin, "native", `ocx_2.7.41_${target}_${arch}`);
    if (nativeState === "valid") {
      writeFileSync(native, "#!/bin/sh\nprintf 'go:%s\\n' \"$*\" >> \"$OCX_TEST_GO_LOG\"\nexit 0\n", { mode: 0o755 });
      chmodSync(native, 0o755);
    }
    writeFileSync(backup, "real codex", "utf8");
    writeFileSync(wrapper, "# opencodex codex autostart shim\n/old/bun /old/src/cli/index.ts ensure\n", { mode: 0o755 });
    writeFileSync(join(home, "codex-shim.json"), `${JSON.stringify({
      platform: process.platform,
      wrapperPath: wrapper,
      originalPath: wrapper,
      backupPath: backup,
    })}\n`, "utf8");
    const result = spawnSync(process.execPath, [join(packageBin, "ocx.mjs"), "status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODEX_HOME: home,
        OPENCODEX_BUN_PATH: fakeBun,
        OCX_TEST_BUN_LOG: log,
        OCX_TEST_GO_LOG: goLog,
        OCX_TEST_REFRESH_EXIT: String(refreshExit),
      },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const goCalls = existsSync(goLog) ? readFileSync(goLog, "utf8").trim().split("\n") : [];
    const poisonCalls = existsSync(poisonLog) ? readFileSync(poisonLog, "utf8").trim().split("\n") : [];
    rmSync(root, { recursive: true, force: true });
    return { result, calls, goCalls, poisonCalls };
  }

  test("validates packaged Go, invokes Bun exactly once for refresh, then forwards to Go", () => {
    const { result, calls, goCalls, poisonCalls } = runLauncher(0);
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("src/cli/index.ts codex-shim refresh-runtime");
    expect(calls[0]).toStartWith("guard=1 ");
    expect(goCalls).toEqual(["go:status"]);
    expect(poisonCalls).toEqual([]);
  });

  test("missing packaged Go fails before Bun or install.js can execute", () => {
    const { result, calls, goCalls, poisonCalls } = runLauncher(0, "missing");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package artifact is missing");
    expect(calls).toEqual([]);
    expect(goCalls).toEqual([]);
    expect(poisonCalls).toEqual([]);
  });

  test("refresh failure warns and still forwards to the validated packaged Go", () => {
    const { result, calls, goCalls } = runLauncher(7);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("legacy Codex shim runtime refresh failed (7)");
    expect(result.stderr).toContain("ocx codex-shim refresh-runtime");
    expect(calls).toHaveLength(1);
    expect(goCalls).toEqual(["go:status"]);
  });
});
