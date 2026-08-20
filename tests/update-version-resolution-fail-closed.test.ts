import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { latestVersion } from "../src/update/index";
import { parseConcreteUpdateVersion } from "../src/update/version-resolution.mjs";

const root = join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeRegistryResult(status: number | null, stdout = ""): typeof spawnSync {
  return (() => ({ status, stdout })) as unknown as typeof spawnSync;
}

const protectedState = {
  "service-state.json": '{"backend":"scheduler"}',
  "runtime-port.json": '{"port":10100,"pid":999999}',
  "ocx.pid": "999999",
} as const;

function runPackagedLauncherProbe(registry: "failed" | "malformed") {
  const temporary = mkdtempSync(join(tmpdir(), "ocx-update-resolution-"));
  temporaryDirectories.push(temporary);
  const packageRoot = join(temporary, "node_modules", "@bitkyc08", "opencodex");
  const fakeBin = join(temporary, "trusted-bin");
  const config = join(temporary, "config");
  const calls = join(temporary, "npm-calls.txt");

  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  mkdirSync(join(packageRoot, "src", "update"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(config, { recursive: true });
  copyFileSync(join(root, "bin", "ocx.mjs"), join(packageRoot, "bin", "ocx.mjs"));
  // The published launcher also performs the cache-ownership and process-tree
  // preflights. Copy those real runtime modules into the disposable package so
  // this probe exercises the same entrypoint a user downloads, not a half-built
  // fixture that fails before version resolution can run.
  for (const name of [
    "npm-invocation.mjs",
    "npm-cache-preflight.mjs",
    "install-process.mjs",
    "tray-update-plan.mjs",
    "version-resolution.mjs",
  ]) {
    copyFileSync(join(root, "src", "update", name), join(packageRoot, "src", "update", name));
  }
  mkdirSync(join(packageRoot, "src", "lib"), { recursive: true });
  for (const name of [
    "trusted-path.mjs",
    "bun-binary-validator.mjs",
    "bun-start-supervisor.mjs",
  ]) {
    copyFileSync(join(root, "src", "lib", name), join(packageRoot, "src", "lib", name));
  }
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "0.0.0", type: "module" }));

  for (const [name, contents] of Object.entries(protectedState)) {
    writeFileSync(join(config, name), contents);
  }

  const fakeNpm = join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  if (process.platform === "win32") {
    const registryResult = registry === "malformed"
      ? "echo 2.7.41\r\necho latest\r\nexit /b 0"
      : "exit /b 7";
    writeFileSync(fakeNpm, `@echo off\r\necho %*>>"%OCX_UPDATE_TEST_CALLS%"\r\n${registryResult}\r\n`);
  } else {
    const registryResult = registry === "malformed"
      ? "printf '2.7.41\\nlatest\\n'\nexit 0"
      : "exit 7";
    writeFileSync(fakeNpm, `#!/bin/sh\nprintf "%s\\n" "$*" >> "$OCX_UPDATE_TEST_CALLS"\n${registryResult}\n`);
    chmodSync(fakeNpm, 0o755);
  }

  const result = spawnSync(process.execPath, [join(packageRoot, "bin", "ocx.mjs"), "update"], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      OPENCODEX_HOME: config,
      OCX_UPDATE_TEST_CALLS: calls,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return {
    config,
    npmCalls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    output: `${result.stdout}\n${result.stderr}`,
    status: result.status,
  };
}

function expectNoLifecycleOrMutation(probe: ReturnType<typeof runPackagedLauncherProbe>): void {
  expect(probe.status).toBe(1);
  expect(probe.output).toContain("could not resolve a concrete registry version");
  expect(probe.output).not.toContain("Stopping the running proxy");
  expect(probe.npmCalls).toContain("view");
  expect(probe.npmCalls).toContain("@bitkyc08/opencodex@latest");
  expect(probe.npmCalls).toContain("version");
  expect(probe.npmCalls).not.toMatch(/\binstall\b/);
  for (const [name, contents] of Object.entries(protectedState)) {
    expect(readFileSync(join(probe.config, name), "utf8")).toBe(contents);
  }
}

