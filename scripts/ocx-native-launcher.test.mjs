import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { nativeArtifactName, resolveNativeGoBinary } from "../bin/native-runtime.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const launcher = join(root, "bin", "ocx.mjs");

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
