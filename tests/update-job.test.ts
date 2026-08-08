import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  confirmRestartAfterUpdateForTests,
  findLiveProxyForUpdate,
  findNpmRecoveryLauncher,
  findNpmRecoveryLaunchers,
  finishGuiUpdateRestart,
  formatProxyStartLog,
  installerFailureAllowsRecovery,
  npmSelfUpdateRestartEvidence,
  readUpdateJob,
  recoverFailedGuiUpdateForTests,
  restartCommand,
  restartAfterUpdateForTests,
  scanTrustedRecoveryTreeForTests,
  staleActiveUpdateJobReason,
  startUpdateJob,
  UPDATE_JOB_LEGACY_STALE_MS,
  updateExecutionCommand,
  updateJobPath,
  type UpdateJobState,
} from "../src/update/job";
import { checkUpdatePackageIntegrity, updateCommand, updateCommandStr, updateSpawnTarget } from "../src/update/index";
import { OPENCODEX_RELEASE_NOTES_URL, OPENCODEX_RELEASE_NOTES_URL as RELEASE_NOTES_URL } from "../src/update/links";
import { isRealBunBinary, resolveBunCommand } from "../src/lib/bun-runtime";
import { removeTempDir } from "./helpers/temp-dir";

type SpawnResult = { status: number | null; stdout: string };
function fakeSpawn(result: SpawnResult): typeof import("node:child_process").spawnSync {
  return (() => ({ ...result, stderr: "", pid: 1, output: [], signal: null })) as never;
}