describe("update registry-version resolution fails closed", () => {
  test("the shared parser accepts only stable and repository preview versions", () => {
    for (const version of ["0.0.0", "2.7.41", "2.7.41\n", "2.7.41\r\n", "10.20.30-preview.0\n"]) {
      expect(parseConcreteUpdateVersion(version)).toBe(version.replace(/\r?\n$/, ""));
    }
    for (const malformed of [
      "", "\n", " 2.7.41\n", "2.7.41 \n", "2.7.41\nlatest\n", "latest\n", "^2.7.41\n",
      "2.7.x\n", "2.7.41-rc.1\n", "2.7.41+build.1\n", "02.7.41\n", "2.07.41\n",
      "2.7.041\n", "2.7.41-preview.01\n", "2.7.41\0\n", "2.7.41\n\n",
    ]) {
      expect(parseConcreteUpdateVersion(malformed)).toBeNull();
    }
  });

  test("the Bun updater maps malformed, failed, timed-out, and thrown resolution to null", () => {
    expect(latestVersion("latest", fakeRegistryResult(0, "\n"))).toBeNull();
    expect(latestVersion("latest", fakeRegistryResult(0, " 2.7.41\n"))).toBeNull();
    expect(latestVersion("latest", fakeRegistryResult(0, "2.7.41\nlatest\n"))).toBeNull();
    expect(latestVersion("latest", fakeRegistryResult(1, "2.7.41\n"))).toBeNull();
    expect(latestVersion("latest", fakeRegistryResult(null, "2.7.41\n"))).toBeNull();
    expect(latestVersion("latest", (() => {
      throw new Error("spawn failed");
    }) as typeof spawnSync)).toBeNull();
    expect(latestVersion("latest", fakeRegistryResult(0, "2.7.41\n"))).toBe("2.7.41");
    expect(latestVersion("preview", fakeRegistryResult(0, "2.7.42-preview.3\r\n"))).toBe("2.7.42-preview.3");
  });

  test("the Bun updater rejects an unresolved version before every stop or mutation boundary", () => {
    const source = readFileSync(join(root, "src", "update", "index.ts"), "utf8");
    const resolutionAt = source.indexOf("const latest = latestVersion(tag);");
    const unresolvedGateAt = source.indexOf("if (!latest) {");
    const integrityAt = source.indexOf("const integrity = checkUpdatePackageIntegrity(latest);");
    const serviceAt = source.indexOf('await import("../service")');
    const trayAt = source.indexOf('await import("../tray/windows")');
    const stopAt = source.indexOf('[process.argv[1], "stop"]');
    const installAt = source.indexOf("runProcessTreeCommand(target.bin, target.args");

    expect(resolutionAt).toBeGreaterThan(-1);
    expect(unresolvedGateAt).toBeGreaterThan(resolutionAt);
    for (const boundary of [integrityAt, serviceAt, trayAt, stopAt, installAt]) {
      expect(boundary).toBeGreaterThan(unresolvedGateAt);
    }
    expect(source).toContain("aborting before stopping the tray, service, or proxy and before package replacement");
    expect(source).toContain("parseConcreteUpdateVersion(r.stdout)");
    expect(source).toContain("updateCommand(installer, tag, latest)");
  });

  test("the npm launcher exits after a failed registry query without stopping or installing", () => {
    expectNoLifecycleOrMutation(runPackagedLauncherProbe("failed"));
  });

  test("the npm launcher rejects malformed nonempty output without stopping or installing", () => {
    expectNoLifecycleOrMutation(runPackagedLauncherProbe("malformed"));
  });

  test("the npm launcher resolves and installs the same immutable version before lifecycle work", () => {
    const source = readFileSync(join(root, "bin", "ocx.mjs"), "utf8");
    const resolutionAt = source.indexOf("const latestResult = spawnSync(latestInvocation.file");
    const validationAt = source.indexOf("parseConcreteUpdateVersion(latestResult.stdout)");
    const unresolvedGateAt = source.indexOf("if (!latest) {");
    const exactInstallAt = source.indexOf('["install", "-g", `${PKG}@${latest}`]');
    const serviceAt = source.indexOf('const serviceStatePath = join(configDir(), "service-state.json")');
    const trayAt = source.indexOf("const trayBeforeUpdate = planWindowsTrayUpdate(");
    const stopAt = source.indexOf('[launcher, "stop"]');
    const mutationAt = source.indexOf("runProcessTreeCommand(installInvocation.file, installInvocation.args");

    expect(resolutionAt).toBeGreaterThan(-1);
    expect(validationAt).toBeGreaterThan(resolutionAt);
    expect(unresolvedGateAt).toBeGreaterThan(validationAt);
    expect(exactInstallAt).toBeGreaterThan(unresolvedGateAt);
    for (const boundary of [serviceAt, trayAt, stopAt, mutationAt]) {
      expect(boundary).toBeGreaterThan(exactInstallAt);
    }
    expect(source).not.toContain('["install", "-g", `${PKG}@${tag}`]');
  });
});
