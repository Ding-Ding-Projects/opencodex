import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isSupportedNativeTarget, nativeArtifactName, resolveNativeGoBinary } from "../bin/native-runtime.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const launcher = join(root, "bin", "ocx.mjs");

function hostTarget() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  return os && arch ? { os, arch } : null;
}

function launcherFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-native-quadrants-"));
  mkdirSync(join(dir, "bin", "native"), { recursive: true });
  mkdirSync(join(dir, "src", "update"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "bun", "bin"), { recursive: true });
  copyFileSync(launcher, join(dir, "bin", "ocx.mjs"));
  copyFileSync(join(root, "bin", "native-runtime.mjs"), join(dir, "bin", "native-runtime.mjs"));
  copyFileSync(join(root, "src", "update", "tray-update-plan.mjs"), join(dir, "src", "update", "tray-update-plan.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", version: "2.9.0" }));
  writeFileSync(join(dir, "node_modules", "bun", "package.json"), JSON.stringify({ name: "bun", version: "1.3.14" }));
  const bun = join(dir, "node_modules", "bun", "bin", "bun");
  writeFileSync(bun, "#!/bin/sh\nprintf 'ts:%s\\n' \"$*\" > \"$OCX_TEST_RESULT\"\nexit 19\n#" + "x".repeat(1_000_000));
  chmodSync(bun, 0o755);
  const goOverride = join(dir, "override-go");
  writeFileSync(goOverride, "#!/bin/sh\nprintf 'go:%s\\n' \"$*\" > \"$OCX_TEST_RESULT\"\nexit 17\n");
  chmodSync(goOverride, 0o755);
  const target = hostTarget();
  if (!target) return { dir, target, goOverride, packagedGo: null };
  const packagedGo = join(dir, "bin", "native", nativeArtifactName("2.9.0", target));
  copyFileSync(goOverride, packagedGo);
  chmodSync(packagedGo, 0o755);
  return { dir, target, goOverride, packagedGo };
}

function runFixture(fixture, env) {
  const resultPath = join(fixture.dir, "result.txt");
  const result = spawnSync(process.execPath, [join(fixture.dir, "bin", "ocx.mjs"), "status", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, OPENCODEX_HOME: join(fixture.dir, "home"), OCX_TEST_RESULT: resultPath, ...env },
  });
  return { result, invocation: readFileSync(resultPath, "utf8") };
}

test("auto mode selects the exact package-local platform artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-native-resolver-"));
  try {
    const nativeDir = join(dir, "native");
    mkdirSync(nativeDir);
    const target = { os: "linux", arch: "arm64" };
    const binary = join(nativeDir, nativeArtifactName("2.9.0", target));
    writeFileSync(binary, "native");
    chmodSync(binary, 0o755);
    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "arm64" }), binary);
    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: { OPENCODEX_RUNTIME: "ts", OPENCODEX_GO_BINARY: binary }, platform: "linux", architecture: "arm64" }), null);
    assert.equal(isSupportedNativeTarget("linux", "arm64"), true);
    assert.equal(isSupportedNativeTarget("freebsd", "x64"), false);
    assert.throws(
      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: { OPENCODEX_RUNTIME: "ts" }, platform: "linux", architecture: "arm64", strictPackaged: true }),
      /OPENCODEX_RUNTIME=ts is not allowed/,
    );
    assert.throws(
      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: { OPENCODEX_GO_BINARY: binary }, platform: "linux", architecture: "arm64", strictPackaged: true }),
      /OPENCODEX_GO_BINARY is not allowed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native resolver rejects a symlinked packaged artifact", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-native-symlink-"));
  try {
    const nativeDir = join(dir, "native");
    mkdirSync(nativeDir);
    const target = { os: "linux", arch: "arm64" };
    const real = join(dir, "real");
    const linked = join(nativeDir, nativeArtifactName("2.9.0", target));
    writeFileSync(real, "native", { mode: 0o755 });
    chmodSync(real, 0o755);
    symlinkSync(real, linked);
    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "arm64" }), null);
    assert.throws(
      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "arm64", strictPackaged: true }),
      /missing, symlinked, or not executable/,
    );
    unlinkSync(linked);
    writeFileSync(linked, "native", { mode: 0o644 });
    chmodSync(linked, 0o644);
    assert.throws(
      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "arm64", strictPackaged: true }),
      /missing, symlinked, or not executable/,
    );
    unlinkSync(linked);
    const wrong = join(nativeDir, "ocx_wrong_linux_arm64");
    writeFileSync(wrong, "native", { mode: 0o755 });
    chmodSync(wrong, 0o755);
    assert.throws(
      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "arm64", strictPackaged: true }),
      /missing, symlinked, or not executable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher executes an explicit Go binary and preserves argv and exit status", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-native-launcher-"));
  try {
    const fake = join(dir, "ocx-go");
    const argsPath = join(dir, "args.txt");
    writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$OCX_TEST_ARGS\"\nexit 23\n");
    chmodSync(fake, 0o755);
    const result = spawnSync(process.execPath, [launcher, "status", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, OPENCODEX_RUNTIME: "go", OPENCODEX_GO_BINARY: fake, OCX_TEST_ARGS: argsPath },
    });
    assert.equal(result.status, 23, result.stderr);
    assert.equal(readFileSync(argsPath, "utf8"), "status\n--json\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forced Go runtime fails closed when its binary is unavailable", () => {
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, OPENCODEX_RUNTIME: "go", OPENCODEX_GO_BINARY: join(tmpdir(), "missing-ocx-go") },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Go runtime/i);
  assert.doesNotMatch(result.stderr, /Bun binary missing|bun dependency/i);
});

