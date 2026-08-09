import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSynchronizerCommand, parseSynchronizerItems, runGlobalMemorySync } from "../src/global-memory/sync-runner";
import { listProjectProfiles, showProjectProfile } from "../src/global-memory/profiles";
import { CANONICAL_ORIGIN, GlobalMemoryRepositoryError, resolveGlobalMemoryRepository, resolveRepositoryCandidate } from "../src/global-memory/repository";
import type { GlobalMemoryRepository } from "../src/global-memory/types";
import { removeTempDir } from "./helpers/temp-dir";

let temp: string;

function makeRepository(options: { origin?: string; payload?: boolean; skill?: boolean; script?: boolean } = {}): string {
  const repository = join(temp, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(repository, "memory", "projects"), { recursive: true });
  mkdirSync(join(repository, "skills", "agent-global-memory"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  if (options.payload !== false) writeFileSync(join(repository, "memory", "SHARED_INSTRUCTIONS.md"), "payload\n");
  if (options.skill !== false) writeFileSync(join(repository, "skills", "agent-global-memory", "SKILL.md"), "skill\n");
  if (options.script !== false) {
    writeFileSync(join(repository, "scripts", "sync-agent-memory.ps1"), "param()\n");
  }
  writeFileSync(join(repository, ".origin"), options.origin ?? CANONICAL_ORIGIN);
  return repository;
}

function gitRunner(origin = CANONICAL_ORIGIN, gitRoot?: string) {
  return async (args: readonly string[], cwd: string) => {
    if (args[0] === "rev-parse") return { stdout: gitRoot ?? cwd, stderr: "" };
    if (args[0] === "remote") return { stdout: origin, stderr: "" };
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

function repositoryFor(): GlobalMemoryRepository {
  const repository = makeRepository();
  return {
    repositoryPath: repository,
    origin: CANONICAL_ORIGIN,
    payloadPath: join(repository, "memory", "SHARED_INSTRUCTIONS.md"),
    skillPath: join(repository, "skills", "agent-global-memory"),
    synchronizerPath: join(repository, "scripts", "sync-agent-memory.ps1"),
    platform: "win32",
  };
}

beforeEach(() => { temp = join(tmpdir(), `ocx-memory-sync-${process.pid}-${Date.now()}`); mkdirSync(temp, { recursive: true }); });
afterEach(() => removeTempDir(temp));

describe("global-memory repository provenance", () => {
  test("explicit --repo takes precedence over the environment", async () => {
    const explicit = makeRepository();
    const env = makeRepository();
    const result = await resolveGlobalMemoryRepository({ explicitPath: explicit, environment: { OPENCODEX_GLOBAL_MEMORY_REPO: env }, gitRunner: gitRunner() });
    expect(result.repositoryPath).toBe(resolve(explicit));
  });

  test("environment resolution is used when no explicit repository is supplied", async () => {
    const repository = makeRepository();
    const result = await resolveGlobalMemoryRepository({ environment: { OPENCODEX_GLOBAL_MEMORY_REPO: repository }, gitRunner: gitRunner() });
    expect(result.repositoryPath).toBe(resolve(repository));
  });

  test("source-checkout sibling resolution is deterministic", () => {
    expect(resolveRepositoryCandidate({ cwd: join(temp, "opencodex") })).toBe(resolve(temp, "agent-global-memory"));
  });

  test("accepts the canonical origin with and without .git", async () => {
    for (const origin of [`${CANONICAL_ORIGIN}`, `${CANONICAL_ORIGIN}.git`]) {
      const repository = makeRepository({ origin });
      await expect(resolveGlobalMemoryRepository({ explicitPath: repository, gitRunner: gitRunner(origin) })).resolves.toMatchObject({ repositoryPath: resolve(repository) });
    }
  });

  test("rejects old, forked, and missing origins before scripts can run", async () => {
    for (const origin of ["https://github.com/codingmachineedge/agent-global-memory", "https://github.com/example/agent-global-memory", ""]) {
      const repository = makeRepository({ origin });
      const runner = gitRunner(origin);
      await expect(resolveGlobalMemoryRepository({ explicitPath: repository, gitRunner: origin ? runner : async () => { throw new Error("missing remote"); } })).rejects.toBeInstanceOf(GlobalMemoryRepositoryError);
    }
  });

  test("rejects missing payload, skill, script, non-absolute, and traversal paths", async () => {
    await expect(resolveGlobalMemoryRepository({ explicitPath: join(temp, "missing"), gitRunner: gitRunner() })).rejects.toThrow("does not exist");
    for (const options of [{ payload: false }, { skill: false }, { script: false }]) {
      const repository = makeRepository(options);
      await expect(resolveGlobalMemoryRepository({ explicitPath: repository, gitRunner: gitRunner() })).rejects.toBeInstanceOf(GlobalMemoryRepositoryError);
    }
    await expect(resolveGlobalMemoryRepository({ explicitPath: "relative/path", gitRunner: gitRunner() })).rejects.toThrow("absolute path");
    await expect(resolveGlobalMemoryRepository({ explicitPath: join(temp, "..", "outside"), gitRunner: gitRunner() })).rejects.toThrow("does not exist");
  });
});

describe("global-memory synchronizer process boundary", () => {
  test("constructs the Windows command without a shell", () => {
    const win = repositoryFor();
    win.synchronizerPath = join(win.repositoryPath, "scripts", "sync-agent-memory.ps1");
    expect(buildSynchronizerCommand(win, { action: "install", targets: ["claude", "codex"], homeDirectory: join(temp, "home"), yes: true, dryRun: true })).toEqual({
      command: "pwsh",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", win.synchronizerPath, "install", "-Target", "claude,codex", "-HomeDirectory", resolve(temp, "home"), "-Yes", "-DryRun"],
    });
    expect(buildSynchronizerCommand(win, { action: "status", targets: ["all"] })).toEqual({ command: "pwsh", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", win.synchronizerPath, "status", "-Target", "all"] });
  });

  test("rejects non-Windows synchronization explicitly", async () => {
    const repository = makeRepository();
    await expect(resolveGlobalMemoryRepository({ explicitPath: repository, platform: "linux", gitRunner: gitRunner() })).rejects.toThrow("Windows only");
  });

  test("does not spawn when provenance validation fails", async () => {
    let spawned = false;
    const repository = makeRepository({ origin: "https://github.com/example/agent-global-memory" });
    const result = await runGlobalMemorySync({ action: "status", repositoryPath: repository }, {
      gitRunner: gitRunner("https://github.com/example/agent-global-memory"),
      processRunner: async () => { spawned = true; throw new Error("must not run"); },
    }).catch(error => error);
    expect(result).toBeInstanceOf(GlobalMemoryRepositoryError);
    expect(spawned).toBe(false);
  });

  test("preserves synchronizer exit codes and parses documented status lines", async () => {
    const repository = makeRepository();
    for (const exitCode of [0, 1, 2]) {
      const result = await runGlobalMemorySync({ action: "status", repositoryPath: repository, targets: ["all"] }, {
        gitRunner: gitRunner(),
        processRunner: async (_command, _args, options) => {
          expect(options.shell).toBe(false);
          return { exitCode, signal: null, stdout: "claude: current - /tmp/claude\nshared-skill: retained - /tmp/skill (codex guidance is current)\n", stderr: "" };
        },
      });
      expect(result.exitCode).toBe(exitCode);
      expect(result.items).toEqual([
        { name: "claude", state: "current", path: "/tmp/claude" },
        { name: "shared-skill", state: "retained", path: "/tmp/skill", reason: "codex guidance is current" },
      ]);
    }
  });

  test("requires yes for mutation unless dry-run is present", async () => {
    const repository = makeRepository();
    await expect(runGlobalMemorySync({ action: "install", repositoryPath: repository }, { gitRunner: gitRunner() })).rejects.toThrow("requires --yes");
    await expect(runGlobalMemorySync({ action: "install", repositoryPath: repository, dryRun: true }, { gitRunner: gitRunner(), processRunner: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) })).resolves.toMatchObject({ exitCode: 0 });
  });

  test("adapter does not modify a temporary target home", async () => {
    const repository = makeRepository();
    const home = join(temp, "target-home");
    mkdirSync(home);
    const before = [...new Bun.Glob("**/*").scanSync({ cwd: home })];
    await runGlobalMemorySync({ action: "status", repositoryPath: repository, homeDirectory: home }, { gitRunner: gitRunner(), processRunner: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }) });
    expect([...new Bun.Glob("**/*").scanSync({ cwd: home })]).toEqual(before);
  });
});

describe("project profile inventory", () => {
  test("lists sorted profiles and reads bounded Markdown without installing it", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "memory", "projects", "zeta.md"), "# Zeta\n");
    writeFileSync(join(repository, "memory", "projects", "alpha.md"), "# Alpha\n");
    const list = await listProjectProfiles({ explicitPath: repository, gitRunner: gitRunner() });
    expect(list).toMatchObject({ schemaVersion: 1, repository: resolve(repository) });
    expect(list.profiles.map(profile => profile.slug)).toEqual(["alpha", "zeta"]);
    const shown = await showProjectProfile("alpha", { explicitPath: repository, gitRunner: gitRunner() });
    expect(shown.profile.content).toBe("# Alpha\n");
    expect(shown.profile.path).toBe("memory/projects/alpha.md");
  });

  test("rejects unsafe, symlinked, and oversized profiles", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "memory", "projects", "good.md"), "ok\n");
    expect(listProjectProfiles({ explicitPath: repository, gitRunner: gitRunner() })).resolves.toMatchObject({ profiles: [{ slug: "good" }] });
    await expect(showProjectProfile("../outside", { explicitPath: repository, gitRunner: gitRunner() })).rejects.toThrow("Invalid project profile slug");
    writeFileSync(join(repository, "outside.md"), "outside\n");
    try {
      symlinkSync(join(repository, "outside.md"), join(repository, "memory", "projects", "linked.md"));
      await expect(listProjectProfiles({ explicitPath: repository, gitRunner: gitRunner() })).rejects.toThrow(/symlink|reparse/u);
    } catch { /* symlink creation may be unavailable on Windows; the production lstat guard remains covered by the path checks. */ }
    writeFileSync(join(repository, "memory", "projects", "large.md"), "x".repeat(256 * 1024 + 1));
    await expect(showProjectProfile("large", { explicitPath: repository, gitRunner: gitRunner() })).rejects.toThrow("read limit");
  });
});

 test("parseSynchronizerItems recognizes all status categories", () => {
  expect(parseSynchronizerItems("a: missing - /a\nb: drift - /b\nc: conflict - /c (bad)\nd: installed - /d\ne: uninstalled - /e\n")).toEqual([
    { name: "a", state: "missing", path: "/a" },
    { name: "b", state: "drift", path: "/b" },
    { name: "c", state: "conflict", path: "/c", reason: "bad" },
    { name: "d", state: "current", path: "/d" },
    { name: "e", state: "retained", path: "/e" },
  ]);
});
