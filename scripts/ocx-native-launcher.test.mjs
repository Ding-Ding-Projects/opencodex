import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { nativeArtifactName, resolveNativeGoBinary } from "../bin/native-runtime.mjs";

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