test("real launcher preserves all native and TypeScript selection quadrants", { skip: !hostTarget() || process.platform === "win32" }, () => {
  const fixture = launcherFixture();
  try {
    let observed = runFixture(fixture, {});
    assert.equal(observed.result.status, 17, observed.result.stderr);
    assert.equal(observed.invocation, "go:status --json\n", "packaged Go + no env must select Go");

    unlinkSync(fixture.packagedGo);
    observed = runFixture(fixture, {});
    assert.equal(observed.result.status, 19, observed.result.stderr);
    assert.match(observed.invocation, /^ts:.*src\/cli\/index\.ts status --json\n$/, "missing Go + no env must fall back to TypeScript");

    observed = runFixture(fixture, { OPENCODEX_GO_BINARY: fixture.goOverride });
    assert.equal(observed.result.status, 17, observed.result.stderr);
    assert.equal(observed.invocation, "go:status --json\n", "explicit Go override must select Go");

    copyFileSync(fixture.goOverride, fixture.packagedGo);
    chmodSync(fixture.packagedGo, 0o755);
    observed = runFixture(fixture, { OPENCODEX_RUNTIME: "ts", OPENCODEX_GO_BINARY: fixture.goOverride });
    assert.equal(observed.result.status, 19, observed.result.stderr);
    assert.match(observed.invocation, /^ts:.*src\/cli\/index\.ts status --json\n$/, "forced TypeScript must ignore available Go binaries");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("internal GUI worker is marker-gated and terminalizes retained-worker failures", { skip: process.platform === "win32" }, () => {
  const fixture = launcherFixture();
  const home = join(fixture.dir, "home");
  const jobPath = join(home, "update-job.json");
  mkdirSync(home, { recursive: true });
  const runningJob = () => ({
    id: "424242", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    currentVersion: "2.9.0", latestVersion: "2.9.1", channel: "latest", installer: "npm",
    restart: true, command: "", log: [],
  });
  const invoke = (extraEnv = {}) => spawnSync(
    process.execPath,
    [join(fixture.dir, "bin", "ocx.mjs"), "__gui-update-worker", "424242", "latest", "restart"],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, OPENCODEX_HOME: home, ...extraEnv } },
  );
  try {
    writeFileSync(jobPath, JSON.stringify(runningJob()));
    let result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unauthorized/i);
    assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).status, "running");

    result = invoke({ OCX_INTERNAL_GUI_UPDATE_WORKER: "1" });
    assert.equal(result.status, 1);
    let saved = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(saved.status, "failed");
    assert.match(saved.error, /retained worker exited 19/);

    writeFileSync(jobPath, JSON.stringify(runningJob()));
    const bun = join(fixture.dir, "node_modules", "bun", "bin", "bun");
    writeFileSync(bun, `#!/bin/sh\nnode -e 'const fs=require("fs");const p=process.env.OCX_JOB_PATH;const j=JSON.parse(fs.readFileSync(p,"utf8"));j.status="succeeded";j.restarted=true;fs.writeFileSync(p,JSON.stringify(j));'\nexit 0\n#${"x".repeat(1_000_000)}`);
    chmodSync(bun, 0o755);
    result = invoke({ OCX_INTERNAL_GUI_UPDATE_WORKER: "1", OCX_JOB_PATH: jobPath });
    assert.equal(result.status, 0, result.stderr);
    saved = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.restarted, true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("supported npm packages keep update help inert and route package updates before Go", { skip: !hostTarget() || process.platform === "win32" }, () => {
  const base = mkdtempSync(join(tmpdir(), "ocx-npm-update-launcher-"));
  const dir = join(base, "node_modules", "@bitkyc08", "opencodex");
  const binDir = join(base, "fake-bin");
  const home = join(base, "home");
  const npmLog = join(base, "npm.log");
  const goLog = join(base, "go.log");
  try {
    mkdirSync(join(dir, "bin", "native"), { recursive: true });
    mkdirSync(join(dir, "src", "update"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    copyFileSync(launcher, join(dir, "bin", "ocx.mjs"));
    copyFileSync(join(root, "bin", "native-runtime.mjs"), join(dir, "bin", "native-runtime.mjs"));
    copyFileSync(join(root, "src", "update", "tray-update-plan.mjs"), join(dir, "src", "update", "tray-update-plan.mjs"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", type: "module", version: "2.9.0" }));
    const native = join(dir, "bin", "native", nativeArtifactName("2.9.0", hostTarget()));
    writeFileSync(native, "#!/bin/sh\nprintf 'go:%s\\n' \"$*\" >> \"$OCX_GO_LOG\"\nexit 17\n");
    chmodSync(native, 0o755);
    const npm = join(binDir, "npm");
    writeFileSync(npm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$OCX_NPM_LOG\"\nif [ \"$1\" = view ]; then printf '2.9.1\\n'; fi\nexit 0\n");
    chmodSync(npm, 0o755);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENCODEX_HOME: home,
      OCX_NPM_LOG: npmLog,
      OCX_GO_LOG: goLog,
    };
    const packageLauncher = join(dir, "bin", "ocx.mjs");
    const help = spawnSync(process.execPath, [packageLauncher, "update", "--help"], { encoding: "utf8", env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: ocx update/);
    assert.equal(existsSync(npmLog), false);
    assert.equal(existsSync(goLog), false);

    const update = spawnSync(process.execPath, [packageLauncher, "update", "--tag", "latest"], { encoding: "utf8", env });
    assert.equal(update.status, 0, update.stderr);
    assert.match(readFileSync(npmLog, "utf8"), /view @bitkyc08\/opencodex@latest version/);
    assert.match(readFileSync(npmLog, "utf8"), /install -g @bitkyc08\/opencodex@latest/);
    assert.equal(existsSync(goLog), false, "package update must not forward to Go");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// `--dry-run` is a planning flag in the Go CLI (go/internal/cli/update.go). Before this
// guard the launcher forwarded every non-help `update` to the real self-update, so asking
// for a plan replaced the user's package. The state assertions below are deliberately
// non-vacuous: durable files are pre-populated and their exact bytes are re-read after.
test("update --dry-run plans without mutating any durable state", { skip: !hostTarget() || process.platform === "win32" }, () => {
  const base = mkdtempSync(join(tmpdir(), "ocx-dry-run-launcher-"));
  const dir = join(base, "node_modules", "@bitkyc08", "opencodex");
  const binDir = join(base, "fake-bin");
  const home = join(base, "home");
  const npmLog = join(base, "npm.log");
  const goLog = join(base, "go.log");
  try {
    mkdirSync(join(dir, "bin", "native"), { recursive: true });
    mkdirSync(join(dir, "src", "update"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    copyFileSync(launcher, join(dir, "bin", "ocx.mjs"));
    copyFileSync(join(root, "bin", "native-runtime.mjs"), join(dir, "bin", "native-runtime.mjs"));
    copyFileSync(join(root, "src", "update", "tray-update-plan.mjs"), join(dir, "src", "update", "tray-update-plan.mjs"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", type: "module", version: "2.9.0" }));
    const native = join(dir, "bin", "native", nativeArtifactName("2.9.0", hostTarget()));
    writeFileSync(native, "#!/bin/sh\nprintf 'go:%s\\n' \"$*\" >> \"$OCX_GO_LOG\"\nexit 17\n");
    chmodSync(native, 0o755);
    const npm = join(binDir, "npm");
    writeFileSync(npm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$OCX_NPM_LOG\"\nif [ \"$1\" = view ]; then printf '2.9.1\\n'; fi\nexit 0\n");
    chmodSync(npm, 0o755);

    // Durable state a real update would rewrite or delete.
    const durable = {
      "service-state.json": JSON.stringify({ backend: "native" }),
      "tray-state.json": JSON.stringify({ installed: true }),
      "runtime-port.json": JSON.stringify({ port: 10100, pid: 424242 }),
      "codex-shim.json": JSON.stringify({ runtime: "stale" }),
    };
    for (const [name, content] of Object.entries(durable)) writeFileSync(join(home, name), content);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENCODEX_HOME: home,
      OCX_NPM_LOG: npmLog,
      OCX_GO_LOG: goLog,
    };
    const packageLauncher = join(dir, "bin", "ocx.mjs");

    for (const args of [
      ["update", "--dry-run"],
      ["update", "--dry-run", "--tag", "latest"],
      ["update", "--tag", "preview", "--dry-run"],
    ]) {
      const run = spawnSync(process.execPath, [packageLauncher, ...args], { encoding: "utf8", env });
      assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stdout, /Update plan \(dry run/);
      assert.equal(existsSync(goLog), false, `${args.join(" ")} must not forward to Go`);
      const npmCalls = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
      for (const call of npmCalls) {
        assert.match(call, /^view /, `dry run started a mutating npm command: ${call}`);
      }
      for (const [name, content] of Object.entries(durable)) {
        assert.equal(readFileSync(join(home, name), "utf8"), content, `${args.join(" ")} mutated ${name}`);
      }
    }

    // A value form must be rejected rather than silently treated as "execute".
    const rejected = spawnSync(process.execPath, [packageLauncher, "update", "--dry-run=false"], { encoding: "utf8", env });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /--dry-run/);
    const afterReject = existsSync(npmLog) ? readFileSync(npmLog, "utf8") : "";
    assert.equal(/install -g/.test(afterReject), false, "rejected argv must not reach a package install");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
