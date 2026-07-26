import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hostTarget(): { os: string; arch: string; suffix: string } | null {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  return os && arch ? { os, arch, suffix: process.platform === "win32" ? ".exe" : "" } : null;
}

describe("immutable pre-bridge updater runtime rebake", () => {
  test("an old Bun process loads owners only from the replaced package and Node forwards into its packaged runtime", {
    skip: !hostTarget(),
  }, () => {
    const fixtureRoot = mkdtempSync(join(repo, "tests", ".tmp-prebridge-replaced-"));
    roots.push(fixtureRoot);
    const packageRoot = join(fixtureRoot, "package");
    mkdirSync(join(packageRoot, "bin", "native"), { recursive: true });
    cpSync(join(repo, "src"), join(packageRoot, "src"), { recursive: true });
    cpSync(join(repo, "bin", "ocx.mjs"), join(packageRoot, "bin", "ocx.mjs"));
    cpSync(join(repo, "bin", "native-runtime.mjs"), join(packageRoot, "bin", "native-runtime.mjs"));
    const version = "2.7.41";
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", type: "module", version }));
    const target = hostTarget()!;
    const native = join(packageRoot, "bin", "native", `ocx_${version}_${target.os}_${target.arch}${target.suffix}`);
    linkSync(process.execPath, native);

    const receipt = join(fixtureRoot, "receipt.json");
    const probe = join(packageRoot, "owner-probe.ts");
    writeFileSync(probe, `
      import { writeFileSync } from "node:fs";
      import { serviceRuntimeEntry } from "./src/service.ts";
      import { windowsTrayRuntimeEntry } from "./src/tray/windows.ts";
      const root = process.argv[2];
      writeFileSync(process.argv[3], JSON.stringify({
        service: serviceRuntimeEntry(root),
        tray: windowsTrayRuntimeEntry(root),
        module: import.meta.url,
      }));
    `);
    const oldUpdater = join(fixtureRoot, "immutable-old-updater.mjs");
    writeFileSync(oldUpdater, `
      import { spawnSync } from "node:child_process";
      const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit", env: process.env });
      process.exit(result.status ?? 1);
    `);

    const ownerRun = spawnSync(process.execPath, [oldUpdater, probe, packageRoot, receipt], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: process.env,
    });
    expect(ownerRun.status).toBe(0);
    const rebaked = JSON.parse(readFileSync(receipt, "utf8"));
    expect(rebaked.module).toContain(packageRoot);
    expect({ bun: rebaked.tray.bun, cli: rebaked.tray.cli }).toEqual(rebaked.service);
    expect(rebaked.service.cli).toBe(join(packageRoot, "bin", "ocx.mjs"));
    expect(rebaked.service.bun).toBe(realpathSync(spawnSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["node"],
      { encoding: "utf8" },
    ).stdout.trim().split(/\r?\n/, 1)[0]));

    const forwarded = spawnSync(rebaked.service.bun, [rebaked.service.cli, "--version"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, OPENCODEX_RUNTIME: "go", OPENCODEX_HOME: join(fixtureRoot, "home") },
    });
    expect(forwarded.status).toBe(0);
    expect(forwarded.stdout.trim()).toBe(Bun.version);
  });
});
