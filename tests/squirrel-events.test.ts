/**
 * Squirrel install-time events.
 *
 * This is the part of the NSIS→Squirrel switch that fails silently and badly.
 * Squirrel has no wizard: it unpacks the app and runs it with a flag, four times
 * across install/update/uninstall. An app that does not answer starts its window,
 * its tray and a proxy bound to a port once per flag during a "silent" install —
 * and because Squirrel waits for the process to exit before deleting the
 * directory, a running proxy blocks its own uninstall.
 *
 * None of that shows up in a build log. The installer builds, the release
 * publishes, and the failure is on the user's machine.
 */

import { describe, expect, test } from "bun:test";
import { handleSquirrelEvent, planSquirrelEvent } from "../electron/squirrel.mjs";

type ReleaseWorkflowStep = {
  name?: string;
  run?: string;
};

type ReleaseWorkflow = {
  jobs?: Record<string, { steps?: ReleaseWorkflowStep[] }>;
};

function continuedShellCommand(script: string, command: string): string {
  const lines = script.split(/\r?\n/);
  const start = lines.findIndex(line => line.trimStart().startsWith(command));
  if (start < 0) return "";

  const commandLines = [lines[start]!];
  while (commandLines.at(-1)?.trimEnd().endsWith("\\") && start + commandLines.length < lines.length) {
    commandLines.push(lines[start + commandLines.length]!);
  }
  return commandLines.join("\n");
}

function commandUsesVariable(command: string, variable: string): boolean {
  return new RegExp(`\\$(?:${variable}\\b|\\{${variable}(?:\\[[^\\]]+\\])?\\})`).test(command);
}

