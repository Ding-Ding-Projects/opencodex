import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runnable = process.platform !== "win32" && !spawnSync("node", ["--version"], { stdio: "ignore" }).error;
setDefaultTimeout(20_000);
const spawned: ChildProcess[] = [];
const roots: string[] = [];

afterAll(() => {
  for (const child of spawned) try { child.kill("SIGKILL"); } catch { /* already gone */ }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor(path: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(25);
  }
  return false;
}

function packagedLauncherFixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-signal-"));
  roots.push(root);
  const packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
  const bin = join(packageRoot, "bin");
  mkdirSync(join(bin, "native"), { recursive: true });
  mkdirSync(join(packageRoot, "src", "update"), { recursive: true });
  copyFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), join(bin, "ocx.mjs"));
  copyFileSync(join(import.meta.dir, "..", "bin", "native-runtime.mjs"), join(bin, "native-runtime.mjs"));
  copyFileSync(join(import.meta.dir, "..", "src", "update", "tray-update-plan.mjs"), join(packageRoot, "src", "update", "tray-update-plan.mjs"));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "2.7.41" }));
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const native = join(bin, "native", `ocx_2.7.41_${os}_${arch}`);
  writeFileSync(native, `#!/bin/sh
trap 'printf "%s\\n" "$OCX_TEST_SIGNAL" > "$OCX_TEST_STOPPED"; exit 0' INT TERM HUP
printf 'ready\\n' > "$OCX_TEST_READY"
while :; do sleep 1; done
`, { mode: 0o755 });
  chmodSync(native, 0o755);
  return { root, launcher: join(bin, "ocx.mjs") };
}

describe.skipIf(!runnable)("ocx native launcher graceful shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} is forwarded to the exact package-local Go artifact`, async () => {
      const fixture = packagedLauncherFixture();
      const ready = join(fixture.root, "ready");
      const stopped = join(fixture.root, "stopped");
      const child = spawn("node", [fixture.launcher, "start"], {
        stdio: "ignore",
        env: {
          ...process.env,
          OPENCODEX_HOME: join(fixture.root, "home"),
          OCX_TEST_READY: ready,
          OCX_TEST_STOPPED: stopped,
          OCX_TEST_SIGNAL: signal,
        },
      });
      spawned.push(child);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(await waitFor(ready)).toBe(true);
      child.kill(signal);
      expect(await waitFor(stopped)).toBe(true);
      expect(readFileSync(stopped, "utf8").trim()).toBe(signal);
      await exited;
    });
  }
});