const prevHome = process.env.OPENCODEX_HOME;
let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `ocx-update-job-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.OPENCODEX_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  removeTempDir(dir);
});

describe("GUI update check", () => {
  test("surfaces an npm update with the launcher-safe command", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "npm",
      latestVersion: () => "2.6.18",
    });

    expect(result.canUpdate).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.command).toContain("ocx.mjs update --tag latest");
  });

  test("reports source checkouts as manual-only", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "source",
      latestVersion: () => "2.6.18",
    });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe("source_checkout");
    expect(result.command).toBe("git pull && bun install && bun run build:gui");
  });

  test("handles registry lookup failures without claiming an update", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "npm",
      latestVersion: () => null,
    });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe("latest_unavailable");
  });

  test("treats equal versions as already current", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "npm",
      latestVersion: () => "2.6.17",
    });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe("already_latest");
  });
});

describe("GUI update execution decisions", () => {
  test("npm worker uses the Node launcher update path", () => {
    const cmd = updateExecutionCommand("npm", "preview", "/pkg/bin/ocx.mjs");
    expect(cmd.bin).toMatch(/^node/);
    expect(cmd.args).toEqual(["/pkg/bin/ocx.mjs", "update", "--tag", "preview"]);
  });

  test("restart command separates service and direct proxy modes", () => {
    expect(restartCommand(true, "npm", "/pkg/bin/ocx.mjs")).toMatchObject({
      mode: "service",
      args: ["/pkg/bin/ocx.mjs", "service", "install"],
    });
    expect(restartCommand(false, "npm", "/pkg/bin/ocx.mjs")).toMatchObject({
      mode: "proxy",
      args: ["/pkg/bin/ocx.mjs", "start"],
    });
  });

  test("persists installer-derived job fields without raw cache paths or uid values", async () => {
    const rawPath = "/home/alice/.npm/_cacache/tmp/entry";
    const rawUid = "uid=1001";
    const job: UpdateJobState = {
      id: "sanitize-installer-output",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: `node ${rawPath}/bin/ocx.mjs update --tag latest`,
      releaseNotesUrl: "",
      log: [`npm failed at ${rawPath} ${rawUid}`],
      error: `installer stderr ${rawPath} ${rawUid}`,
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      serviceInstalledFn: () => false,
      readPidFn: () => null,
      waitForPort: async () => false,
      spawnStart: () => { throw new Error("must not spawn"); },
    });
    const persisted = JSON.stringify(readUpdateJob(job.id));
    expect(persisted).not.toContain("/home/alice");
    expect(persisted).not.toContain("_cacache");
    expect(persisted).not.toContain("uid=1001");
    expect(persisted).not.toContain("alice");
    expect(readUpdateJob(job.id)?.command).toContain("ocx.mjs update --tag latest");
  });

  test("normalizes the exact legacy release-notes URL without changing other job fields", () => {
    const now = new Date().toISOString();
    const legacy = {
      id: "legacy-url",
      status: "succeeded" as const,
      startedAt: now,
      updatedAt: now,
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest" as const,
      installer: "npm" as const,
      restart: false,
      command: "npm install -g @bitkyc08/opencodex@2.7.41",
      releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
      log: ["done"],
      exitCode: 0,
      restarted: true,
    };
    writeFileSync(updateJobPath(), `${JSON.stringify(legacy)}\n`);
    const loaded = readUpdateJob("legacy-url");
    expect(loaded?.releaseNotesUrl).toBe(OPENCODEX_RELEASE_NOTES_URL);
    expect(loaded).toMatchObject({ ...legacy, releaseNotesUrl: OPENCODEX_RELEASE_NOTES_URL });
    expect(Object.keys(loaded ?? {}).sort()).toEqual(Object.keys(legacy).sort());
  });

  test("new update results use the transferred repository release notes URL", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.7.40",
      detectInstall: () => "desktop",
      latestVersion: () => null,
    });
    expect(result.releaseNotesUrl).toBe(OPENCODEX_RELEASE_NOTES_URL);
  });

  test("source update advice keeps the checkout-native Bun command", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "0.0.0",
      detectInstall: () => "source",
      latestVersion: () => null,
    });
    expect(result.command).toBe("git pull && bun install && bun run build:gui");
    expect(result.command).not.toContain("lidge-jun");
  });

  test("recovery start logs label candidates without persisting launcher paths", () => {
    const retiredLauncher = "/Users/test/.npm-global/lib/node_modules/@bitkyc08/.opencodex-Ab12Cd34/bin/ocx.mjs";
    const line = formatProxyStartLog("npm", retiredLauncher, 10100);

    expect(line).toBe("Starting npm proxy from validated recovery candidate on port 10100.");
    expect(line).not.toContain(retiredLauncher);
    expect(line).not.toContain("/Users/test/");
  });

  test("finds a validated npm-retired launcher when the current package is partial", async () => {
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    const retiredRoot = join(scopeRoot, ".opencodex-Ab12Cd34");
    for (const [root, name, version] of [
      [currentRoot, "@bitkyc08/opencodex", "2.7.41"],
      [retiredRoot, "@bitkyc08/opencodex", "2.7.40"],
    ] as const) {
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
      writeFileSync(join(root, "bin", "ocx.mjs"), "#!/usr/bin/env node\n");
    }

    expect(await findNpmRecoveryLauncher(join(currentRoot, "bin", "ocx.mjs"), "2.7.40"))
      .toBe(realpathSync(join(retiredRoot, "bin", "ocx.mjs")));
  });

  test("rejects an npm-retired launcher with the wrong package identity", async () => {
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    const retiredRoot = join(scopeRoot, ".opencodex-Ab12Cd34");
    mkdirSync(join(retiredRoot, "bin"), { recursive: true });
    writeFileSync(join(retiredRoot, "package.json"), JSON.stringify({
      name: "untrusted-package",
      version: "2.7.40",
    }));
    writeFileSync(join(retiredRoot, "bin", "ocx.mjs"), "#!/usr/bin/env node\n");

    expect(await findNpmRecoveryLauncher(join(currentRoot, "bin", "ocx.mjs"), "2.7.40")).toBeNull();
  });

  test("rejects a recovery package with an untrusted-writable imported file", async () => {
    if (process.getuid?.() === undefined) return;
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    mkdirSync(join(currentRoot, "bin"), { recursive: true });
    mkdirSync(join(currentRoot, "src"), { recursive: true });
    writeFileSync(join(currentRoot, "package.json"), JSON.stringify({
      name: "@bitkyc08/opencodex",
      version: "2.7.40",
    }));
    writeFileSync(join(currentRoot, "bin", "ocx.mjs"), 'import "../src/runtime.mjs";\n');
    const imported = join(currentRoot, "src", "runtime.mjs");
    writeFileSync(imported, "process.exit(0);\n");
    chmodSync(imported, 0o666);
    let probed = false;

    expect(await findNpmRecoveryLaunchers(
      join(currentRoot, "bin", "ocx.mjs"),
      "2.7.40",
      async () => {
        probed = true;
        return true;
      },
    )).toEqual([]);
    expect(probed).toBe(false);
  });

  test("rejects a recovery package below an untrusted-writable path component", async () => {
    if (process.getuid?.() === undefined) return;
    const unsafeParent = join(dir, "world-writable-global");
    const scopeRoot = join(unsafeParent, "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    mkdirSync(join(currentRoot, "bin"), { recursive: true });
    writeFileSync(join(currentRoot, "package.json"), JSON.stringify({
      name: "@bitkyc08/opencodex",
      version: "2.7.40",
    }));
    writeFileSync(join(currentRoot, "bin", "ocx.mjs"), "process.exit(0);\n");
    chmodSync(unsafeParent, 0o777);
    let probed = false;

    expect(await findNpmRecoveryLaunchers(
      join(currentRoot, "bin", "ocx.mjs"),
      "2.7.40",
      async () => {
        probed = true;
        return true;
      },
    )).toEqual([]);
    expect(probed).toBe(false);
  });

  test("allows npm-generated symlinks that resolve inside a trusted recovery package", async () => {
    if (process.platform === "win32") return;
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    const dependencyBin = join(currentRoot, "node_modules", "bun", "bin", "bun.exe");
    const generatedBin = join(currentRoot, "node_modules", ".bin", "bun");
    mkdirSync(join(currentRoot, "bin"), { recursive: true });
    mkdirSync(join(currentRoot, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(currentRoot, "node_modules", "bun", "bin"), { recursive: true });
    writeFileSync(join(currentRoot, "package.json"), JSON.stringify({
      name: "@bitkyc08/opencodex",
      version: "2.7.40",
    }));
    writeFileSync(join(currentRoot, "bin", "ocx.mjs"), "process.exit(0);\n");
    writeFileSync(dependencyBin, "#!/usr/bin/env node\n");
    symlinkSync("../bun/bin/bun.exe", generatedBin);

    const launcher = realpathSync(join(currentRoot, "bin", "ocx.mjs"));
    expect(await findNpmRecoveryLaunchers(
      launcher,
      "2.7.40",
      async candidate => candidate === launcher,
    )).toEqual([launcher]);
  });

  test("rejects a recovery package symlink that leaves the candidate tree", async () => {
    if (process.platform === "win32") return;
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    const externalBin = join(dir, "external-tool");
    mkdirSync(join(currentRoot, "bin"), { recursive: true });
    mkdirSync(join(currentRoot, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(currentRoot, "package.json"), JSON.stringify({
      name: "@bitkyc08/opencodex",
      version: "2.7.40",
    }));
    writeFileSync(join(currentRoot, "bin", "ocx.mjs"), "process.exit(0);\n");
    writeFileSync(externalBin, "#!/usr/bin/env node\n");
    symlinkSync(externalBin, join(currentRoot, "node_modules", ".bin", "external-tool"));
    let probed = false;

    expect(await findNpmRecoveryLaunchers(
      join(currentRoot, "bin", "ocx.mjs"),
      "2.7.40",
      async () => {
        probed = true;
        return true;
      },
    )).toEqual([]);
    expect(probed).toBe(false);
  });

  test("skips a matching current package whose complete launcher runtime cannot load", async () => {
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    const retiredRoot = join(scopeRoot, ".opencodex-Ab12Cd34");
    for (const root of [currentRoot, retiredRoot]) {
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "@bitkyc08/opencodex",
        version: "2.7.40",
      }));
    }
    writeFileSync(join(currentRoot, "bin", "ocx.mjs"), 'import "../src/cli/index.ts";\n');
    writeFileSync(join(retiredRoot, "bin", "ocx.mjs"), "process.exit(0);\n");

    expect(await findNpmRecoveryLaunchers(join(currentRoot, "bin", "ocx.mjs"), "2.7.40"))
      .toEqual([realpathSync(join(retiredRoot, "bin", "ocx.mjs"))]);
  });

  test("bounds npm recovery candidates before running launcher probes", async () => {
    const scopeRoot = join(dir, "global", "@bitkyc08");
    const currentRoot = join(scopeRoot, "opencodex");
    const retiredRoots = [
      join(scopeRoot, ".opencodex-Ab12Cd34"),
      join(scopeRoot, ".opencodex-Ef56Gh78"),
      join(scopeRoot, ".opencodex-Ij90Kl12"),
    ];
    for (const root of [currentRoot, ...retiredRoots]) {
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "@bitkyc08/opencodex",
        version: "2.7.40",
      }));
      writeFileSync(join(root, "bin", "ocx.mjs"), "process.exit(0);\n");
    }
    const probed: string[] = [];

    const launchers = await findNpmRecoveryLaunchers(
      join(currentRoot, "bin", "ocx.mjs"),
      "2.7.40",
      async launcher => {
        probed.push(launcher);
        return true;
      },
    );

    expect(probed).toHaveLength(2);
    expect(launchers).toEqual(probed);
    expect(launchers[0]).toBe(realpathSync(join(currentRoot, "bin", "ocx.mjs")));
  });

  test("fails closed when the recovery-tree worker exceeds its hard deadline", () => {
    const blockingScan = join(dir, "blocking-recovery-tree-scan.mjs");
    writeFileSync(blockingScan, [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 60_000);",
      "",
    ].join("\n"));

    const startedAt = Date.now();
    const result = scanTrustedRecoveryTreeForTests(join(dir, "candidate"), {
      scanScript: blockingScan,
      timeoutMs: 250,
    });

    expect(result).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 5_000);

  test("only recovers after a clean installer exit", () => {
    expect(installerFailureAllowsRecovery("npm", {
      status: 1, signal: null, timedOut: false, treeExited: true,
    })).toBe(true);
    expect(installerFailureAllowsRecovery("npm", {
      status: 75, signal: null, timedOut: false, treeExited: true,
    })).toBe(false);
    expect(installerFailureAllowsRecovery("bun", {
      status: 75, signal: null, timedOut: false, treeExited: true,
    })).toBe(true);
    expect(installerFailureAllowsRecovery("bun", {
      status: 1, signal: null, timedOut: false, treeExited: false,
    })).toBe(false);
    expect(installerFailureAllowsRecovery("npm", {
      status: null, signal: "SIGTERM", timedOut: false, treeExited: true,
    })).toBe(false);
    expect(installerFailureAllowsRecovery("npm", {
      status: 1, signal: null, timedOut: true, treeExited: true,
    })).toBe(false);
  });

  test("proxy restart pins --port so post-update start does not hop to an ephemeral port", () => {
    const proxy = restartCommand(false, "npm", "/pkg/bin/ocx.mjs", 10100);
    expect(proxy.mode).toBe("proxy");
    expect(proxy.args).toEqual(["/pkg/bin/ocx.mjs", "start", "--port", "10100"]);
    expect(proxy.display).toContain("start --port 10100");
    // Service reinstall stays install-only at the argv level; wrappers bake --port via OCX_BAKE_PORT.
    expect(restartCommand(true, "npm", "/pkg/bin/ocx.mjs", 10100).args).toEqual([
      "/pkg/bin/ocx.mjs", "service", "install",
    ]);
  });

  test("restart waits on the captured pre-update port unconditionally and pins the spawn to it", async () => {
    // The stop-first update flow clears pid/runtime state before restartAfterUpdate runs,
    // so the wait must fire even with no readable pid — driven here via the io seam.
    const waited: Array<{ port: number; hostname: string; opts?: { killOcxHolders?: boolean; onlyKillPids?: number[] } }> = [];
    const spawned: Array<{ port?: number; launcher?: string }> = [];
    const job: UpdateJobState = {
      id: "restart-io",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.6.17",
      latestVersion: "2.6.18",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, {
      port: 12345,
      hostname: "127.0.0.1",
      recoveryLauncher: "/retired/bin/ocx.mjs",
    }, {
      serviceInstalledFn: () => false, // drive the proxy-mode branch regardless of host state
      waitForPort: async (port, hostname, opts) => {
        waited.push({
          port,
          hostname: hostname ?? "",
          opts: {
            killOcxHolders: opts?.killOcxHolders,
            onlyKillPids: opts?.onlyKillPids,
          },
        });
        return true;
      },
      spawnStart: (_job, _installer, port, launcher) => {
        spawned.push({ port, launcher });
      },
    });
    expect(waited).toEqual([{
      port: 12345,
      hostname: "127.0.0.1",
      opts: { killOcxHolders: false, onlyKillPids: [] },
    }]);
    expect(spawned).toEqual([{ port: 12345, launcher: "/retired/bin/ocx.mjs" }]);
  });

  test("restart reclaim allowlists only the trusted oldPid", async () => {
    const optsSeen: Array<{ killOcxHolders?: boolean; onlyKillPids?: number[] }> = [];
    const job: UpdateJobState = {
      id: "restart-oldpid",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.39",
      latestVersion: "2.7.40",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1", oldPid: 4242 }, {
      serviceInstalledFn: () => false,
      waitForPort: async (_port, _hostname, opts) => {
        optsSeen.push({
          killOcxHolders: opts?.killOcxHolders,
          onlyKillPids: opts?.onlyKillPids,
        });
        return true;
      },
      spawnStart: () => {},
    });
    expect(optsSeen).toEqual([{ killOcxHolders: true, onlyKillPids: [4242] }]);
  });

  test("service restart leaves a replacement PID untouched when it appears during port reclaim", async () => {
    let pidReads = 0;
    const job: UpdateJobState = {
      id: "restart-replacement-pid",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, {
      port: 10100,
      hostname: "127.0.0.1",
      oldPid: 111,
      recoveryLauncher: "/retired/bin/ocx.mjs",
    }, {
      serviceInstalledFn: () => true,
      readPidFn: () => (++pidReads === 1 ? 111 : 222),
      verifyPidIdentityFn: pid => pid,
      waitForPort: async () => true,
      runService: () => { throw new Error("must not reinstall over a replacement PID"); },
      spawnStart: () => { throw new Error("must not start over a replacement PID"); },
    });
    expect(pidReads).toBe(2);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("different identity-checked proxy PID") && line.includes("leaving it untouched"),
    )).toBe(true);
  });

  test("direct restart leaves a replacement PID untouched when it appears during port reclaim", async () => {
    let pidReads = 0;
    const job: UpdateJobState = {
      id: "restart-direct-replacement-pid",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, {
      port: 10100,
      hostname: "127.0.0.1",
      oldPid: 111,
      recoveryLauncher: "/retired/bin/ocx.mjs",
    }, {
      serviceInstalledFn: () => false,
      readPidFn: () => (++pidReads < 3 ? null : 222),
      verifyPidIdentityFn: pid => pid,
      waitForPort: async () => true,
      spawnStart: () => { throw new Error("must not start over a replacement PID"); },
    });
    expect(pidReads).toBe(3);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("different identity-checked proxy PID") && line.includes("leaving it untouched"),
    )).toBe(true);
  });

  test("direct restart treats an unverified pidfile PID as absent", async () => {
    const verified: number[] = [];
    let spawned = 0;
    const job: UpdateJobState = {
      id: "restart-unverified-pid",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, {
      port: 10100,
      hostname: "127.0.0.1",
      oldPid: 111,
      recoveryLauncher: "/retired/bin/ocx.mjs",
    }, {
      serviceInstalledFn: () => false,
      readPidFn: () => 222,
      verifyPidIdentityFn: pid => {
        verified.push(pid);
        return null;
      },
      waitForPort: async () => true,
      spawnStart: () => { spawned += 1; },
    });
    expect(verified).toEqual([222, 222, 222]);
    expect(spawned).toBe(1);
    const log = readUpdateJob(job.id)?.log ?? [];
    expect(log.some(line => line.includes("Stopping current proxy PID"))).toBe(false);
    expect(log.some(line => line.includes("different identity-checked proxy PID"))).toBe(false);
  });

  test("restart refuses to spawn when the captured port never becomes free", async () => {
    const spawned: Array<{ port?: number }> = [];
    const job: UpdateJobState = {
      id: "restart-busy",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.39",
      latestVersion: "2.7.40",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      serviceInstalledFn: () => false,
      waitForPort: async () => false,
      spawnStart: (_job, _installer, port) => {
        spawned.push({ port });
      },
    });
    expect(spawned).toEqual([]);
    const saved = readUpdateJob(job.id);
    expect(saved?.log.some(line => line.includes("still busy") && line.includes("not starting on another port"))).toBe(true);
  });

  test("service restart waits on the captured port and clears OCX_BAKE_PORT after install", async () => {
    const waited: Array<{ port: number; hostname: string }> = [];
    const bakeDuringInstall: string[] = [];
    const launchersDuringInstall: string[] = [];
    const job: UpdateJobState = {
      id: "restart-svc",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.26",
      latestVersion: "2.7.28",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const prev = process.env.OCX_BAKE_PORT;
    delete process.env.OCX_BAKE_PORT;
    try {
      await restartAfterUpdateForTests(job, {
        port: 18765,
        hostname: "127.0.0.1",
      }, {
        serviceInstalledFn: () => true,
        waitForPort: async (port, hostname) => {
          waited.push({ port, hostname: hostname ?? "" });
          expect(process.env.OCX_BAKE_PORT).toBeUndefined();
          return true;
        },
        runService: (_job, _bin, args) => {
          bakeDuringInstall.push(process.env.OCX_BAKE_PORT ?? "");
          launchersDuringInstall.push(args[0] ?? "");
          return { status: 0 };
        },
      });
      expect(waited).toEqual([{ port: 18765, hostname: "127.0.0.1" }]);
      expect(bakeDuringInstall).toEqual(["18765"]);
      expect(launchersDuringInstall).toHaveLength(1);
      expect(launchersDuringInstall[0]?.endsWith(join("bin", "ocx.mjs"))).toBe(true);
      expect(process.env.OCX_BAKE_PORT).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prev;
    }
  });

  test("retired recovery launchers never persist their path in an installed service", async () => {
    const spawned: Array<{ port?: number; launcher?: string }> = [];
    const job: UpdateJobState = {
      id: "restart-retired-direct",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));

    const startedPid = await restartAfterUpdateForTests(job, {
      port: 10100,
      hostname: "127.0.0.1",
      recoveryLauncher: "/scope/.opencodex-Ab12Cd34/bin/ocx.mjs",
    }, {
      serviceInstalledFn: () => true,
      waitForPort: async () => true,
      runService: () => { throw new Error("must not persist a temporary recovery path"); },
      spawnStart: (_job, _installer, port, launcher) => {
        spawned.push({ port, launcher });
        return 222;
      },
    });

    expect(startedPid).toBe(222);
    expect(spawned).toEqual([{
      port: 10100,
      launcher: "/scope/.opencodex-Ab12Cd34/bin/ocx.mjs",
    }]);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("temporary") && line.includes("installed service stopped"),
    )).toBe(true);
  });

  test("service reinstall failure falls back to a direct proxy start", async () => {
    const spawned: Array<{ port: number }> = [];
    const job: UpdateJobState = {
      id: "svc-fallback",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.26",
      latestVersion: "2.7.28",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 19999, hostname: "127.0.0.1" }, {
      serviceInstalledFn: () => true,
      waitForPort: async () => true,
      runService: () => ({ status: 1 }),
      spawnStart: (_job, _installer, port) => {
        spawned.push({ port: port ?? 0 });
      },
    });
    // The fallback must fire: direct proxy start instead of throwing.
    expect(spawned).toEqual([{ port: 19999 }]);
  });

  test("pre-update liveness retries a transient miss before classifying the proxy inactive", async () => {
    let probes = 0;
    const delays: number[] = [];
    const live = await findLiveProxyForUpdate({
      findLiveProxyFn: async () => (
        ++probes === 1 ? null : { pid: 111, port: 15432, hostname: "127.0.0.1", source: "runtime" as const }
      ),
      sleepMs: async ms => { delays.push(ms); },
    });
    expect(live).toEqual({ pid: 111, port: 15432, hostname: "127.0.0.1", source: "runtime" });
    expect(probes).toBe(2);
    expect(delays).toEqual([250]);
  });

  test("pre-update liveness retains a PID-verified runtime target after health misses", async () => {
    let probes = 0;
    const live = await findLiveProxyForUpdate({
      findLiveProxyFn: async () => {
        probes += 1;
        return null;
      },
      sleepMs: async () => {},
      readAlivePidFn: () => 111,
      verifyPidIdentityFn: pid => pid,
      readRuntimePortFn: expectedPid => (
        expectedPid === 111 ? { pid: 111, port: 16543, hostname: "127.0.0.1" } : null
      ),
    });
    expect(probes).toBe(3);
    // source is "runtime" because this fallback reports only what runtime-port.json
    // recorded for the verified PID — never the configured listen port.
    expect(live).toEqual({ pid: 111, port: 16543, hostname: "127.0.0.1", source: "runtime" });
  });

  test("failed install leaves an already-healthy proxy untouched", async () => {
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "failed-install-still-running",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => ({ pid: 111, version: "2.7.40" }),
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(recovery).toBe("still-running");
    expect(restartCalls).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("existing proxy remains healthy"))).toBe(true);
  });

  test("failed install does not start a proxy that was inactive before the update", async () => {
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "failed-install-inactive",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1" },
      false,
      {
        probeProxyIdentity: async () => { throw new Error("must not probe an inactive proxy"); },
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(recovery).toBe("not-needed");
    expect(restartCalls).toBe(0);
  });

  test("failed install retries a transient health miss before considering restart", async () => {
    let probes = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "failed-install-transient-probe",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => (++probes === 1 ? null : { pid: 111, version: "2.7.40" }),
        sleepMs: async () => {},
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(recovery).toBe("still-running");
    expect(probes).toBe(2);
    expect(restartCalls).toBe(0);
  });

  test("failed install preserves a captured PID only while it still identifies as OpenCodex", async () => {
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "failed-install-live-pid",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => null,
        verifyPidIdentityFn: pid => pid,
        sleepMs: async () => {},
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(recovery).toBe("still-running");
    expect(restartCalls).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("refusing an automatic restart"))).toBe(true);
  });

  test("failed install leaves a concurrently restored replacement proxy untouched", async () => {
    let probes = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "failed-install-concurrent-replacement",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => (
          ++probes <= 3 ? null : { pid: 222, version: "2.7.40" }
        ),
        verifyPidIdentityFn: () => null,
        sleepMs: async () => {},
        recoveryLaunchersFn: () => { throw new Error("must not resolve a launcher"); },
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(recovery).toBe("still-running");
    expect(probes).toBe(4);
    expect(restartCalls).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("replacement proxy became healthy"))).toBe(true);
  });

  test("failed install restores through the retired launcher after the old PID loses identity", async () => {
    let now = 0;
    let restarted = false;
    let recoveryLauncher: string | undefined;
    const job: UpdateJobState = {
      id: "failed-install-recovery",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => null,
        verifyPidIdentityFn: () => null,
        recoveryLaunchersFn: () => ["/retired/bin/ocx.mjs"],
        probeProxy: async () => restarted,
        restartAfterUpdateFn: async (_job, captured) => {
          recoveryLauncher = captured?.recoveryLauncher;
          restarted = true;
        },
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );
    expect(recovery).toBe("restarted");
    expect(recoveryLauncher).toBe("/retired/bin/ocx.mjs");
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("update itself still failed"))).toBe(true);
  });

  test("failed install stops an unhealthy recovery process before trying the next package", async () => {
    let now = 0;
    let activePid: number | null = null;
    const attempted: Array<string | undefined> = [];
    const killed: number[] = [];
    const runningPids = new Set<number>();
    const job: UpdateJobState = {
      id: "failed-install-recovery-fallback",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));

    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => null,
        serviceInstalledFn: () => false,
        readPidFn: () => activePid,
        verifyPidIdentityFn: pid => runningPids.has(pid) ? pid : null,
        recoveryLaunchersFn: () => ["/current/bin/ocx.mjs", "/retired/bin/ocx.mjs"],
        probeProxy: async () => activePid === 333 && runningPids.has(333),
        waitForPort: async () => true,
        spawnStart: (_job, _installer, _port, launcher) => {
          attempted.push(launcher);
          activePid = launcher === "/current/bin/ocx.mjs" ? 222 : 333;
          runningPids.add(activePid);
          const startedPid = activePid;
          return {
            pid: startedPid,
            sameGeneration: () => runningPids.has(startedPid),
          };
        },
        killProxyFn: pid => {
          killed.push(pid);
          runningPids.delete(pid);
          if (activePid === pid) activePid = null;
        },
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );

    expect(recovery).toBe("restarted");
    expect(attempted).toEqual(["/current/bin/ocx.mjs", "/retired/bin/ocx.mjs"]);
    expect(killed).toEqual([222]);
    expect(runningPids.has(222)).toBe(false);
    expect(runningPids.has(333)).toBe(true);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("trying candidate 2 of 2"))).toBe(true);
  });

  test("failed install stops trying candidates when a started PID has no OpenCodex identity", async () => {
    let now = 0;
    const attempted: Array<string | undefined> = [];
    const killed: number[] = [];
    const job: UpdateJobState = {
      id: "failed-install-unverified-pid",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));

    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => null,
        verifyPidIdentityFn: () => null,
        recoveryLaunchersFn: () => ["/current/bin/ocx.mjs", "/retired/bin/ocx.mjs"],
        probeProxy: async () => false,
        restartAfterUpdateFn: async (_job, captured) => {
          attempted.push(captured?.recoveryLauncher);
          return { pid: 222, sameGeneration: () => true };
        },
        killProxyFn: pid => { killed.push(pid); },
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );

    expect(recovery).toBe("failed");
    expect(attempted).toEqual(["/current/bin/ocx.mjs"]);
    expect(killed).toEqual([]);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("without a matching OpenCodex identity"),
    )).toBe(true);
  });

  test("failed install never kills a reused PID after the spawned process generation exits", async () => {
    let now = 0;
    const attempted: Array<string | undefined> = [];
    const killed: number[] = [];
    const job: UpdateJobState = {
      id: "failed-install-reused-generation",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));

    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => null,
        verifyPidIdentityFn: pid => pid === 222 ? pid : null,
        recoveryLaunchersFn: () => ["/current/bin/ocx.mjs", "/retired/bin/ocx.mjs"],
        probeProxy: async () => false,
        restartAfterUpdateFn: async (_job, captured) => {
          attempted.push(captured?.recoveryLauncher);
          return { pid: 222, sameGeneration: () => false };
        },
        killProxyFn: pid => { killed.push(pid); },
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );

    expect(recovery).toBe("failed");
    expect(attempted).toEqual(["/current/bin/ocx.mjs"]);
    expect(killed).toEqual([]);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("no longer matches the spawned process generation"),
    )).toBe(true);
  });

  test("failed install reports remediation when no runnable recovery package remains", async () => {
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "failed-install-no-candidate",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));

    const recovery = await recoverFailedGuiUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      true,
      {
        probeProxyIdentity: async () => null,
        verifyPidIdentityFn: () => null,
        sleepMs: async () => {},
        recoveryLaunchersFn: () => [],
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );

    expect(recovery).toBe("failed");
    expect(restartCalls).toBe(0);
    const log = readUpdateJob(job.id)?.log ?? [];
    expect(log.some(line => line.includes("Could not find a runnable current or npm-retired launcher"))).toBe(true);
    expect(log.some(line => line.includes("ocx start --port 10100"))).toBe(true);
  });

  test("restart confirmation fails when the proxy never becomes healthy", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-timeout",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.32",
      latestVersion: "2.7.33",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await confirmRestartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      probeProxy: async () => false,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
    });
    expect(ok).toBe(false);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
      error: "proxy restart never became healthy on 127.0.0.1:10100",
    });
  });

  test("restart confirmation fails when the proxy dies during the stability window", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-flap",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.32",
      latestVersion: "2.7.33",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await confirmRestartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      probeProxy: async () => now < 12_000,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
    });
    expect(ok).toBe(false);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
      error: "proxy restart became unhealthy on 127.0.0.1:10100",
    });
  });

  test("restart confirmation succeeds only after the proxy stays healthy through the stability window", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-ok",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.32",
      latestVersion: "2.7.33",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await confirmRestartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      probeProxy: async () => now >= 1_000,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
    });
    expect(ok).toBe(true);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("stayed healthy for 15s after restart"))).toBe(true);
  });

  test("npm finish skips redundant restart when service self-update left a replaced healthy proxy", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-skip-redundant",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: 222, version: "2.7.41" }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(ok).toBe(true);
    expect(restartCalls).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("skipping redundant restart") && line.includes("10100") && line.includes("pid changed"),
    )).toBe(true);
  });

  test("npm finish fails when stale PID survives a no-op explicit restart", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-stale-healthy",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        // Soft probe stays healthy (old process). Explicit restart is a no-op.
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: 111, version: "2.7.40" }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => {
          restartCalls += 1;
          now = 0;
        },
      },
    );
    expect(ok).toBe(false);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
    });
    expect(readUpdateJob(job.id)?.error).toContain("still the pre-update PID");
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("still the pre-update PID") && line.includes("performing explicit restart"),
    )).toBe(true);
  });

  test("npm finish succeeds when explicit restart yields a new PID at the target version", async () => {
    let now = 0;
    let restartCalls = 0;
    let livePid = 111;
    let liveVersion = "2.7.40";
    const job: UpdateJobState = {
      id: "npm-explicit-replaced",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: livePid, version: liveVersion }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => {
          restartCalls += 1;
          livePid = 222;
          liveVersion = "2.7.41";
          now = 0;
        },
      },
    );
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.status).not.toBe("failed");
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("Proxy restart confirmed") && line.includes("pid changed"),
    )).toBe(true);
  });

  test("npm finish fails when port reclaim leaves the pre-update proxy healthy", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "npm-reclaim-stale",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        // Direct path: reclaim failure returns without spawning a replacement.
        serviceInstalledFn: () => false,
        waitForPort: async () => false,
        spawnStart: () => {
          throw new Error("must not spawn when reclaim failed");
        },
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: 111, version: "2.7.40" }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );
    expect(ok).toBe(false);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
    });
    expect(readUpdateJob(job.id)?.error).toContain("still the pre-update PID");
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("still busy") && line.includes("not starting on another port"),
    )).toBe(true);
  });

  test("npm finish skips the soft probe for direct installs and restarts immediately", async () => {
    let now = 0;
    let restartCalls = 0;
    let nowBeforeRestart = -1;
    const job: UpdateJobState = {
      id: "npm-direct-immediate",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1" }, "npm", {
      serviceInstalledFn: () => false,
      probeProxy: async () => {
        // Only becomes healthy after the explicit restart (launcher printed `ocx start` only).
        return restartCalls > 0;
      },
      probeProxyIdentity: async () => (
        restartCalls > 0 ? { pid: 333, version: "2.7.41" } : null
      ),
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => {
        nowBeforeRestart = now;
        restartCalls += 1;
        now = 0;
      },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    // Soft probe-first must not run — otherwise the clock would advance before restart.
    expect(nowBeforeRestart).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("skipping redundant restart"))).toBe(false);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("npm self-update did not leave"))).toBe(false);
  });

  test("npm finish falls back to explicit restart when self-update left the proxy down", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-fallback-restart",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1" }, "npm", {
      serviceInstalledFn: () => true,
      // Soft probe times out (proxy down after npm update); confirm after explicit restart succeeds.
      probeProxy: async () => restartCalls > 0,
      probeProxyIdentity: async () => (
        restartCalls > 0 ? { pid: 444, version: "2.7.41" } : null
      ),
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => {
        restartCalls += 1;
        now = 0; // reset clock so post-restart health wait has a fresh window
      },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("performing explicit restart"),
    )).toBe(true);
  });

  test("bun finish always runs explicit restart even if a proxy is already healthy", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "bun-always-restart",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "bun",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1" }, "bun", {
      probeProxy: async () => true,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => { restartCalls += 1; },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("skipping redundant restart"))).toBe(false);
  });

  test("npmSelfUpdateRestartEvidence requires a PID change or target version", () => {
    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      { oldPid: 111 },
      { pid: 111, version: "2.7.41" },
    )).toMatchObject({ ok: false, reason: "still the pre-update PID" });

    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      { oldPid: 111 },
      { pid: 222, version: "2.7.41" },
    )).toMatchObject({ ok: true });

    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      {},
      { pid: null, version: "2.7.41" },
    )).toMatchObject({ ok: true });

    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      {},
      { pid: 222, version: "2.7.40" },
    )).toMatchObject({ ok: false });
  });

  test("a running job prevents a second update job", () => {
    const now = new Date().toISOString();
    const job: UpdateJobState = {
      id: "running",
      status: "running",
      startedAt: now,
      updatedAt: now,
      currentVersion: "2.6.17",
      latestVersion: "2.6.18",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "node /pkg/bin/ocx.mjs update --tag latest",
      releaseNotesUrl: OPENCODEX_RELEASE_NOTES_URL,
      log: [],
    };
    writeFileSync(updateJobPath(), `${JSON.stringify(job)}\n`);

    expect(() => startUpdateJob("latest", true)).toThrow("already running");
  });

  test("stale detection trusts a live PID and recovers dead or legacy workers", () => {
    const now = Date.now();
    const active = { status: "running" as const, pid: 321, updatedAt: new Date(0).toISOString() };
    expect(staleActiveUpdateJobReason(active, now, () => true)).toBeNull();
    expect(staleActiveUpdateJobReason(active, now, () => false)).toContain("PID 321");
    expect(staleActiveUpdateJobReason({
      status: "restarting",
      updatedAt: new Date(now - UPDATE_JOB_LEGACY_STALE_MS).toISOString(),
    }, now)).toContain("no worker PID");
    expect(staleActiveUpdateJobReason({
      status: "running",
      updatedAt: new Date(now - UPDATE_JOB_LEGACY_STALE_MS + 1).toISOString(),
    }, now)).toBeNull();
  });

  test("recovers a dead worker and persists the replacement worker PID", () => {
    const now = Date.now();
    const oldJob: UpdateJobState = {
      id: "dead-worker",
      status: "running",
      startedAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "bun",
      restart: true,
      command: "bun add -g @bitkyc08/opencodex@2.7.41",
      releaseNotesUrl: OPENCODEX_RELEASE_NOTES_URL,
      log: [],
      pid: 777,
    };
    writeFileSync(updateJobPath(), `${JSON.stringify(oldJob)}\n`);
    let unrefCalled = false;

    const started = startUpdateJob("latest", true, {
      nowMs: () => now,
      isProcessAliveFn: () => false,
      checkForUpdateFn: () => ({
        currentVersion: "2.7.40",
        latestVersion: "2.7.41",
        channel: "latest",
        installer: "bun",
        updateAvailable: true,
        canUpdate: true,
        command: "bun add -g @bitkyc08/opencodex@2.7.41",
        releaseNotesUrl: OPENCODEX_RELEASE_NOTES_URL,
      }),
      spawnWorkerFn: () => ({
        pid: 888,
        unref: () => { unrefCalled = true; },
        once: () => undefined,
      }),
    });

    expect(started.pid).toBe(888);
    expect(readUpdateJob(started.id)?.pid).toBe(888);
    expect(readUpdateJob(started.id)?.log.at(-1)).toContain("PID 888");
    expect(unrefCalled).toBe(true);
  });

  test("records a failed job when spawning the worker throws", () => {
    expect(() => startUpdateJob("latest", false, {
      checkForUpdateFn: () => ({
        currentVersion: "2.7.40",
        latestVersion: "2.7.41",
        channel: "latest",
        installer: "bun",
        updateAvailable: true,
        canUpdate: true,
        command: "bun add -g @bitkyc08/opencodex@2.7.41",
        releaseNotesUrl: OPENCODEX_RELEASE_NOTES_URL,
      }),
      spawnWorkerFn: () => { throw new Error("spawn denied"); },
    })).toThrow("Could not start update worker");
    expect(readUpdateJob()?.status).toBe("failed");
    expect(readUpdateJob()?.error).toContain("spawn denied");
  });
});

describe("immutable update target (WP160)", () => {
  test("a resolved version pins the install target instead of the movable tag", () => {
    expect(updateCommand("bun", "latest", "2.7.24").args).toEqual(["add", "-g", "@bitkyc08/opencodex@2.7.24"]);
    expect(updateCommand("npm", "latest", "2.7.24").args).toEqual(["install", "-g", "@bitkyc08/opencodex@2.7.24"]);
    expect(updateCommandStr("bun", "latest", "2.7.24")).toContain("@bitkyc08/opencodex@2.7.24");
    // Unknown version falls back to the tag (best-effort lane).
    expect(updateCommand("bun", "latest").args).toEqual(["add", "-g", "@bitkyc08/opencodex@latest"]);
    expect(updateCommand("bun", "latest", null).args).toEqual(["add", "-g", "@bitkyc08/opencodex@latest"]);
  });

  test("bun worker execution pins the resolved version through updateExecutionCommand", () => {
    const cmd = updateExecutionCommand("bun", "latest", "/pkg/bin/ocx.mjs", "2.7.24");
    expect(cmd.args).toEqual(["add", "-g", "@bitkyc08/opencodex@2.7.24"]);
    expect(cmd.display).toContain("@2.7.24");
  });

  // `add -g <pkg>` is Bun's spelling, so whatever runs it has to be Bun. Both update
  // paths used to substitute `process.execPath` on Windows and keep those arguments,
  // which is only correct while the caller happens to run on Bun (it does, via
  // bin/ocx.mjs) — an unstated, unchecked invariant. These assert the *pairing*
  // rather than a literal path, because the pairing is what must never break.
  test("the bun update never pairs a non-bun binary with bun's arguments", () => {
    const cmd = updateExecutionCommand("bun", "latest", "/pkg/bin/ocx.mjs", "2.7.24");
    const binary = cmd.bin.toLowerCase();

    expect(cmd.args[0]).toBe("add");
    expect(`${binary} runs "add": ${binary === "bun" || /bun(\.exe)?$/.test(binary)}`)
      .toBe(`${binary} runs "add": true`);

    // Never a different interpreter, whose only response to `add -g` is to look for
    // a script named "add".
    expect(binary.endsWith("node.exe")).toBe(false);
    expect(binary.endsWith("electron.exe")).toBe(false);
  });

  test("the CLI update path resolves bun the same way, and fails closed when it cannot", () => {
    const resolved = "C:\\Users\\dev\\.bun\\bin\\bun.exe";
    const args = ["add", "-g", "@bitkyc08/opencodex@2.7.24"];

    // Resolved: the absolute Bun runs Bun's arguments, verbatim and unwrapped
    // (a real .exe needs no cmd.exe line the way npm.cmd does).
    expect(updateSpawnTarget("bun", args, () => resolved)).toEqual({
      bin: resolved,
      args,
      options: {},
    });

    // Unresolvable: null, so runUpdate aborts BEFORE stopping the proxy rather than
    // spawning something that cannot possibly perform the update.
    expect(updateSpawnTarget("bun", args, () => null)).toBeNull();

    // A non-installer binary is passed through untouched.
    expect(updateSpawnTarget("sh", ["-lc", "true"], () => null)).toEqual({
      bin: "sh",
      args: ["-lc", "true"],
      options: {},
    });
  });

  test("resolveBunCommand prefers a real bun and refuses to stand in another runtime", () => {
    const bundled = "C:\\pkg\\node_modules\\bun\\bin\\bun.exe";
    const bunOnPath = "C:\\Users\\dev\\.bun\\bin\\bun.exe";
    const cwd = "C:\\work\\untrusted-project";
    const env = {
      PATH: `${cwd};C:\\Users\\dev\\.bun\\bin`,
      PATHEXT: ".EXE",
    };
    const never = () => {
      throw new Error("should not be consulted");
    };

    // The bundled binary wins: it ships with the package and survives `ocx update`.
    expect(resolveBunCommand("win32", env, { bundled: () => bundled, underBun: never }))
      .toBe(bundled);

    // No bundled copy, but this process IS Bun — then its own executable is Bun.
    expect(resolveBunCommand("win32", env, {
      bundled: () => null,
      underBun: () => true,
      execPath: "C:\\bun\\bun.exe",
    })).toBe("C:\\bun\\bun.exe");

    // The regression, stated directly: running on some other interpreter, its
    // execPath is NOT offered up as bun, however large the file is.
    expect(resolveBunCommand("win32", { PATH: "", PATHEXT: ".EXE" }, {
      bundled: () => null,
      underBun: () => false,
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      isRealBun: () => true,
    })).toBeNull();

    // Last resort is a trusted absolute PATH entry — and the launch directory is
    // skipped there exactly as it is for npm.
    expect(resolveBunCommand("win32", env, {
      bundled: () => null,
      underBun: () => false,
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cwd,
      exists: (path: string) => path === bunOnPath || path === `${cwd}\\bun.exe`,
      isRealBun: () => true,
    })).toBe(bunOnPath);

    expect(resolveBunCommand("win32", env, {
      bundled: () => null,
      underBun: () => false,
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cwd,
      exists: (path: string) => path === `${cwd}\\bun.exe`,
      isRealBun: () => true,
    })).toBeNull();

    // POSIX keeps the bare name: a bun global install puts it on PATH by
    // construction, and there is no cwd-first lookup to defeat.
    expect(resolveBunCommand("linux", env, { bundled: never, underBun: never })).toBe("bun");
  });

  test("isRealBunBinary is a stub gate, not an identity check — so it cannot guard this", () => {
    // Why resolveBunCommand tests `runningUnderBun()` instead of reusing the size
    // gate: the gate exists to tell a real binary from the `bun` package's ~450-byte
    // placeholder stub, and any other runtime's executable clears it just as easily.
    const bigNonBun = join(dir, "node.exe");
    writeFileSync(bigNonBun, Buffer.alloc(2_000_000));
    expect(isRealBunBinary(bigNonBun)).toBe(true);
  });

  test("integrity pre-flight passes on a valid sha512 SRI and on multi-token metadata", () => {
    const single = checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "sha512-AbC123+/=\n" }));
    expect(single).toEqual({ ok: true, integrity: "sha512-AbC123+/=" });

    const multi = checkUpdatePackageIntegrity("2.7.24", fakeSpawn({
      status: 0,
      stdout: '"sha1-old sha512-GoodToken+/= sha256-other"\n',
    }));
    expect(multi).toEqual({ ok: true, integrity: "sha512-GoodToken+/=" });
  });

  test("transient registry failure skips the gate; anomalous metadata fails closed", () => {
    // Unknown version — registry unavailable lane.
    expect(checkUpdatePackageIntegrity(null).ok).toBe("skipped");

    // Nonzero exit and timeout (status null) are transient — skip, never abort.
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 1, stdout: "" })).ok).toBe("skipped");
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: null, stdout: "" })).ok).toBe("skipped");

    // Successful query with missing or non-sha512 metadata is the fail-closed lane.
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "" })).ok).toBe(false);
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "sha1-only" })).ok).toBe(false);
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "garbage!!" })).ok).toBe(false);
  });

  test("GUI worker gates integrity before spawning and fails the job on anomalous metadata", async () => {
    const source = await Bun.file(new URL("../src/update/job.ts", import.meta.url)).text();

    const gateAt = source.indexOf("const integrity = checkUpdatePackageIntegrity(check.latestVersion);");
    const failAt = source.indexOf('updateJob(job, { status: "failed", error: integrity.reason });');
    const spawnAt = source.indexOf("const result = await runLoggedProcessTreeCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS);");
    expect(gateAt).toBeGreaterThan(-1);
    expect(failAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(-1);
    // Gate and its failure return both precede the installer spawn.
    expect(gateAt).toBeLessThan(spawnAt);
    expect(failAt).toBeLessThan(spawnAt);
    // The job log records the verified-or-skipped integrity line at handoff.
    expect(source).toContain("integrity metadata ${integrity.integrity.slice(0, 24)}");
    expect(source).toContain("Integrity pre-flight skipped");
    // The bun lane pins the resolved version through updateExecutionCommand.
    expect(source).toContain("updateExecutionCommand(check.installer, channel, undefined, check.latestVersion)");
  });
});
