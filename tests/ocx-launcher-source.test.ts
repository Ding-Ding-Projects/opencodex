import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  function runLauncher(refreshExit: number) {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-shim-refresh-"));
    const runtimeRoot = join(root, "runtime");
    const runtimeBin = join(runtimeRoot, "bin");
    const fakeBun = join(runtimeBin, "bun");
    const log = join(root, "bun.log");
    const home = join(root, "home");
    const wrapper = join(root, "codex");
    const backup = join(root, "codex.opencodex-real");
    mkdirSync(runtimeBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    const script = `#!/bin/sh\nprintf 'guard=%s %s\\n' "$OCX_SHIM_RUNTIME_REFRESH_GUARD" "$*" >> "$OCX_TEST_BUN_LOG"\ncase "$*" in *refresh-runtime*) exit "$OCX_TEST_REFRESH_EXIT";; esac\nexit 0\n`;
    writeFileSync(fakeBun, script + "#".repeat(1_000_000), "utf8");
    chmodSync(fakeBun, 0o755);
    writeFileSync(backup, "real codex", "utf8");
    writeFileSync(wrapper, "# opencodex codex autostart shim\n/old/bun /old/src/cli/index.ts ensure\n", { mode: 0o755 });
    writeFileSync(join(home, "codex-shim.json"), `${JSON.stringify({
      platform: process.platform,
      wrapperPath: wrapper,
      originalPath: wrapper,
      backupPath: backup,
    })}\n`, "utf8");
    const result = spawnSync(process.execPath, [join(import.meta.dir, "..", "bin", "ocx.mjs"), "status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODEX_HOME: home,
        OPENCODEX_BUN_PATH: fakeBun,
        OCX_TEST_BUN_LOG: log,
        OCX_TEST_REFRESH_EXIT: String(refreshExit),
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    rmSync(root, { recursive: true, force: true });
    return { result, calls };
  }

  test("invokes retained Bun + fresh TS refresh before continuing to normal forwarding", () => {
    const { result, calls } = runLauncher(0);
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("src/cli/index.ts codex-shim refresh-runtime");
    expect(calls[0]).toStartWith("guard=1 ");
    expect(calls[1]).toContain("src/cli/index.ts status");
    expect(calls[1]).toStartWith("guard= ");
  });

  test("warns precisely and still forwards when refresh fails", () => {
    const { result, calls } = runLauncher(7);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("legacy Codex shim runtime refresh failed (7)");
    expect(result.stderr).toContain("ocx codex-shim refresh-runtime");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("src/cli/index.ts status");
  });
});