function populatedVariable(script: string, requiredText: RegExp): string | undefined {
  for (const line of script.split(/\r?\n/)) {
    if (!line.includes("find")) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (assignment && requiredText.test(line)) return assignment[1];
    const arrayLoad = line.match(/^\s*(?:mapfile|readarray)\s+-t\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (arrayLoad && requiredText.test(line)) return arrayLoad[1];
  }
  return undefined;
}

function expectPublishedSquirrelAssets(step: ReleaseWorkflowStep, label: string): void {
  const run = String(step.run ?? "");
  const command = continuedShellCommand(run, "gh release create");

  expect(command, `${label} must publish a GitHub release`).not.toBe("");
  expect(run, `${label} must locate the Squirrel setup executable recursively`).toMatch(
    /find[^\n]*dist-desktop[^\n]*-name\s+['"][^'"]*Setup[^'"]*\.exe['"]/,
  );
  expect(run, `${label} must select the full Squirrel package`).toContain("*-full.nupkg");
  expect(run, `${label} must select the Squirrel release index`).toMatch(
    /-name\s+['"]?RELEASES['"]?|[A-Za-z_][A-Za-z0-9_]*=.*RELEASES/,
  );
  expect(run, `${label} must fail closed when a required asset is missing`).toContain("exit 1");

  const installerVariable = populatedVariable(run, /Setup[^\n]*\.exe/);
  expect(installerVariable, `${label} must bind the setup path before publishing`).toBeDefined();
  expect(
    commandUsesVariable(command, installerVariable ?? "__missing_installer__"),
    `${label} must attach the setup executable to gh release create`,
  ).toBe(true);

  const releaseIndexVariable = populatedVariable(run, /RELEASES/);
  const fullPackageVariable = populatedVariable(run, /\*-full\.nupkg/);
  const allPackageVariable = populatedVariable(run, /-name\s+['"]\*\.nupkg['"]/);
  const attachedArrays = [...command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g)]
    .map(match => match[1]!)
    .filter(variable => new RegExp(`\\b${variable}\\s*\\+=\\s*\\(`).test(run));
  const feedFind = run.split(/\r?\n/).some(
    line =>
      line.includes("find") &&
      line.includes("RELEASES") &&
      (line.includes("*-full.nupkg") || line.includes("*.nupkg")),
  );
  const namedAssetsAttached =
    releaseIndexVariable !== undefined &&
    fullPackageVariable !== undefined &&
    commandUsesVariable(command, releaseIndexVariable) &&
    (commandUsesVariable(command, fullPackageVariable) ||
      (allPackageVariable !== undefined && commandUsesVariable(command, allPackageVariable)));
  // A feed array may collect only `*-full.nupkg`, or collect all packages and
  // separately classify + require the full package before publication. Both
  // routes attach the required full package; neither accepts a delta alone.
  const feedArrayAttached = attachedArrays.length > 0 && feedFind;

  expect(
    namedAssetsAttached || feedArrayAttached,
    `${label} must attach RELEASES and the full .nupkg to gh release create`,
  ).toBe(true);
}

/** A realistic Squirrel layout: Update.exe sits above the versioned app dir. */
const EXEC = "C:\\Users\\x\\AppData\\Local\\opencodex\\app-2.7.42\\opencodex.exe";
const UPDATE = "C:\\Users\\x\\AppData\\Local\\opencodex\\Update.exe";

function run(event: string | null, overrides: Record<string, unknown> = {}) {
  const spawned: Array<{ bin: string; args: string[] }> = [];
  const exits: number[] = [];
  const deferred: Array<() => void> = [];
  const handled = handleSquirrelEvent({
    argv: event === null ? ["electron.exe"] : ["electron.exe", event],
    execPath: EXEC,
    platform: "win32",
    spawn: (bin: string, args: string[]) => { spawned.push({ bin, args }); return { unref() {} }; },
    exit: (code: number) => { exits.push(code); },
    // Captured rather than timed, so the test never waits a real second.
    delay: (fn: () => void) => { deferred.push(fn); },
    ...overrides,
  });
  return { handled, spawned, exits, flush: () => deferred.forEach(fn => fn()) };
}

describe("planning", () => {
  test("an ordinary launch is not a Squirrel event", () => {
    expect(planSquirrelEvent(["electron.exe"], EXEC, "win32")).toBeNull();
    expect(planSquirrelEvent(["electron.exe", "--some-other-flag"], EXEC, "win32")).toBeNull();
  });

  test("Update.exe is derived one level above the versioned app directory", () => {
    // Squirrel guarantees this layout. Searching for an Update.exe instead could
    // find one belonging to a different Squirrel app entirely.
    const plan = planSquirrelEvent(["electron.exe", "--squirrel-install"], EXEC, "win32")!;
    expect(plan.updateExe).toBe(UPDATE);
    expect(plan.args).toEqual(["--createShortcut", "opencodex.exe"]);
  });

  test("non-Windows platforms are never Squirrel launches", () => {
    expect(planSquirrelEvent(["electron", "--squirrel-install"], "/usr/bin/x", "darwin")).toBeNull();
    expect(planSquirrelEvent(["electron", "--squirrel-install"], "/usr/bin/x", "linux")).toBeNull();
  });
});

describe("handling", () => {
  test("install and update create the shortcut, then exit", () => {
    for (const event of ["--squirrel-install", "--squirrel-updated"]) {
      const r = run(event);
      expect(r.handled).toBe(true);
      expect(r.spawned).toEqual([{ bin: UPDATE, args: ["--createShortcut", "opencodex.exe"] }]);
      r.flush();
      expect(r.exits).toEqual([0]);
    }
  });

  test("uninstall removes the shortcut, then exits", () => {
    const r = run("--squirrel-uninstall");
    expect(r.handled).toBe(true);
    expect(r.spawned).toEqual([{ bin: UPDATE, args: ["--removeShortcut", "opencodex.exe"] }]);
    r.flush();
    expect(r.exits).toEqual([0]);
  });

  test("obsolete exits without touching shortcuts", () => {
    // The outgoing version is being retired; the incoming one owns the
    // shortcuts. Removing them here would uninstall the shortcut of the version
    // that is replacing this one.
    const r = run("--squirrel-obsolete");
    expect(r.handled).toBe(true);
    expect(r.spawned).toEqual([]);
    r.flush();
    expect(r.exits).toEqual([0]);
  });

  test("an unrecognised squirrel flag still stops the app starting", () => {
    // A future Squirrel event must not fall through into a normal launch, which
    // is how one install becomes four proxies racing for one port.
    const r = run("--squirrel-something-new");
    expect(r.handled).toBe(true);
    expect(r.spawned).toEqual([]);
  });

  test("an ordinary launch is handled by nobody and starts the app", () => {
    const r = run(null);
    expect(r.handled).toBe(false);
    expect(r.spawned).toEqual([]);
    r.flush();
    expect(r.exits).toEqual([]);
  });

  test("a broken Update.exe still lets the process exit", () => {
    // Squirrel is blocked on this process. Throwing here would leave a
    // half-removed install and no way for the user to finish it.
    const r = run("--squirrel-uninstall", {
      spawn: () => { throw new Error("Update.exe is missing"); },
    });
    expect(r.handled).toBe(true);
    r.flush();
    expect(r.exits).toEqual([0]);
  });

  test("the exit is deferred, not immediate", () => {
    // Squirrel does not wait for the detached shortcut write, so exiting in the
    // same tick can race it away.
    const r = run("--squirrel-install");
    expect(r.exits).toEqual([]);
    r.flush();
    expect(r.exits).toEqual([0]);
  });
});

describe("the packaging metadata Squirrel needs", () => {
  test("an author is declared, because NuGet refuses to build without one", async () => {
    // Squirrel packages through `nuget pack`, which fails with a bare
    // "Authors is required." and no further context. `package.json` has never
    // carried an `author` — NSIS never asked for one, so nothing noticed until
    // the first Squirrel release build died on it.
    //
    // Cheap to guard and otherwise invisible: no typecheck, lint or unit test
    // reads this file, and the only thing that would catch it again is a failed
    // release, which is the most expensive place to learn it.
    // In `package.json`, specifically. Setting it via `extraMetadata` in
    // `electron-builder.yml` looks equivalent and is not: electron-builder reads
    // its app metadata from the original manifest before that merge, so the
    // build failed with the identical error and no new information.
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as { author?: unknown };
    expect(typeof pkg.author === "string" ? pkg.author.trim() : "").toBeTruthy();
  });

  test("the Windows target is squirrel, and the release ships its update feed", async () => {
    const yaml = await Bun.file(new URL("../electron-builder.yml", import.meta.url)).text();
    expect(yaml).toContain("target: squirrel");

    // A run artifact is recovery evidence, not a release asset. Parse each
    // publication step so an unrelated upload glob cannot make this pass while
    // the actual release ships only Setup.exe (or no installer at all).
    const publications = [
      {
        path: "../.github/workflows/auto-release.yml",
        job: "release",
        step: "Create the release",
      },
      {
        path: "../.github/workflows/release.yml",
        job: "publish",
        step: "Create GitHub release",
      },
      {
        path: "../.github/workflows/super-express-release.yml",
        job: "release",
        step: "Create the full GitHub release",
      },
    ];

    for (const publication of publications) {
      const workflow = Bun.YAML.parse(
        await Bun.file(new URL(publication.path, import.meta.url)).text(),
      ) as ReleaseWorkflow;
      const step = workflow.jobs?.[publication.job]?.steps?.find(
        candidate => candidate.name === publication.step,
      );
      expect(step, `${publication.path}:${publication.step} must exist`).toBeDefined();
      expectPublishedSquirrelAssets(step ?? {}, `${publication.path}:${publication.step}`);
    }
  });
});
