import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  SCRIPT_BINDINGS,
  callsTo,
  methodsOf,
  runEnforcePrTarget,
  type HarnessResult,
} from "./helpers/enforce-pr-target-harness";

/** Final enforcer comment body after pending/draft checkpoints. */
function lastEnforcerCommentBody(result: HarnessResult): string {
  const updates = callsTo(result, "issues.updateComment") as Array<{ body: string }>;
  if (updates.length > 0) return updates[updates.length - 1]!.body;
  const creates = callsTo(result, "issues.createComment") as Array<{ body: string }>;
  return creates[creates.length - 1]!.body;
}

const root = new URL("../", import.meta.url);
const doctorGuiIfChangedScript = fileURLToPath(new URL("../scripts/doctor-gui-if-changed.ts", import.meta.url));

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

/**
 * Extract one named step's raw YAML text (its "- name: X" line through the
 * line before the next step at the same indentation), by splitting on every
 * step boundary rather than searching for the name once. A step whose name
 * is a substring of another step's name, or of its own `run:` body, cannot
 * fool this the way `indexOf(name)` could.
 */
function workflowStep(workflow: string, namePattern: RegExp): string {
  const blocks = workflow.split(/\n {6}- name: /).slice(1);
  const match = blocks.find(block => namePattern.test(block.split("\n")[0]!.trim()));
  if (!match) {
    throw new Error(`no step matching ${namePattern} found in workflow`);
  }
  return match;
}

type WorkflowStep = {
  name?: string;
  uses?: string;
  if?: unknown;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  "continue-on-error"?: unknown;
};

type WorkflowJob = {
  "runs-on"?: unknown;
  steps?: WorkflowStep[];
};

type WorkflowDocument = {
  jobs?: Record<string, WorkflowJob>;
};

const uploadArtifactAction =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

function expectAlwaysAndNonMasking(step: WorkflowStep, label: string): void {
  expect(String(step.if ?? ""), `${label} must run after any earlier result`).toContain("always()");
  expect(step["continue-on-error"], `${label} must not mask the original job result`).toBe(true);
}

function expectRunMetadata(step: WorkflowStep, label: string): void {
  const run = String(step.run ?? "");
  const envEntries = Object.entries(step.env ?? {});
  const statusEnv = envEntries.find(([, value]) => String(value).includes("job.status"));

  expect(run, `${label} must write a metadata record`).toMatch(/run-metadata\.(?:json|txt)/i);
  expect(run, `${label} metadata must record the run id`).toContain("GITHUB_RUN_ID");
  expect(run, `${label} metadata must record the commit SHA`).toContain("GITHUB_SHA");
  expect(run, `${label} metadata must record the runner operating system`).toContain("RUNNER_OS");
  expect(run, `${label} metadata must record the runner architecture`).toContain("RUNNER_ARCH");
  expect(statusEnv, `${label} must bind job.status into the collector environment`).toBeDefined();
  expect(run, `${label} metadata must record the bound job status`).toContain(statusEnv?.[0] ?? "");
}

describe("GitHub Actions hardening", () => {
  test("Windows CI keeps bounded jobs and immutable action references", async () => {
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).toContain("name: Windows CI");
    expect(workflow).not.toContain("ubuntu-latest");
    expect(workflow).not.toContain("macos-latest");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).not.toContain("matrix:");
    expect(count(workflow, "timeout-minutes: 20")).toBe(1);
    expect(count(workflow, "timeout-minutes: 8")).toBe(1);
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("Windows CI runs no test, typecheck, or lint step", async () => {
    // No workflow gates a build or a release on a test/typecheck/lint verdict:
    // that checking moved to the developer's own machine, before the push.
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).not.toMatch(/^\s*-\s+name:\s*Typecheck\s*$/m);
    expect(workflow).not.toMatch(/^\s*-\s+name:\s*Test\s*$/m);
    expect(workflow).not.toMatch(/^\s*-\s+name:\s*GUI tests\s*$/m);
    expect(workflow).not.toMatch(/^\s*-\s+name:\s*Privacy scan\s*$/m);
    expect(workflow).not.toContain("bun test --isolate tests");
    expect(workflow).not.toContain("bun run privacy:scan");
    expect(workflow).not.toContain("bun x tsc --noEmit");
  });

  /**
   * The repository-wide version of the two tests above: no workflow anywhere
   * under `.github/workflows/` invokes a test, typecheck, lint, or static-
   * analysis tool from a `run:` step, and no workflow's branch trigger still
   * names a retired branch. Parsed per-step rather than grepped, so a
   * forbidden command sitting inside a comment or a job-name string cannot
   * satisfy (or defeat) this the way a whole-file substring check could.
   */
  test("no workflow runs test/lint tooling, and no branch trigger names a retired branch", async () => {
    const workflowsDir = fileURLToPath(new URL(".github/workflows/", root));
    const files = (await readdir(workflowsDir)).filter(name => name.endsWith(".yml")).sort();
    expect(files.length).toBeGreaterThan(0);

    type TriggerDocument = {
      jobs?: Record<string, WorkflowJob>;
      on?: Record<string, { branches?: string[] } | null | undefined>;
    };

    const forbidden: Array<{ label: string; pattern: RegExp }> = [
      { label: "bun test", pattern: /\bbun test\b/ },
      { label: "go test", pattern: /\bgo test\b/ },
      { label: "tsc", pattern: /\btsc\b/ },
      { label: "eslint", pattern: /\beslint\b/ },
      { label: "go vet", pattern: /\bgo vet\b/ },
      { label: "-race", pattern: /-race\b/ },
      { label: "react-doctor", pattern: /\breact-doctor\b/ },
      { label: "privacy:scan", pattern: /privacy:scan/ },
    ];
    const retiredBranches = new Set(["dev", "dev2-go", "preview"]);

    const runOffenders: string[] = [];
    const branchOffenders: string[] = [];

    for (const file of files) {
      const text = await readText(`.github/workflows/${file}`);
      const parsed = Bun.YAML.parse(text) as TriggerDocument;

      for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.run !== "string") continue;
          for (const { label, pattern } of forbidden) {
            if (pattern.test(step.run)) {
              runOffenders.push(`${file}:${jobName}:${step.name ?? "(unnamed step)"} runs ${label}`);
            }
          }
        }
      }

      for (const [triggerName, trigger] of Object.entries(parsed.on ?? {})) {
        for (const branch of trigger?.branches ?? []) {
          if (retiredBranches.has(branch)) {
            branchOffenders.push(`${file}:on.${triggerName} names retired branch "${branch}"`);
          }
        }
      }
    }

    expect(runOffenders).toEqual([]);
    expect(branchOffenders).toEqual([]);
  });

  test("PR checks reach every branch the target gate accepts", async () => {
    // These two lists have to move together with enforce-pr-target.yml. main
    // is the only integration line, and a PR that passes the gate but
    // triggers no checks is worse than one that is blocked: it looks
    // reviewable and has nothing behind it. Pin the pull_request branch list
    // to the gate's allow-list, which is exactly main now.
    const gate = await readText(".github/workflows/enforce-pr-target.yml");
    const allowed = gate.match(/const ALLOWED_BASES = \[([^\]]*)\];/);
    expect(allowed).not.toBeNull();
    const bases = [...(allowed?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(bases).toEqual(["main"]);

    for (const path of [".github/workflows/ci.yml"]) {
      const workflow = Bun.YAML.parse(await readText(path)) as {
        on?: { pull_request?: Record<string, unknown> };
      };
      const trigger = workflow.on?.pull_request ?? {};
      const branches = (trigger.branches as string[] | undefined) ?? [];
      expect([...branches].sort()).toEqual(["main"]);

      // Narrowing a default is a mutation that deletes nothing. Omitting
      // `types` means opened + synchronize + reopened; writing
      // `types: [opened]` keeps the workflow, keeps the branch list, and stops
      // running checks on every commit pushed after the PR was opened — the
      // review then reads a green tick that belongs to an older tree. An
      // absent key is only pinned by asserting the key set, so assert it.
      expect(Object.keys(trigger).sort()).toEqual(["branches", "paths"]);
      if ("types" in trigger) {
        // If a future change genuinely needs `types`, it must still cover the
        // three events the default covers.
        expect([...(trigger.types as string[])].sort()).toEqual(["opened", "reopened", "synchronize"]);
      }
    }

    // main is the only integration and release-promotion branch, so push and
    // pull_request now target the identical single-branch list.
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      on?: {
        push?: { branches?: string[]; paths?: string[] };
        pull_request?: { paths?: string[] };
      };
    };
    expect([...(ci.on?.push?.branches ?? [])].sort()).toEqual(["main"]);

    // The path filter decides whether the job runs at all. Deleting one entry
    // deletes nothing visible: the workflow still exists, still lists the right
    // branches, and simply never fires for a PR that touches only that surface.
    // Round 16 dropped `src/**`, `tests/**`, and both workflow self-references
    // one at a time and the suite stayed green each time. Pin the list.
    const ciPaths = [
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/enforce-pr-target.yml",
      ".github/workflows/release.yml",
      ".github/workflows/stale-needs-info.yml",
      ".npmignore",
      "bin/**",
      "bun.lock",
      // go-ci.yml has no pull_request trigger, so this filter is the ONLY
      // pull-request coverage for Go changes. Dropping it would let a Go-only
      // PR merge with no cross-platform run at all.
      "go/**",
      "gui/**",
      "package.json",
      "scripts/**",
      "src/**",
      "tests/**",
      "tsconfig.json",
    ];
    expect([...(ci.on?.pull_request?.paths ?? [])].sort()).toEqual(ciPaths);
    // Push and pull_request have to cover the same surfaces, or a change lands
    // on dev having been checked on one trigger and not the other.
    expect([...(ci.on?.push?.paths ?? [])].sort()).toEqual(ciPaths);
  });

  test("Windows CI keeps the GUI build gate", async () => {
    // Review finding (PR #97): the GUI build gate was silently dropped once; assert the
    // enhanced gate (PR #99) stays wired so broken GUI builds cannot merge unnoticed.
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).toContain("- name: GUI build");
    expect(workflow).toContain("bun run build");
  });

  test("no workflow runs lint, so no lint verdict can withhold a build or a release", async () => {
    // Lint is deliberately not a gate anywhere. ESLint stays installed and is run
    // on demand (`bun run lint:gui`); nothing in Actions runs it.
    //
    // Assert against parsed steps rather than raw file text: the comments left where
    // the lint steps used to be mention `bun run lint:gui`, so a substring check over
    // the whole file would pass regardless of what the job actually runs.
    const runsLint = (step: WorkflowStep): boolean =>
      /\beslint\b|\brun\s+lint\b/.test(step.run ?? "");

    for (const path of [".github/workflows/ci.yml", ".github/workflows/gui-preview.yml"]) {
      const parsed = Bun.YAML.parse(await readText(path)) as WorkflowDocument;
      const lintSteps = Object.entries(parsed.jobs ?? {}).flatMap(([jobName, job]) =>
        (job.steps ?? [])
          .filter(runsLint)
          .map(step => `${jobName}:${step.name ?? "(unnamed)"}`),
      );
      expect(lintSteps, `${path} must not run lint`).toEqual([]);
    }
  });

  test("Windows producers retain safe artifacts after failures", async () => {
    const producers: Array<{ path: string; jobs: string[] }> = [
      { path: ".github/workflows/ci.yml", jobs: ["build", "npm-global-smoke"] },
      { path: ".github/workflows/release.yml", jobs: ["publish"] },
      { path: ".github/workflows/deploy-docs.yml", jobs: ["build"] },
      { path: ".github/workflows/auto-release.yml", jobs: ["release"] },
      { path: ".github/workflows/desktop-installer.yml", jobs: ["build"] },
      { path: ".github/workflows/gui-preview.yml", jobs: ["build"] },
      { path: ".github/workflows/super-express-release.yml", jobs: ["release"] },
    ];

    for (const producer of producers) {
      const workflow = Bun.YAML.parse(await readText(producer.path)) as WorkflowDocument;
      const artifactJobs = Object.entries(workflow.jobs ?? {})
        .filter(([, job]) => (job.steps ?? []).some(step => step.uses === uploadArtifactAction))
        .map(([jobName]) => jobName)
        .sort();
      expect(artifactJobs, `${producer.path} artifact-producing jobs changed`).toEqual(
        [...producer.jobs].sort(),
      );

      for (const jobName of producer.jobs) {
        const job = workflow.jobs?.[jobName];
        expect(job, `${producer.path}:${jobName} must exist`).toBeDefined();
        expect(job?.["runs-on"], `${producer.path}:${jobName} must run only on Windows`).toBe(
          "windows-latest",
        );

        const steps = job?.steps ?? [];
        const uploadIndexes = steps.flatMap((step, index) =>
          step.uses === uploadArtifactAction ? [index] : [],
        );
        expect(uploadIndexes.length, `${producer.path}:${jobName} must pin upload-artifact`).toBeGreaterThan(0);

        for (const uploadIndex of uploadIndexes) {
          const upload = steps[uploadIndex]!;
          const label = `${producer.path}:${jobName}:${upload.name ?? "artifact upload"}`;
          expectAlwaysAndNonMasking(upload, label);
          expect(upload.with?.["if-no-files-found"], `${label} must warn when no safe file exists`).toBe(
            "warn",
          );
          expect(Number(upload.with?.["retention-days"]), `${label} must use bounded retention`).toBeGreaterThan(0);

          const collector = steps
            .slice(0, uploadIndex)
            .reverse()
            .find(step => /^Collect\b/i.test(step.name ?? ""));
          expect(collector, `${producer.path}:${jobName} needs a collector before its upload`).toBeDefined();
          const collectorLabel = `${producer.path}:${jobName}:${collector?.name ?? "collector"}`;
          expectAlwaysAndNonMasking(collector ?? {}, collectorLabel);
          expectRunMetadata(collector ?? {}, collectorLabel);
        }
      }
    }

    const release = Bun.YAML.parse(await readText(".github/workflows/release.yml")) as WorkflowDocument;
    const releaseCollector = release.jobs?.publish?.steps?.find(step => step.name === "Collect release artifacts");
    expect(releaseCollector?.run).toContain("*.tgz");

    const desktop = Bun.YAML.parse(
      await readText(".github/workflows/desktop-installer.yml"),
    ) as WorkflowDocument;
    const desktopCollector = desktop.jobs?.build?.steps?.find(
      step => step.name === "Collect installer evidence",
    );
    expect(desktopCollector?.run).toContain("dist-desktop");
    expect(desktopCollector?.run).toContain(".nupkg");
    expect(desktopCollector?.run).toContain('$_.Name -eq "RELEASES"');
  });

  test("stale needs-info workflow is schedule-only and least-privilege", async () => {
    const text = await readText(".github/workflows/stale-needs-info.yml");
    const workflow = Bun.YAML.parse(text) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs?: Record<string, {
        steps?: Array<{
          name?: string;
          uses?: string;
          with?: Record<string, unknown>;
        }>;
      }>;
    };

    // Branch-selected workflow_dispatch would run an unreviewed YAML with write tokens.
    expect(workflow.on).toBeDefined();
    expect(Object.keys(workflow.on ?? {})).toEqual(["schedule"]);
    expect(workflow.permissions).toEqual({
      issues: "write",
      "pull-requests": "write",
    });
    expect(workflow.permissions).not.toHaveProperty("contents");

    const steps = workflow.jobs?.stale?.steps ?? [];
    expect(steps).toHaveLength(2);

    const ensureLabel = steps[0]!;
    expect(ensureLabel.name).toBe("Ensure stale label exists");
    expect(ensureLabel.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    const ensureScript = String(ensureLabel.with?.script ?? "");
    expect(ensureScript).toContain("createLabel");
    expect(ensureScript).toContain('const name = "stale"');
    expect(ensureScript).toContain("core.setFailed");
    expect(ensureScript).toContain("getLabel");

    const stale = steps[1]!;
    expect(stale.name).toBe("Mark and close inactive needs-info issues");
    expect(stale.uses).toBe("actions/stale@1e223db275d687790206a7acac4d1a11bd6fe629");
    expect(stale.with?.["only-issue-labels"]).toBe("needs-info");
    expect(stale.with?.["days-before-pr-stale"]).toBe(-1);
    expect(stale.with?.["days-before-pr-close"]).toBe(-1);
    expect(stale.with?.["remove-pr-stale-when-updated"]).toBe(false);
    expect(stale.with?.["days-before-issue-stale"]).toBe(14);
    expect(stale.with?.["days-before-issue-close"]).toBe(7);
    expect(stale.with?.["stale-issue-label"]).toBe("stale");
    expect(stale.with?.["exempt-issue-labels"]).toBeUndefined();
    expect(stale.with?.["remove-stale-when-updated"]).toBe(true);
    expect(text).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("service-lifecycle.yml stays deleted, not reintroduced by another name", async () => {
    // It was a test-only workflow (Windows Scheduled Tasks install/uninstall
    // smoke), and this project runs no tests in Actions. Pin the deletion
    // itself, the way the file inventory test below pins every survivor.
    await expect(Bun.file(new URL(".github/workflows/service-lifecycle.yml", root)).exists()).resolves.toBe(false);
    expect(await readText("scripts/release.ts")).not.toContain("service-lifecycle.yml");
  });

  test("release workflow publishes the exact SHA and channel without quality-gate waits or injection", async () => {
    const workflow = await readText(".github/workflows/release.yml");

    // Least privilege + never cancel a publish mid-flight.
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");

    // Dry-run first by default; tokenless trusted publishing only.
    expect(workflow).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");
    expect(workflow).toContain(
      "secrets.RELEASE_TOKEN || secrets.ORG_TOKEN || secrets.GITHUB_TOKEN",
    );

    // Every real publish is pinned to an explicitly supplied immutable commit.
    expect(workflow).toMatch(/expected-sha:[\s\S]*?required: true/);
    expect(workflow).toContain("ref: ${{ inputs.expected-sha }}");
    expect(workflow).toContain('checked_out_sha="$(git rev-parse HEAD)"');
    expect(workflow).toContain('gh release create "$release_tag" --target "$GITHUB_SHA"');

    // Immutable action references.
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Workflow-dispatch inputs must reach shell code via env, never by direct
    // interpolation into run: source (script-injection hardening).
    const runBlocks = workflow.split(/\n {6,}- name: /).filter(block => block.includes("run: |"));
    for (const block of runBlocks) {
      const runSource = block.slice(block.indexOf("run: |"));
      expect(runSource).not.toContain("${{ inputs.");
    }

    // Delivery never runs or waits for a code-quality workflow verdict.
    expect(workflow).not.toMatch(/gh run (?:list|watch)[^\n]*ci\.yml/);
    expect(workflow).not.toMatch(/(?:bun|npm|pnpm|yarn) (?:run )?(?:test|lint|typecheck)\b/);

    // Channel guard is branch-exact: main only, no preview branch or channel.
    expect(workflow).toContain("Release must run from main");
    expect(workflow).not.toContain("Release must run from main or preview");
    expect(workflow).toContain("main releases must use a stable semver version");
    expect(workflow).not.toContain("preview releases must use a preview prerelease version");
    expect(workflow).not.toContain("refs/heads/preview");
    expect(workflow).not.toMatch(/options:\s*\n\s*- latest\s*\n\s*- preview/);

    // Release notes must include PR categories and the full channel commit range
    // (branch merges + direct commits). Stable releases also carry matching preview notes.
    expect(workflow).toContain("releases/generate-notes");
    expect(workflow).toContain("git log --pretty=format:'- %s (%h)'");
    expect(workflow).toContain('commit_range="${notes_range_start}..${GITHUB_SHA}"');
    expect(workflow).toContain('previous_tag_name=${notes_range_start}');
    expect(workflow).toContain("skipping generate-notes (commits-only notes)");
    expect(workflow).toContain("bun scripts/release-notes.ts strip-carried");
    expect(workflow).toContain("bun scripts/release-notes.ts assemble");
    expect(workflow).toContain("bun scripts/release-notes.ts matching-preview-tags");
    expect(workflow).toContain("bun scripts/release-notes.ts previous-release-tag");
    expect(workflow).toContain("bun scripts/release-notes.ts has-meaningful");
    expect(workflow).toContain("bun scripts/release-notes.ts join-carried");
    // Preview notes must baseline any prior release (stable or preview), not preview-only.
    expect(workflow).toContain('bun scripts/release-notes.ts previous-release-tag "$RELEASE_VERSION"');
    expect(workflow).not.toMatch(
      /RELEASE_VERSION" == \*-preview\.\*[\s\S]{0,200}grep -- '-preview\\.'/,
    );
    expect(workflow).toContain("releases/tags/");
    expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}" --jq \'.full_name\'');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("operational error, not a missing release");
    expect(workflow).toContain("not an ancestor");
    expect(workflow).toContain("newest_carried_preview_tag");
    expect(workflow).not.toMatch(/newest_preview_tag="\$preview_carry_tag"/);
    expect(workflow).toContain("--commits");
    expect(workflow).toContain('git tag --list "v${RELEASE_VERSION}-preview.*"');
    expect(workflow).toContain("Carrying preview release notes from");
    // Every subcommand the workflow invokes must be dispatched by the CLI.
    const releaseNotesHelper = await readText("scripts/release-notes.ts");
    const invoked = [...workflow.matchAll(/bun scripts\/release-notes\.ts ([a-z-]+)/g)]
      .map(m => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);
    for (const cmd of new Set(invoked)) {
      expect(releaseNotesHelper).toContain(`"${cmd}"`);
    }
    expect(workflow).toMatch(/gh release create[\s\S]*?--notes-file "\$notes_file"/);
    expect(count(workflow, "gh release create")).toBe(1);
    expect(workflow).toContain('gh release edit "$release_tag" --notes-file "$notes_file"');
    expect(workflow).toContain("Workflow duration");
    expect(workflow).not.toContain("--generate-notes");
    // Notes must be assembled before tagging so a notes API failure does not leave
    // a remote tag that blocks release retries at preflight.
    const createStep = workflow.split("- name: Create/reconcile GitHub release")[1]!.split(/\n {6}- name:/)[0]!;
    const notesAssembly = createStep.split('git tag "$release_tag"')[0]!;
    // Preview carry lookup must use tag-specific API status, not `gh release view` stderr prose.
    expect(notesAssembly).toContain("releases/tags/");
    expect(notesAssembly).not.toContain("gh release view");
    // Fail closed: no soft-skip in any spelling around gh api calls in this step.
    for (const line of createStep.split("\n").filter(l => l.includes("gh api"))) {
      expect(line).not.toMatch(/\|\|\s*(true|echo|:)/);
    }
    expect(createStep).not.toContain("set +e\n            pr_notes");
    // Notes assembly's gh api reads land before the tag/release mutation, so a
    // notes-API failure never leaves a dangling tag with no release behind it.
    expect(createStep.indexOf("gh api")).toBeGreaterThan(-1);
    expect(createStep.indexOf('git tag "$release_tag"')).toBeGreaterThan(createStep.indexOf("gh api"));
    expect(createStep.indexOf('gh release create "$release_tag"')).toBeGreaterThan(
      createStep.indexOf('git tag "$release_tag"'),
    );
    // First-channel releases must not call generate-notes without an explicit baseline
    // (GitHub would otherwise pick the newest repo tag, possibly from the other channel).
    // Scope to the single if-block that owns generate-notes; createStep has two
    // `[ -n "$notes_range_start" ]` blocks, so an unanchored [\s\S]* can straddle them.
    const notesBlock = createStep
      .split(/if \[ -n "\$notes_range_start" \]; then/)[1]!
      .split(/\n {10}if \[/)[0]!;
    expect(notesBlock).toContain("previous_tag_name=${notes_range_start}");
    expect(notesBlock).toContain("skipping generate-notes");
    expect(notesBlock).toMatch(/\n {10}else\n/);
  });

  /**
   * `enforce-pr-target.yml` had no test at all, and it is the one workflow that
   * mutates a contributor's pull request — it rewrites the title and converts the
   * PR to a draft. It also runs on `pull_request_target`, so it holds the base
   * repository's write token while doing it.
   *
   * These assertions pin the CURRENT behaviour rather than a desired one. The
   * gate is being redesigned (devlog/_plan/260727_governance_intake/040), and a
   * redesign without a characterisation test is how the four review rounds on
   * that plan happened in the first place.
   *
   * They parse the workflow rather than grepping it. Two rounds of adversarial
   * mutation testing broke the string-matching version: `- run : echo pwn` and
   * `- 'uses': owner/action@feature` are valid YAML that no reasonable regex
   * catches, and `// await convertToDraft();` satisfies a substring check while
   * removing the behaviour. A parser sees keys, not spellings.
   */
  type WorkflowStep = Record<string, unknown> & {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  };
  type WorkflowJob = Record<string, unknown> & { "runs-on"?: unknown; steps?: WorkflowStep[] };
  type WorkflowShape = Record<string, unknown> & {
    on?: { pull_request_target?: { types?: string[] } };
    permissions?: Record<string, string> | string;
    concurrency?: Record<string, unknown> & { group?: string };
    jobs?: Record<string, WorkflowJob>;
  };

  async function readEnforcePrTarget(): Promise<{
    workflow: WorkflowShape;
    jobs: [string, WorkflowJob][];
    steps: WorkflowStep[];
    allSteps: WorkflowStep[];
    script: string;
  }> {
    const text = await readText(".github/workflows/enforce-pr-target.yml");
    const workflow = Bun.YAML.parse(text) as WorkflowShape;
    const jobs = Object.entries(workflow.jobs ?? {});
    const steps = workflow.jobs?.["enforce-target"]?.steps;
    expect(Array.isArray(steps)).toBe(true);
    // Every step of every job, so a second job cannot smuggle in an unchecked
    // one. `enforce-target` is not privileged here; it is just the one whose
    // script body the behavioural tests read.
    const allSteps = jobs.flatMap(([, job]) => job?.steps ?? []);
    const scriptStep = steps!.find(step => typeof step.with?.script === "string");
    expect(scriptStep).toBeDefined();
    const script = stripComments(String(scriptStep!.with!.script));
    return { workflow, jobs, steps: steps!, allSteps, script };
  }

  const SCRIPT_LOAD = ["require", "require"] as const;

  // There is no more ancestry check and no more permission lookup (the
  // permission lookup existed only to decide whether to skip ancestry): main
  // is the only allowed base, there is no second base to compare ancestry
  // against, and every scenario's reads collapse to the same shape whether
  // the base is allowed or not. `readsAllowedBase` and `readsWrongBase` keep
  // separate names at each call site to say which scenario is being read,
  // even though their bodies are now identical.

  /** Reads every PR performs before any enforcement writes. */
  function readsAllowedBase(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      ...tail,
    ];
  }

  /** Same reads for a PR whose base is outside the allow-list. */
  function readsWrongBase(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      ...tail,
    ];
  }

  /** Like readsAllowedBase but with a second listComments page from paginate. */
  function readsAllowedBasePaged(tail: string[] = []): string[] {
    return [
      ...SCRIPT_LOAD,
      "pulls.get",
      "issues.listComments",
      "issues.listComments",
      ...tail,
    ];
  }

  /**
   * Drop JavaScript comments so a commented-out call cannot satisfy a "calls X"
   * assertion. Both forms matter: an audit round removed the draft conversion
   * with `// await convertToDraft();` and then again with the block form
   * `/* await convertToDraft(); *\/`, and a line-only stripper caught just the
   * first.
   *
   * Quoting has to be tracked rather than pattern-matched. The script builds a
   * message containing `https://…`, so a naive `line.replace(/\/\/.*$/, "")`
   * truncates that string literal and quietly weakens everything after it.
   * Newlines are preserved so failure output still points at the right line.
   */
  function stripComments(source: string): string {
    let out = "";
    let quote: string | null = null;
    let block = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i]!;
      const next = source[i + 1];

      if (block) {
        if (char === "*" && next === "/") { block = false; i += 1; continue; }
        if (char === "\n") out += char;
        continue;
      }

      if (quote) {
        out += char;
        if (char === "\\") { if (next !== undefined) { out += next; i += 1; } continue; }
        if (char === quote) quote = null;
        continue;
      }

      if (char === '"' || char === "'" || char === "`") { quote = char; out += char; continue; }
      if (char === "/" && next === "*") { block = true; i += 1; continue; }
      if (char === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        out += "\n";
        continue;
      }
      out += char;
    }

    return out;
  }

  /**
   * Enumerate what the workflow IS, not what it must not be.
   *
   * Three audit rounds killed the deny-list approach. Each round the author
   * closed the named holes and each round the next auditor found more, because
   * "assert this key is absent" only ever covers keys someone thought of. Round
   * three alone landed fourteen: `if: false` on the job, `if: false` on the
   * step, `runs-on: self-hosted`, `container: node:22`, a `strategy.matrix`,
   * `outputs.leaked: ${{ github.token }}`, a `<<:` merge key that smuggles in
   * `if: false`, `github-token: ${{ secrets.SOME_PAT }}` beside `script`,
   * `result-encoding`, a job-level `env:` carrying the PR title, and
   * `cancel-in-progress`.
   *
   * Every one of those is a KEY THAT WAS NOT THERE BEFORE. So pin the key sets
   * exactly. A new key — any new key, including one invented after this test
   * was written — fails here and gets read by a human. That is the property a
   * characterisation test on a privileged workflow actually needs.
   */
  test("PR target enforcement's structure is an exact allowlist, not a deny-list", async () => {
    const { workflow, jobs, steps } = await readEnforcePrTarget();

    // Top level: these five keys and nothing else.
    expect(Object.keys(workflow).sort()).toEqual([
      "concurrency",
      "jobs",
      "name",
      "on",
      "permissions",
    ]);

    // pull_request_target runs with the base repo's token. Checking out or
    // executing the PR's code under it is the classic escalation.
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request_target"]);

    // And the trigger is exactly a `types:` list — nothing else.
    //
    // Every other level here is pinned by exact key-set equality; this one was
    // not, and a review round walked straight through the hole. `branches: [main]`
    // narrows the gate to PRs against `main`, so one opened against `preview`
    // sails past unenforced. `paths:` is worse: the gate then fires only when
    // particular files change, which on a docs-only PR means never. Both are
    // additive, both look like ordinary scoping in a diff, and neither failed a
    // single assertion.
    expect(Object.keys(workflow.on?.pull_request_target ?? {})).toEqual(["types"]);

    // Exactly the scopes this gate needs. `pull-requests: write` covers title
    // and comment updates. `contents: write` is required for the draft GraphQL
    // mutations with GITHUB_TOKEN (#626: "Resource not accessible by integration"
    // when contents was unset). Asserting the whole object pins both presence
    // and the absence of anything broader (write-all, contents alone, …).
    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });

    // One run per PR, so two rapid events cannot race on the title/draft state,
    // and no `cancel-in-progress` — cancelling the in-flight run mid-mutation is
    // how the bot ends up having prefixed the title but not recorded that it did.
    expect(workflow.concurrency).toEqual({
      group: "enforce-pr-target-${{ github.event.pull_request.number }}",
    });

    // One job, and it is this one. An audit round added a `sidecar:` job that
    // inherited the PR-write token and un-drafted the PR — every assertion below
    // still passed, because they only ever looked at `enforce-target`.
    expect(jobs.map(([name]) => name)).toEqual(["enforce-target"]);

    // The job is exactly a runner plus steps. No `if:` (which silently disables
    // the whole gate), no `permissions:` (a job-level block overrides the narrow
    // workflow-level one), no `container:`/`strategy:`/`outputs:`/`env:`/
    // `defaults:`, and no `<<:` merge key to reintroduce any of them sideways.
    const [, job] = jobs[0]!;
    expect(Object.keys(job).sort()).toEqual(["runs-on", "steps"]);
    expect(job["runs-on"]).toBe("windows-latest");

    // Checkout trusted scripts, then run the gate. Anything more is an extra
    // privileged action nobody reviewed.
    expect(steps).toHaveLength(2);
    const [checkout, scriptStep] = steps as [WorkflowStep, WorkflowStep];
    expect(Object.keys(checkout).sort()).toEqual(["name", "uses", "with"]);
    expect(checkout.uses).toBe(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
    expect(Object.keys(checkout.with ?? {}).sort()).toEqual([
      "persist-credentials",
      "ref",
      "sparse-checkout",
    ]);
    expect(checkout.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
      "sparse-checkout": ".github/scripts",
    });

    expect(Object.keys(scriptStep).sort()).toEqual(["name", "uses", "with"]);

    // `github-script` is the action, pinned to a 40-hex commit SHA: this
    // workflow hands a write token to whatever the ref resolves to, so a tag or
    // branch is a mutable dependency.
    expect(scriptStep.uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/);

    // `script` is the only input. `github-token:` swaps the restricted
    // `GITHUB_TOKEN` for an arbitrary PAT, and every other input changes how the
    // action behaves with that token in hand.
    expect(Object.keys(scriptStep.with ?? {})).toEqual(["script"]);
  });

  /**
   * `${{ }}` is interpolated by Actions into the script text BEFORE node sees
   * it, so a PR title containing a backtick or a quote is code, not data. This
   * is the canonical `pull_request_target` script-injection sink, and the round
   * three audit walked straight through it with
   * `const injected = "${{ github.event.pull_request.title }}";`.
   *
   * The script body must contain no expression syntax at all. It already reads
   * everything it needs from the `context` object at runtime.
   */
  test("PR target enforcement's script interpolates nothing from the event", async () => {
    const { steps } = await readEnforcePrTarget();
    const scriptStep = steps.find(step => typeof step.with?.script === "string");
    const rawScript = String(scriptStep?.with?.script ?? "");
    expect(rawScript).not.toContain("${{");
  });

  test("PR target enforcement reacts to the events that can change the verdict", async () => {
    const { workflow, script } = await readEnforcePrTarget();

    // `edited` is what catches a retarget; `ready_for_review` is what re-applies
    // the draft when someone undoes it by hand. Dropping either silently makes
    // the gate one-shot.
    const types = workflow.on?.pull_request_target?.types ?? [];
    expect([...types].sort()).toEqual([
      "edited",
      "opened",
      "ready_for_review",
      "reopened",
      "synchronize",
    ]);

    // The verdict is a live PR read plus a base/description check. There is
    // no ancestry check any more, and no permission lookup: main is the only
    // allowed base, so there is no second base to compare ancestry against,
    // and nothing left for a permission lookup to gate.
    expect(script).toContain("github.rest.pulls.get");
    expect(script).toContain("collectPrQualityFailures");
    expect(script).not.toContain("github.rest.repos.getCollaboratorPermissionLevel");
    expect(script).not.toContain("github.rest.repos.compareCommitsWithBasehead");
    // The allow-list is the gate's whole policy, so it is pinned by value and
    // not just by shape: a widened list is the one edit that opens every base
    // at once while every behavioural scenario below still passes.
    expect(script).toMatch(/const ALLOWED_BASES = \["main"\];/);
    expect(script).toMatch(/const DEFAULT_BASE = "main";/);

    // Every mutation targets the PR the event fired for. `pull_number` is the
    // only handle the script has, and an audit round repointed it at
    // `Number(context.payload.pull_request.title)` — a value the PR author
    // controls, which turns the bot into a write primitive against any PR
    // number the author can name. Bind it to the immutable event field.
    expect(script).toMatch(
      /const pull_number = context\.payload\.pull_request\.number;/,
    );
    expect(script.match(/pull_number\s*=/g) ?? []).toHaveLength(1);

    // Nothing may write back into the fetched PR. The audit round preserved the
    // required comparison line verbatim and defeated it one line earlier with
    // `pr.base.ref = EXPECTED_BASE;` — the literal was still there, the verdict
    // was still always false. `pr` is read-only evidence, so no assignment to
    // any of its fields may exist.
    expect(script).not.toMatch(/\bpr\.[A-Za-z_$][\w$.]*\s*=(?!=)/);
  });

  /**
   * Every write this workflow performs, and exactly which fields it may carry.
   *
   * The audit found two argument-level bypasses that nothing above catches,
   * because both leave the call site's shape intact:
   *
   *   - `issue_number: 1` on the comment call, retargeting the bot's comment at
   *     an unrelated issue;
   *   - `base: "main"` added to the title update, so the gate that exists to
   *     stop wrong-branch PRs quietly retargets them itself.
   *
   * The second is the worse one: `pulls.update` accepts `base`, `state`, and
   * `body`, so an unconstrained argument list on a write token means the bot can
   * retarget or close any PR it is invoked on. Pin the argument names.
   */
  test("PR target enforcement's writes carry only the fields they need", async () => {
    const { script } = await readEnforcePrTarget();

    // Parse each `await github.rest.X.Y({ ... })` call and collect its top-level
    // argument names by brace-depth, so nested objects do not leak in.
    function callArgs(callee: string): string[][] {
      const found: string[][] = [];
      const pattern = new RegExp(`${callee.replaceAll(".", "\\.")}\\(\\s*\\{`, "g");
      for (const match of script.matchAll(pattern)) {
        let depth = 1;
        let i = match.index! + match[0].length;
        const start = i;
        for (; i < script.length && depth > 0; i += 1) {
          const char = script[i]!;
          if (char === "{" || char === "(" || char === "[") depth += 1;
          else if (char === "}" || char === ")" || char === "]") depth -= 1;
        }
        const body = script.slice(start, i - 1);
        const names: string[] = [];
        let nest = 0;
        for (const line of body.split("\n")) {
          const trimmed = line.trim();
          const key = /^([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(trimmed);
          if (nest === 0 && key) names.push(key[1]!);
          for (const char of line) {
            if (char === "{" || char === "[" || char === "(") nest += 1;
            else if (char === "}" || char === "]" || char === ")") nest -= 1;
          }
        }
        found.push(names.sort());
      }
      return found;
    }

    // The two title rewrites — one adds the prefix, one removes it on a correct
    // retarget. `base`, `state`, and `body` are all accepted by this endpoint
    // and none of them belong here.
    expect(callArgs("github.rest.pulls.update")).toEqual([
      ["owner", "pull_number", "repo", "title"],
      ["owner", "pull_number", "repo", "title"],
      ["owner", "pull_number", "repo", "title"],
    ]);

    // Both comment writes address the PR being enforced, by its own number.
    expect(callArgs("github.rest.issues.createComment")).toEqual([
      ["body", "issue_number", "owner", "repo"],
    ]);
    expect(callArgs("github.rest.issues.updateComment")).toEqual([
      ["body", "comment_id", "owner", "repo"],
    ]);

    // …and the number is `pull_number`, not a literal. `issue_number: 1` has the
    // same shape as `issue_number: pull_number` and points somewhere else.
    expect(script).toMatch(/issue_number:\s*pull_number\b/);
    expect(script).not.toMatch(/issue_number:\s*\d/);

    // These are the only three mutating REST calls. A fourth is a new write
    // nobody reviewed.
    const restWrites = [...script.matchAll(/github\.rest\.[\w.]+/g)]
      .map(match => match[0])
      .filter(
        name =>
          !name.endsWith(".get") &&
          !name.endsWith(".listComments") &&
          name !== "github.rest.repos.getCollaboratorPermissionLevel" &&
          name !== "github.rest.repos.compareCommitsWithBasehead",
      );
    expect([...new Set(restWrites)].sort()).toEqual([
      "github.rest.issues.createComment",
      "github.rest.issues.updateComment",
      "github.rest.pulls.update",
    ]);
  });

  /**
   * Run the script instead of reading it.
   *
   * Four audit rounds established that pinning JavaScript by text does not
   * work. Every one of these defeated a regex while leaving the strings it
   * matched on intact:
   *
   *     const upd = github.rest.pulls.update; await upd({ base: "main" })
   *     github.rest["pulls"]["update"]({ base: "main" })
   *     github.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", …)
   *     await github.rest.pulls.update({ ...{ base: "main" }, owner, … })
   *     Object.assign(pr.base, { ref: EXPECTED_BASE })
   *     if (false) { …the entire body… }
   *     try { …the entire body… } catch {}
   *
   * A recording client does not care how the call was spelled. It records what
   * came out. `if (false)` and a swallowed exception show up as an empty call
   * list, and a smuggled `base: "main"` shows up in the arguments.
   */
  describe("PR target enforcement, executed", () => {
    async function run(options: Parameters<typeof runEnforcePrTarget>[1]) {
      const { script } = await readEnforcePrTarget();
      return runEnforcePrTarget(script, options);
    }

    /**
     * Run an arbitrary body in the same scope the workflow script gets, and
     * hand back what it returned.
     *
     * This is how a test asks "what would a mutation see from in there?"
     * without guessing. Round eight's three findings were all probes for a
     * binding that answers differently on the runner than in the harness, so
     * the check that closes them has to be able to look from the same place.
     */
    async function runProbe(body: string): Promise<Record<string, unknown>> {
      const result = await runEnforcePrTarget(body, { pr: { base: { ref: "main" } } });
      return result.returnValue as Record<string, unknown>;
    }

    const BOT = "github-actions[bot]";
    const MARKER = "<!-- pr-quality-enforcer -->";
    const LEGACY_MARKER = "<!-- wrong-branch-enforcer -->";

    function botComment(state: Record<string, unknown>, title = "Add a thing") {
      return {
        id: 7,
        user: { login: BOT },
        body: [
          LEGACY_MARKER,
          `<!-- wrong-branch-enforcer-state:${JSON.stringify(state)} -->`,
          `about ${title}`,
        ].join("\n"),
      };
    }

    test("a PR targeting main is left completely alone", async () => {
      const result = await run({ pr: { base: { ref: "main" } } });

      // Reads only. If a rewrite adds a write here, it appears in this list.
      expect(methodsOf(result)).toEqual(readsAllowedBase());
      expect(result.logs.join(" ")).toContain("All PR quality gates passed");
    });

    test("empty PR description fails and drafts", async () => {
      const result = await run({ pr: { base: { ref: "main" }, body: "" } });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("Pull request description");
      expect(lastEnforcerCommentBody(result)).toContain("body is empty");
      expect(callsTo(result, "graphql")).toHaveLength(1);
    });

    test("literal backslash-n in the body fails the description gate", async () => {
      const result = await run({
        pr: {
          base: { ref: "main" },
          body: "## Summary\\n\\nThis uses escaped newlines instead of real breaks.\\n\\n## Test plan\\n\\nAlso escaped here.",
        },
      });

      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      expect(lastEnforcerCommentBody(result)).toContain("literal `\\n` escape sequences");
    });

    test("clears prior bot state when every gate passes again", async () => {
      const result = await run({
        pr: { base: { ref: "main" }, draft: true },
        comments: [botComment({
          version: 1,
          active: true,
          autoDraftedByBot: true,
          titlePrefixedByBot: false,
          ancestryFailed: false,
          descriptionFailed: true,
        })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "issues.updateComment",
      ]));
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(false);
      const [cleared] = callsTo(result, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
      expect(cleared.body).toContain("PR quality gates passed");
    });

    test("every base outside the allow-list is still blocked", async () => {
      // Widening a list is a one-token edit, and the danger is widening it too
      // far. These four are bases a contributor might actually reach for: the
      // retired integration branch, the release branch's old name, the
      // retired prerelease train, and an ordinary topic branch. None of them
      // is the integration line any more.
      for (const ref of ["dev", "master", "preview", "feature/x"]) {
        const result = await run({ pr: { base: { ref }, title: "Add a thing", draft: false } });

        expect(methodsOf(result)).toEqual(readsWrongBase([
          "issues.createComment",
          "pulls.update",
          "issues.updateComment",
          "graphql",
          "issues.updateComment",
          "issues.updateComment",
        ]));
        expect(lastEnforcerCommentBody(result)).toContain(`\`${ref}\``);
        expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }
    });

    test("the wrong-target explanation names the one allowed base", async () => {
      // main is the only legitimate target now, so the message no longer
      // ranks it against an alternate integration line. It just says where
      // to go.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "Add a thing", draft: false },
      });
      const commentBody = lastEnforcerCommentBody(result);

      expect(commentBody).toContain("must target `main`");
      expect(commentBody).toContain("Please retarget this PR to `main`");
      expect(commentBody).toContain("the only integration branch");
      expect(commentBody).not.toContain("dev2-go");
    });

    test("a PR targeting dev is prefixed, drafted, and explained, and nothing else", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, title: "Add a thing", draft: false },
      });

      // Pending ownership first, then title prefix, then claim autoDraftedByBot and
      // checkpoint before convertToDraft so a successful convert followed by a
      // failed comment still restores later.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));

      // The title update carries the title and nothing else. `base`, `state`
      // and `body` are all accepted by this endpoint; an audit round added
      // `base: "main"` here and no static assertion caught it.
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);

      // The first comment create addresses this PR, by its own number.
      const [created] = callsTo(result, "issues.createComment") as [{ issue_number: number; body: string }];
      expect(created.issue_number).toBe(42);
      expect(created.body).toContain(MARKER);
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain("@contributor");
      expect(commentBody).toContain('"autoDraftedByBot":true');

      // The only GraphQL mutation is the draft conversion — not a retarget.
      const [draft] = callsTo(result, "graphql") as [{ query: string; variables: unknown }];
      expect(draft.query).toContain("convertPullRequestToDraft");
      expect(draft.query).not.toContain("updatePullRequest");
      expect(draft.variables).toEqual({ pullRequestId: "PR_kwDOnode42" });

      // Wrong-base runs must fail the required check even when mutations succeed.
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
    });

    test("a PR that was already a draft is not un-drafted afterwards", async () => {
      const wrong = await run({
        pr: { base: { ref: "dev" }, draft: true },
      });

      // No draft conversion: it is already a draft. Pending ownership first,
      // then title prefix, then final explanation. State records that the bot
      // did not draft — which stops restore from marking it ready.
      expect(methodsOf(wrong)).toEqual(readsWrongBase([
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
      ]));
      expect(lastEnforcerCommentBody(wrong)).toContain('"autoDraftedByBot":false');
      expect(wrong.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);

      // Now retarget it correctly, feeding that state back in.
      const restored = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });

      // The prefix comes off; the draft stays. No GraphQL at all.
      expect(methodsOf(restored)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.updateComment",
      ]));
      expect(callsTo(restored, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);
    });

    test("a corrected PR gets its title and ready state back", async () => {
      const result = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);
      const [ready] = callsTo(result, "graphql") as [{ query: string }];
      expect(ready.query).toContain("markPullRequestReadyForReview");

      // The comment is edited in place, and the state is cleared so a later
      // run does not try to restore twice.
      const [update] = callsTo(result, "issues.updateComment") as [{ comment_id: number; body: string }];
      expect(update.comment_id).toBe(7);
      expect(update.body).toContain('"active":false');
      expect(update.body).toContain("PR quality gates passed");
    });

    test("only this workflow's own prefix is removed, not a contributor's edits", async () => {
      const result = await run({
        pr: { base: { ref: "main" }, draft: false, title: "[WRONG BRANCH] Add a thing (v2)" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });

      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing (v2)" },
      ]);
    });

    test("a rerun on an already-handled PR does not stack prefixes or re-draft", async () => {
      const result = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      // The comment is refreshed (pending + final); title and draft are already right.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.updateComment",
        "issues.updateComment",
      ]));
    });

    test("the verdict comes from the fetched PR, not the stale event payload", async () => {
      // The event fired when the PR still targeted dev; by the time the job
      // runs it has been retargeted to main. The workflow refetches for exactly
      // this reason, and an audit round undid that with
      // `Object.assign(pr, context.payload.pull_request)` — invisible in a
      // harness where the two were the same object.
      const wentWrong = await run({
        pr: { base: { ref: "dev" }, title: "Add a thing", draft: false },
        eventPayload: { base: { ref: "main" }, title: "Add a thing", draft: false },
      });
      // Exact equality, not `toContain`. An audit round hung an extra
      // `github.request("POST /repos/attacker/other/issues", …)` off precisely
      // this path because it was the one scenario asserting loosely.
      expect(methodsOf(wentWrong)).toEqual(readsWrongBase([
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      expect(callsTo(wentWrong, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] Add a thing" },
      ]);

      // …and the reverse: the event says dev, the live PR says main. No writes.
      const wasFixed = await run({
        pr: { base: { ref: "main" } },
        eventPayload: { base: { ref: "dev" } },
      });
      expect(methodsOf(wasFixed)).toEqual(readsAllowedBase());
    });

    test("what the comment tells the author is the live base, not the event's", async () => {
      // Half of this gate is what it says. Reading `context.payload
      // .pull_request.base.ref` for the message alone keeps every call and
      // every argument identical while the text lies: a PR that actually
      // targets dev gets drafted and told it "currently targets main", so the
      // author sees nothing to fix. The corrected-path sentence has the same
      // hole in reverse.
      const wrongTarget = await run({
        pr: { base: { ref: "dev" }, title: "Add a thing", draft: false },
        eventPayload: { base: { ref: "main" }, title: "Add a thing", draft: false },
      });
      expect(lastEnforcerCommentBody(wrongTarget)).toContain("currently targets `dev`");
      expect(lastEnforcerCommentBody(wrongTarget)).not.toContain("currently targets `main`");

      // The corrected-path sentence: the event still carries the old wrong
      // base, the live PR is now on main. Naming the event's base here tells
      // the author their retarget did not take.
      const corrected = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        eventPayload: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: false, titlePrefixedByBot: true })],
      });
      const [edited] = callsTo(corrected, "issues.updateComment") as [{ body: string }];
      expect(edited.body).toContain("now targets `main`");
      expect(edited.body).not.toContain("now targets `dev`");
    });

    test("the bot finds its own comment even when it has scrolled onto a later page", async () => {
      // A busy PR pushes the bot comment off page one. Without pagination the
      // workflow does not find its state: it posts a SECOND comment and forgets
      // it had prefixed the title, so the prefix is never removed. An audit
      // round swapped `paginate` for a bare `listComments` and nothing noticed.
      const filler = Array.from({ length: 3 }, (_, index) => ({
        id: 100 + index,
        user: { login: "contributor" },
        body: "looks good",
      }));

      const result = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        commentPages: [
          filler,
          [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
        ],
      });

      // Found it: the prefix comes off, the PR is marked ready, and the
      // existing comment is edited rather than duplicated.
      expect(methodsOf(result)).toEqual(readsAllowedBasePaged([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(result, "issues.createComment")).toEqual([]);
    });

    test("a bot comment with unreadable state is treated as no state, not as a reason to stop", async () => {
      // `parseState` catches a JSON error and returns null. Nothing covered
      // that branch, so an audit round added `if (botComment && !storedState)
      // return;` — a wrong-target PR with one corrupted comment became a
      // permanent no-op, and every scenario still passed.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "Add a thing", draft: false },
        comments: [{
          id: 7,
          user: { login: BOT },
          body: `${MARKER}\n<!-- wrong-branch-enforcer-state:{not json} -->`,
        }],
      });

      // Enforcement still happens, and the unreadable comment is repaired in
      // place rather than duplicated.
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.updateComment",
        "pulls.update",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      expect(result.warnings.join(" ")).toContain("Could not parse stored workflow state");
    });

    test("an active state that recorded no changes still enforces and still clears", async () => {
      // `{active: true, titlePrefixedByBot: false, autoDraftedByBot: false}` is
      // reachable — it is what a PR that was already prefixed and already a
      // draft leaves behind. No scenario covered it, so an audit round added
      // `if (storedState?.active && !titlePrefixedByBot && !autoDraftedByBot)
      // return;` to both halves and turned enforcement into a no-op.
      const noRecordedChanges = {
        version: 1,
        active: true,
        autoDraftedByBot: false,
        titlePrefixedByBot: false,
      };

      // Still wrong: refresh the explanation. Nothing to re-apply.
      const stillWrong = await run({
        pr: { base: { ref: "dev" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment(noRecordedChanges)],
      });
      expect(methodsOf(stillWrong)).toEqual(readsWrongBase([
        "issues.updateComment",
        "issues.updateComment",
      ]));

      // Corrected: nothing to undo, but the state must still be cleared or the
      // next wrong-target event resumes from a stale record.
      const corrected = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment(noRecordedChanges)],
      });
      expect(methodsOf(corrected)).toEqual(readsAllowedBase(["issues.updateComment"]));
      const [cleared] = callsTo(corrected, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
      expect(cleared.body).toContain("PR quality gates passed");
    });

    test("a PR undrafted by hand before the retarget still gets its state cleared", async () => {
      // The bot drafted it, the author marked it ready again, then retargeted
      // to main. `autoDraftedByBot: true` with `pr.draft: false` is reachable and
      // had no scenario, so an audit round added `if (autoDraftedByBot &&
      // !pr.draft) return;` — the state comment stays active forever and the
      // next wrong-target event resumes from a record that no longer matches.
      const result = await run({
        pr: { base: { ref: "main" }, draft: false, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      // Nothing to un-draft, the prefix comes off, and the state is cleared.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "issues.updateComment",
      ]));
      const [cleared] = callsTo(result, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
    });

    test("a title the author already fixed by hand is not sliced a second time", async () => {
      // `titlePrefixedByBot: true` while the live title no longer starts with
      // the prefix — the author removed it themselves. Slicing anyway would eat
      // the first 15 characters of their title.
      const result = await run({
        pr: { base: { ref: "main" }, draft: true, title: "Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });

      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "graphql",
        "issues.updateComment",
      ]));
    });

    test("the explanation tells the contributor what to do and where to read", async () => {
      // The comment is the entire user-facing half of this gate: a PR gets
      // renamed and drafted, and this is the only thing that says why. Round
      // ten deleted the @mention target and the contributing link separately;
      // both left every other assertion intact, and both leave a contributor
      // staring at a mangled PR with no notification and no next step.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "Add a thing", draft: false, user: { login: "someone-else" } },
      });

      const commentBody = lastEnforcerCommentBody(result);
      // Addressed to the PR author, so GitHub actually notifies them.
      expect(commentBody).toContain("@someone-else");
      // Names both branches involved: where the PR is now, and where it
      // should go. There is no second legitimate base to rank against any more.
      expect(commentBody).toContain("`main`");
      expect(commentBody).toContain("`dev`");
      // Points at the documentation rather than assuming the reader knows.
      expect(commentBody).toContain("https://opencodex.me/contributing/");
      // And carries the state the next run needs.
      expect(commentBody).toContain(MARKER);
      expect(commentBody).toContain('"version":1');
    });

    test("comment listing asks for full pages, so the bot's own comment is found", async () => {
      // `per_page` is a performance knob until it is a correctness one. At
      // per_page: 1 a busy PR needs a hundred round trips to find a comment
      // that page one used to hold, and any rate-limit or transient failure in
      // that sequence means the bot does not find its own state — so it posts a
      // duplicate and forgets what it changed. Round ten dropped it to 1 and
      // nothing failed.
      const result = await run({ pr: { base: { ref: "main" } } });
      const [listed] = callsTo(result, "issues.listComments") as [{ per_page: number }];
      expect(listed.per_page).toBe(100);
    });

    test("the state marker keeps the version the reader expects", async () => {
      // Both halves of the workflow parse this JSON, and a comment written by
      // an older run is read by a newer one. Bumping `version` on the write
      // side without teaching the read side is how a PR ends up with state
      // nobody honours — the prefix stays on forever. Round ten bumped it to 2
      // and every test passed, because nothing asserted the value.
      const wrong = await run({ pr: { base: { ref: "dev" }, draft: false } });
      const [posted] = callsTo(wrong, "issues.createComment") as [{ body: string }];
      expect(posted.body).toContain('"version":1');

      const cleared = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })],
      });
      const [done] = callsTo(cleared, "issues.updateComment") as [{ body: string }];
      expect(done.body).toContain('"version":1');
    });

    test("state written by an unknown version is still honoured on both paths", async () => {
      // The reader never looks at `version`. That is a deliberate property,
      // not an oversight: a comment written by a future run of this workflow
      // still has to be readable by the run that is executing now, or the
      // prefix it added stays on the PR forever with nothing left to remove
      // it. A version gate reads as defensive hygiene — `if (storedState &&
      // storedState.version !== 1) return;` — and verified reachable: with
      // that line in place, an active v2 marker on a corrected, drafted PR
      // produced only ["pulls.get", "issues.listComments"]. No title
      // restoration, no ready-for-review, permanently stuck.
      for (const version of [2, 99]) {
        const active = { version, active: true, autoDraftedByBot: true, titlePrefixedByBot: true };

        // Corrected target: the unknown-version state is trusted and both
        // changes are undone, and the marker is rewritten at the version this
        // workflow writes.
        const restored = await run({
          pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
          comments: [botComment(active)],
        });
        expect(methodsOf(restored)).toEqual(readsAllowedBase([
          "pulls.update",
          "graphql",
          "issues.updateComment",
        ]));
        expect(callsTo(restored, "pulls.update")).toEqual([
          { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
        ]);
        const [cleared] = callsTo(restored, "issues.updateComment") as [{ body: string }];
        expect(cleared.body).toContain('"version":1');
        expect(cleared.body).toContain('"active":false');

        // Still wrong: enforcement proceeds, and the spread carries the
        // unknown version through untouched. Pinning that is what makes a
        // future migration a visible decision rather than a silent rewrite.
        const wrong = await run({
          pr: { base: { ref: "dev" }, draft: false, title: "Add a thing" },
          comments: [botComment(active)],
        });
        expect(methodsOf(wrong)).toEqual(readsWrongBase([
          "issues.updateComment",
          "pulls.update",
          "issues.updateComment",
          "graphql",
          "issues.updateComment",
          "issues.updateComment",
        ]));
        expect(lastEnforcerCommentBody(wrong)).toContain(`"version":${version}`);
        expect(lastEnforcerCommentBody(wrong)).toContain('"active":true');
        expect(wrong.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }
    });

    test("state fields are read for truthiness, not for their type", async () => {
      // `parseState` hands back whatever JSON.parse produced, and every reader
      // is a plain `if (…)`. So the contract is truthiness, and a type guard —
      // `if (storedState && typeof storedState.active !== "boolean") return;`
      // — looks like schema hygiene while disabling restoration for any state
      // this workflow did not write in its current shape. Verified reachable:
      // with that guard, a marker carrying `"active":"true"` produced only
      // ["pulls.get", "issues.listComments"] where the real script restores
      // the title and marks the PR ready.
      //
      // The comment selector requires github-actions[bot], so this is not
      // contributor-reachable. It is reachable across a migration, which is
      // exactly when the prefix must still come off.
      const loose = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: "true", autoDraftedByBot: 1, titlePrefixedByBot: "yes" })],
      });
      expect(methodsOf(loose)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      expect(callsTo(loose, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "Add a thing" },
      ]);

      // And the falsy side is symmetric: `null` and `0` skip their own
      // restoration without stopping the run or the clearing write.
      const falsy = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [botComment({ version: 1, active: true, autoDraftedByBot: null, titlePrefixedByBot: 0 })],
      });
      expect(methodsOf(falsy)).toEqual(readsAllowedBase(["issues.updateComment"]));
      const [cleared] = callsTo(falsy, "issues.updateComment") as [{ body: string }];
      expect(cleared.body).toContain('"active":false');
    });

    test("ownership comment is checkpointed before mutations and finalized after", async () => {
      // Ownership is written before title/draft. autoDraftedByBot is claimed and
      // checkpointed before convertToDraft so a successful convert followed by a
      // failed comment still restores later.
      const result = await run({ pr: { base: { ref: "dev" }, draft: false } });
      const methods = methodsOf(result);
      const pending = methods.indexOf("issues.createComment");
      const title = methods.indexOf("pulls.update");
      const draftClaim = methods.indexOf("issues.updateComment");
      const draft = methods.indexOf("graphql");
      const finalUpdate = methods.lastIndexOf("issues.updateComment");
      expect(pending).toBeGreaterThan(-1);
      expect(pending).toBeLessThan(title);
      expect(title).toBeLessThan(draftClaim);
      expect(draftClaim).toBeLessThan(draft);
      expect(draft).toBeLessThan(finalUpdate);
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
    });

    test("a title that is exactly the prefix is still enforced", async () => {
      // `pr.title === TITLE_PREFIX` is a reachable, contributor-controllable
      // value, and `startsWith` is true for it — so an early return keyed on
      // that exact equality reads as a harmless guard and silently exempts any
      // PR whose author titles it "[WRONG BRANCH] ". A review round added one
      // and nothing failed.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "[WRONG BRANCH] ", draft: false },
      });

      // Already prefixed, so no title write — but pending/draft/final still run.
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      expect(lastEnforcerCommentBody(result)).toContain('"titlePrefixedByBot":false');
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
    });

    test("an empty title is enforced rather than skipped", async () => {
      // GitHub does not allow it, but the script never checks, and
      // `if (!pr.title) return;` is the kind of defensive line that looks
      // reasonable in review. It exempts whatever can produce a falsy title.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "", draft: true },
      });

      expect(callsTo(result, "pulls.update")).toEqual([
        { owner: "lidge-jun", repo: "opencodex", pull_number: 42, title: "[WRONG BRANCH] " },
      ]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "pulls.update",
        "issues.updateComment",
      ]));
    });

    test("an already-prefixed title is never prefixed twice", async () => {
      // The workflow re-runs on `edited`, which its own title write triggers.
      // Without the `startsWith` guard each pass would stack another prefix.
      // This states the property directly, so a guard keyed on the doubled
      // prefix — which only ever matches after the bug already happened —
      // cannot be introduced as if it were the fix.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "[WRONG BRANCH] Add a thing", draft: true },
      });

      // No second prefix — and the run still does everything else it owes:
      // reads, finds no prior state, and records that it changed nothing.
      // Asserting only the absent write would let an early return keyed on the
      // doubled prefix pass, since that skips the write too.
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "issues.updateComment",
      ]));
      expect(lastEnforcerCommentBody(result)).toContain('"titlePrefixedByBot":false');
      expect(lastEnforcerCommentBody(result)).toContain('"active":true');
    });

    test("a title that already carries the prefix twice is still enforced", async () => {
      // The prefix is contributor-writable text, so any guard keyed on a
      // doubled prefix is a guard the contributor can satisfy on purpose.
      // Verified reachable: with such a guard in place, a PR titled
      // "[WRONG BRANCH] [WRONG BRANCH] mine" against dev produced only
      // ["pulls.get", "issues.listComments"] — no comment, no draft, complete
      // exemption.
      const result = await run({
        pr: { base: { ref: "dev" }, title: "[WRONG BRANCH] [WRONG BRANCH] mine", draft: false },
      });

      expect(methodsOf(result)).toEqual(readsWrongBase([
        "issues.createComment",
        "issues.updateComment",
        "graphql",
        "issues.updateComment",
        "issues.updateComment",
      ]));
      // Already prefixed by the `startsWith` test, so no third prefix is added.
      expect(callsTo(result, "pulls.update")).toEqual([]);
      expect(lastEnforcerCommentBody(result)).toContain('"active":true');
      expect(lastEnforcerCommentBody(result)).toContain('"autoDraftedByBot":true');
    });

    test("with two bot comments, the workflow reads and writes the first", async () => {
      // Duplicates happen: a failed run that posted before crashing, or a
      // repository that once ran two copies of this workflow. The two carry
      // conflicting state, so which one is authoritative decides whether the
      // title gets restored. `find` and `findLast` are a one-word edit apart
      // and pick opposite answers; nothing pinned which.
      const first = {
        id: 7,
        user: { login: BOT },
        body: [MARKER, `<!-- wrong-branch-enforcer-state:${JSON.stringify({ version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true })} -->`].join("\n"),
      };
      const second = {
        id: 8,
        user: { login: BOT },
        body: [MARKER, `<!-- wrong-branch-enforcer-state:${JSON.stringify({ version: 1, active: false, autoDraftedByBot: false, titlePrefixedByBot: false })} -->`].join("\n"),
      };
      const result = await run({
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [first, second],
      });

      // The first comment's state is the one honoured: it says the bot
      // prefixed and drafted, so both are undone.
      expect(methodsOf(result)).toEqual(readsAllowedBase([
        "pulls.update",
        "graphql",
        "issues.updateComment",
      ]));
      // And the first comment is the one rewritten, not the second.
      const [updated] = callsTo(result, "issues.updateComment") as [{ comment_id: number }];
      expect(updated.comment_id).toBe(7);
    });

    test("a failure reading the PR stops the run", async () => {
      // `pulls.get` is the authoritative read the whole verdict rests on.
      // Turning its failure into a synthetic correct-looking PR converts an
      // enforcement outage into a green check — the gate reports success while
      // every wrong-target PR walks through. Existing coverage failed the
      // GraphQL call and `pulls.update`, never this one.
      for (const status of [404, 403, 500]) {
        await expect(
          run({ pr: { base: { ref: "dev" } }, failOn: ["pulls.get"], failStatus: status }),
        ).rejects.toThrow();
      }
    });

    test("the harness offers every binding the pinned action does", async () => {
      // Round eight did not attack the workflow. It attacked the gap between
      // this fake and the real runtime, three times over: `typeof getOctokit
      // === "function"`, `core.setOutput`, and `core.getInput?.("github-token")`
      // are all truthy on the runner and were all absent here, so
      // `if (…) return;` disabled the gate in production and changed nothing in
      // the suite.
      //
      // Patching those three names would invite a fourth. The scope list below
      // is transcribed from the pinned action's `src/main.ts`, which hands
      // `callAsyncFunction` an object whose keys become the script's
      // parameters. If the action is ever re-pinned to a version with a
      // different scope, this fails and says so, instead of quietly reopening
      // the hole.
      expect([...SCRIPT_BINDINGS].sort()).toEqual([
        "__original_require__",
        "context",
        "core",
        "exec",
        "fetch",
        "getOctokit",
        "github",
        "glob",
        "io",
        "octokit",
        "require",
      ]);

      // Same argument one level down: `core` is a module, and a probe for any
      // method it exports is a probe the fake has to answer the same way.
      // Transcribed from `@actions/core`'s exports.
      const result = await run({ pr: { base: { ref: "main" } } });
      expect(result.coreSurface).toEqual([
        "addPath",
        "debug",
        "endGroup",
        "error",
        "exportVariable",
        "getBooleanInput",
        "getIDToken",
        "getInput",
        "getMultilineInput",
        "getState",
        "group",
        "info",
        "isDebug",
        "markdownSummary",
        "notice",
        "platform",
        "saveState",
        "setCommandEcho",
        "setFailed",
        "setOutput",
        "setSecret",
        "startGroup",
        "summary",
        "toPlatformPath",
        "toPosixPath",
        "toWin32Path",
        "warning",
      ]);
    });

    test("a probe for any of those bindings finds it, so it cannot detect the fake", async () => {
      // The mechanism the three round-eight mutations shared: a truthiness or
      // `typeof` check that answers one way on the runner and the other way
      // here. Assert the answers match production for every injected name.
      const result = await run({ pr: { base: { ref: "main" } } });
      const probe = await runProbe(`
        const seen = {};
        for (const [name, value] of Object.entries({
          github, octokit, getOctokit, context, core, exec, glob, io, fetch, require,
          __original_require__,
        })) {
          seen[name] = typeof value;
        }
        seen["core.getInput"] = typeof core.getInput;
        seen["core.setOutput"] = typeof core.setOutput;
        seen["core.summary.addRaw"] = typeof core.summary.addRaw;
        seen["core.getInput(github-token)"] = core.getInput("github-token") !== "";
        seen["core.isDebug"] = core.isDebug();
        return seen;
      `);

      // Everything the action injects is a function or an object on the runner.
      // Nothing here may be `undefined`.
      expect(Object.values(probe).some(value => value === "undefined")).toBe(false);
      expect(probe["core.getInput"]).toBe("function");
      expect(probe["core.setOutput"]).toBe("function");
      expect(probe["core.summary.addRaw"]).toBe("function");
      // `github-token` carries a `${{ github.token }}` default, so it is
      // non-empty on the runner. A gate that returns early when it is set is a
      // gate that never runs.
      expect(probe["core.getInput(github-token)"]).toBe(true);
      expect(probe["core.isDebug"]).toBe(false);

      // And the normal path is unaffected by the probe scenario.
      expect(methodsOf(result)).toEqual(readsAllowedBase());
    });

    test("the harness runs the Node major the pinned action declares", async () => {
      // Same class of finding as the three above, one level deeper: the
      // runtime version. `actions/github-script@3a2844b7…` declares
      // `runs: using: node24` in its `action.yml`, so the runner executes this
      // script under Node 24. The harness reported v20 for fourteen rounds, so
      // `if (process.versions.node.startsWith("24")) return;` was a no-op in
      // the suite and a dead gate in production.
      //
      // Read the major out of the workflow's own pin rather than hardcoding
      // it: re-pinning the action to a node26 build should fail here and say
      // so, not silently reopen the gap.
      const workflow = await readText(".github/workflows/enforce-pr-target.yml");
      expect(workflow).toContain("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");

      const probe = await runProbe(`
        return {
          major: process.versions.node.split(".")[0],
          version: process.version,
          startsWith24: process.versions.node.startsWith("24"),
          bun: typeof process.versions.bun,
        };
      `);
      expect(probe.major).toBe("24");
      expect(probe.version).toBe(`v${probe.major}.10.0`);
      expect(probe.startsWith24).toBe(true);
      // Still Node, not Bun: the runner has no `process.versions.bun`.
      expect(probe.bun).toBe("undefined");
    });

    test("a draft GraphQL failure is soft-failed with accurate state and a hard check failure", async () => {
      // Observed on PR #626: convertPullRequestToDraft failed with
      // "Resource not accessible by integration", the job crashed before
      // setFailed, and the PR stayed ready. Soft-catch the draft mutation,
      // record autoDraftedByBot:false, explain the fallback, and still fail
      // the required check so merge stays blocked.
      const { script } = await readEnforcePrTarget();

      for (const status of [403, 404, 422, 500]) {
        const result = await runEnforcePrTarget(script, {
          pr: { base: { ref: "dev" }, draft: false },
          failOn: ["graphql"],
          failStatus: status,
        });
        expect(methodsOf(result)).toEqual(readsWrongBase([
          "issues.createComment",
          "pulls.update",
          "issues.updateComment",
          "graphql",
          "issues.updateComment",
        ]));
        const commentBody = lastEnforcerCommentBody(result);
        expect(commentBody).toContain('"autoDraftedByBot":false');
        expect(commentBody).toContain("Automatic draft conversion failed");
        expect(result.warnings.some((w) => w.includes("Could not convert pull request to draft"))).toBe(true);
        expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
      }

      // Title update failures still propagate — without the prefix the gate
      // has no durable signal on the PR itself.
      for (const status of [403, 404, 422]) {
        await expect(
          runEnforcePrTarget(script, {
            pr: { base: { ref: "dev" }, draft: false },
            failOn: ["pulls.update"],
            failStatus: status,
          }),
        ).rejects.toThrow(/simulated failure: pulls\.update/);
      }
    });

    test("a failed draft conversion does not claim autoDraftedByBot", async () => {
      const { script } = await readEnforcePrTarget();
      const result = await runEnforcePrTarget(script, {
        pr: { base: { ref: "dev" }, draft: false },
        failOn: ["graphql"],
      });
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain('"autoDraftedByBot":false');
      expect(commentBody).toContain('"titlePrefixedByBot":true');
      expect(result.warnings.some((w) => w.startsWith("setFailed:"))).toBe(true);
    });

    test("a failed ready-for-review conversion keeps ownership active for retry", async () => {
      const { script } = await readEnforcePrTarget();
      const result = await runEnforcePrTarget(script, {
        pr: { base: { ref: "main" }, draft: true, title: "[WRONG BRANCH] Add a thing" },
        comments: [
          {
            id: 7,
            user: { login: "github-actions[bot]" },
            body: [
              "<!-- wrong-branch-enforcer -->",
              `<!-- wrong-branch-enforcer-state:${JSON.stringify({
                version: 1,
                active: true,
                autoDraftedByBot: true,
                titlePrefixedByBot: true,
              })} -->`,
            ].join("\n"),
          },
        ],
        failOn: ["graphql"],
      });
      const commentBody = lastEnforcerCommentBody(result);
      expect(commentBody).toContain('"active":true');
      expect(commentBody).toContain('"autoDraftedByBot":true');
      expect(commentBody).toContain("Automatic ready-for-review conversion failed");
      expect(result.warnings.some((w) => w.includes("Could not mark pull request ready for review"))).toBe(true);
    });
  });

  test("PR target enforcement records what it changed so it can undo it", async () => {
    const { script } = await readEnforcePrTarget();

    // The bot rewrites the author's title and draft state, so it stores which of
    // those it touched and restores exactly those on a correct retarget. Losing
    // this bookkeeping means a PR that was already a draft gets marked ready, or
    // that the `[WRONG BRANCH] ` prefix is never removed.
    expect(script).toMatch(/state\.autoDraftedByBot\s*=\s*true/);
    expect(script).toMatch(/state\.titlePrefixedByBot\s*=\s*true/);
    expect(script).toMatch(/storedState\.autoDraftedByBot/);
    expect(script).toMatch(/storedState\.titlePrefixedByBot/);
    expect(script).toMatch(/await\s+convertToDraft\(\)/);
    expect(script).toMatch(/await\s+markReadyForReview\(\)/);
    expect(script).toMatch(/core\.setFailed\(/);

    // Tie each helper to its GraphQL body. Asserting that the call and the
    // mutation name both appear somewhere leaves a gap: declaring an empty
    // `async function convertToDraft() {}` later in the script shadows the real
    // one, removes the behaviour, and satisfies both checks. Require exactly one
    // declaration of each, and require it to contain the mutation.
    for (const [helper, mutation] of [
      ["convertToDraft", "convertPullRequestToDraft"],
      ["markReadyForReview", "markPullRequestReadyForReview"],
    ] as const) {
      const declarations = [...script.matchAll(new RegExp(`function\\s+${helper}\\s*\\(`, "g"))];
      expect(declarations).toHaveLength(1);
      const body = script.slice(declarations[0]!.index!);
      const nextDeclaration = body.slice(1).search(/\n\s*(?:async\s+)?function\s/);
      expect(nextDeclaration === -1 ? body : body.slice(0, nextDeclaration + 1)).toContain(mutation);
    }
    expect(script).toMatch(/const TITLE_PREFIX = "\[WRONG BRANCH\] ";/);

    // The two branch conditions, pinned literally. An audit round wrote
    // `if (!storedState?.active || true)` — the restoration path became
    // unreachable, so a corrected PR kept its `[WRONG BRANCH] ` title and stayed
    // a draft forever, and every assertion above still passed because both
    // helpers and both state fields were still textually present. Presence of a
    // call proves nothing about whether it can be reached.
    expect(script).toMatch(/\n\s*if \(!storedState\?\.active\) \{\n/);
    expect(script).toMatch(/\n\s*if \(failures\.length > 0\) \{\n/);

    // Pending ownership is written before mutations; convertToDraft runs next;
    // a later upsertComment records autoDraftedByBot only after success (#631).
    const branchStart = script.indexOf("if (failures.length > 0) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = script.slice(branchStart);
    const pendingWriteIndex = branch.indexOf("await upsertComment(");
    const draftCallIndex = branch.indexOf("await convertToDraft()");
    const afterDraftWriteIndex = branch.indexOf("await upsertComment(", draftCallIndex);
    expect(pendingWriteIndex).toBeGreaterThan(-1);
    expect(draftCallIndex).toBeGreaterThan(-1);
    expect(pendingWriteIndex).toBeLessThan(draftCallIndex);
    expect(afterDraftWriteIndex).toBeGreaterThan(draftCallIndex);
  });

  test("release workflow retains one exact archive before any mutating step runs", async () => {
    const workflow = await readText(".github/workflows/release.yml");

    expect(workflow).toMatch(/expected-sha:[\s\S]*?required: true/);
    // The real guard is a 40-hex-char regex plus a GITHUB_SHA/checked-out-HEAD
    // match, not a separate "is required" check: `workflow_dispatch` already
    // enforces `required: true` before the job ever starts.
    expect(workflow).toContain('if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then');
    expect(workflow).toContain('echo "::error::expected-sha must be a lowercase full 40-character commit SHA"');
    expect(workflow).toContain('if [ "$GITHUB_SHA" != "$EXPECTED_SHA" ]; then');
    expect(workflow).toContain('checked_out_sha="$(git rev-parse HEAD)"');
    expect(workflow).toMatch(
      /permissions:\n  contents: write[^\n]*\n  actions: read[^\n]*\n  id-token: write[^\n]*/,
    );
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");

    // No Setup Go: the six native binaries are produced inside `npm pack`'s
    // own `prepack` lifecycle (`prepare-package.ts --native` shells out to
    // `go run scripts/build-go-release.go`), not as a separate workflow step.
    expect(workflow).not.toMatch(/^\s*- name: Setup Go\s*$/m);
    expect(workflow).not.toContain("actions/setup-go@");

    expect(count(workflow, "npm pack --json")).toBe(1);
    const build = workflowStep(workflow, /^Build and retain exact release archive$/);
    const publish = workflowStep(workflow, /^Publish \(or dry-run\)$/);
    const smoke = workflowStep(workflow, /^Post-publish registry smoke$/);
    const release = workflowStep(workflow, /^Create\/reconcile GitHub release$/);

    expect(build).toContain("npm run build:publish");
    expect(build).toContain("bun scripts/embed-gui.ts --verify-dist");
    expect(build).toContain("npm pack --json > pack.json");
    expect(build).toContain("npm run verify:native-package");
    expect(build).toContain("npm run verify:native-install");
    expect(build).toContain("bun scripts/prepare-release-assets.ts prepare");
    expect(build).toContain("TARBALL_SHA256");
    expect(build).toContain("RELEASE_NATIVE_DIR");
    // The archive is built, packed, and retained: nothing here mutates the
    // registry, a Git ref, or GitHub Releases.
    for (const mutator of ["npm publish", "git tag", "git push", "gh release create", "gh release upload"]) {
      expect(build).not.toContain(mutator);
    }

    // The two steps that can create durable, hard-to-undo state on a real
    // dry-run (the registry smoke check and the GitHub Release itself) are
    // step-guarded.
    for (const guarded of [smoke, release]) {
      expect(guarded).toContain("if: ${{ inputs.dry-run != true }}");
    }

    // The publish step's own internal branch used to read a $DRY_RUN shell
    // variable this workflow never set, so it always took the real "npm
    // publish" branch regardless of the dry-run input (default true). The
    // step's env now binds DRY_RUN from the actual input, and never carries
    // a hardcoded "true"/"false" that would defeat that binding.
    expect(publish).toContain("DRY_RUN: ${{ inputs.dry-run }}");
    expect(publish).toMatch(/if \[ "\$DRY_RUN" = "true" \]; then/);
    expect(publish).not.toMatch(/DRY_RUN:\s*["']?(?:true|false)["']?\s*$/m);
    for (const step of workflow.split(/\n {6,}- name: /).slice(1)) {
      if (/git tag "\$release_tag"|git push origin|gh release create/.test(step)) {
        expect(step).toContain("if: ${{ inputs.dry-run != true }}");
      }
    }

    const buildAt = workflow.indexOf("Build and retain exact release archive");
    const classifyAt = workflow.indexOf("Classify exact release retry state");
    const publishAt = workflow.indexOf("Publish (or dry-run)");
    const releaseAt = workflow.indexOf("Create/reconcile GitHub release");
    expect(buildAt).toBeGreaterThan(-1);
    expect(classifyAt).toBeGreaterThan(buildAt);
    expect(publishAt).toBeGreaterThan(classifyAt);
    expect(releaseAt).toBeGreaterThan(publishAt);
  });

  test("release workflow classifies exact retries only after immutable identities exist", async () => {
    const workflow = await readText(".github/workflows/release.yml");
    const classify = workflowStep(workflow, /^Classify exact release retry state$/);
    const smoke = workflowStep(workflow, /^Post-publish registry smoke$/);
    const release = workflowStep(workflow, /^Create\/reconcile GitHub release$/);

    expect(classify).toContain("pack.json");
    expect(classify).toContain("dist.integrity");
    expect(classify).toContain("dist-tag");
    expect(classify).toContain("NPM_RELEASE_STATE");
    expect(classify).toContain("NPM_EXPECTED_INTEGRITY");
    expect(classify).toContain("GITHUB_RELEASE_CANDIDATE");
    // The real state is a fresh/exact npm marker and a present/absent GitHub
    // candidate marker, never this literal: asserting its absence keeps a
    // stray reintroduction of the old aspirational shape from sneaking back.
    expect(classify).not.toContain("GITHUB_RELEASE_STATE=exact");
    expect(classify).toContain("GITHUB_SHA");

    // Notes are assembled, and the tag only exists if it did not already,
    // before `gh release create`, so a notes-API failure never leaves a
    // dangling tag with nothing published behind it.
    const notesAt = release.indexOf("notes_file=");
    const tagAt = release.indexOf('git tag "$release_tag"');
    const createAt = release.indexOf('gh release create "$release_tag"');
    expect(notesAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(notesAt);
    expect(createAt).toBeGreaterThan(tagAt);
    expect(release).toContain("gh release create");
    expect(release).not.toContain("gh release upload");
    expect(release).toContain('git push origin "refs/tags/${release_tag}"');

    expect(smoke).toContain("NPM_DIST_TAG: ${{ inputs.tag }}");
    expect(smoke).toContain('dist.integrity');
    expect(smoke).toContain('"dist-tags.${NPM_DIST_TAG}"');
    expect(smoke).toContain('"$remote_integrity" != "$NPM_EXPECTED_INTEGRITY"');
    expect(smoke).toContain('"$tagged_version" = "$RELEASE_VERSION"');
  });

  test("GitHub release assets are exactly the six binaries and checksum manifest", async () => {
    const workflow = await readText(".github/workflows/release.yml");
    const build = workflowStep(workflow, /^Build and retain exact release archive$/);
    const release = workflowStep(workflow, /^Create\/reconcile GitHub release$/);
    const packagePrep = await readText("scripts/prepare-package.ts");

    // `nativeArtifactNames` (see the go-ci.yml comment on the Windows-only
    // cross-compile job) is the single source of truth for the six names;
    // `validateNativeDirectory` requires an exact match against it plus the
    // checksum manifest, so the packed archive can never carry a subset.
    expect(packagePrep).toContain("export function nativeArtifactNames(version: string): string[]");
    expect(packagePrep).toContain("darwin_amd64");
    expect(packagePrep).toContain("darwin_arm64");
    expect(packagePrep).toContain("linux_amd64");
    expect(packagePrep).toContain("linux_arm64");
    expect(packagePrep).toContain("windows_amd64.exe");
    expect(packagePrep).toContain("windows_arm64.exe");
    expect(packagePrep).toContain("native artifact inventory mismatch");

    // The release step publishes the archive `prepare-release-assets.ts`
    // already verified matches that exact six-binary inventory; it does not
    // re-derive or re-select the asset list itself.
    expect(build).toContain("bun scripts/prepare-release-assets.ts prepare");
    expect(release).toContain('"${setup_assets[0]}#Setup.exe"');
    expect(release).toContain('"${releases_assets[0]}#RELEASES"');
    expect(release).toContain('"${nupkg_assets[@]}"');
  });

  test("main-only push activates both package and Go release ownership gates", async () => {
    const ci = await readText(".github/workflows/ci.yml");
    const goCi = await readText(".github/workflows/go-ci.yml");

    // main is the only integration and release-promotion branch, so both
    // workflows now key off the same single-branch list on every trigger.
    expect(ci).toMatch(/pull_request:[\s\S]*?branches: \[main\]/);
    expect(ci).toMatch(/push:[\s\S]*?branches: \[main\]/);
    expect(ci).toContain("npm run verify:native-package");
    expect(goCi).toMatch(/push:[\s\S]*?branches: \[main\]/);

    // Two jobs remain (build-and-test, cross-compile): the e2e job is gone,
    // and each survivor still sets up its own pinned Bun.
    expect(count(goCi, "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")).toBe(2);
    expect(count(goCi, "bun-version: 1.3.14")).toBe(2);
    expect(goCi).not.toMatch(/^\s*e2e:\s*$/m);
    expect(goCi).not.toContain("test/e2e");
    for (const [job, nextJob] of [
      ["build-and-test", "cross-compile"],
      ["cross-compile", undefined],
    ] as const) {
      const tail = goCi.split(`\n  ${job}:\n`)[1]!;
      const block = nextJob ? tail.split(`\n  ${nextJob}:\n`)[0]! : tail;
      expect(block).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
      expect(block).toContain("bun-version: 1.3.14");
    }

    // build-and-test is Windows-only now, and runs no vet/test/race step:
    // nothing in Actions gates a build here either.
    const buildAndTest = goCi.split("\n  build-and-test:\n")[1]!.split("\n  cross-compile:\n")[0]!;
    expect(buildAndTest).toMatch(/matrix:\s*\n\s*os: \[windows-latest\]/);
    expect(buildAndTest).not.toContain("ubuntu-latest");
    expect(buildAndTest).not.toContain("macos-latest");
    expect(buildAndTest).not.toMatch(/^\s*- name: Vet\s*$/m);
    expect(buildAndTest).not.toMatch(/^\s*- name: Test\s*$/m);
    expect(buildAndTest).not.toMatch(/^\s*- name: Race detector\s*$/m);
    expect(buildAndTest).not.toMatch(/run:\s*go test\b/);
    expect(buildAndTest).not.toMatch(/run:\s*go vet\b/);
    expect(buildAndTest).not.toContain("-race");

    // cross-compile keeps only the windows/amd64 build step; the other four
    // GOOS/GOARCH smoke builds (linux/amd64, darwin/arm64, darwin/amd64,
    // linux/arm64) are gone.
    const crossCompile = goCi.split("\n  cross-compile:\n")[1]!;
    expect(crossCompile).toContain("- name: windows/amd64");
    for (const removed of ["- name: linux/amd64", "- name: darwin/arm64", "- name: darwin/amd64", "- name: linux/arm64"]) {
      expect(crossCompile).not.toContain(removed);
    }

    for (const path of [
      '"bin/**"',
      '"src/update/job.ts"',
      '"scripts/build-go-release.go"',
      '"scripts/prepare-package.ts"',
      '"scripts/prepare-release-assets.ts"',
      '"scripts/reconcile-release-assets.ts"',
      '"scripts/ocx-native-launcher.test.mjs"',
      '"scripts/verify-native-install.mjs"',
      '"package.json"',
      '"bun.lock"',
      '".github/workflows/ci.yml"',
      '".github/workflows/release.yml"',
    ]) {
      expect(goCi).toContain(path);
    }
    // Delivery scope is Windows only, but the verification step still checks
    // for all six platform binaries: `build-go-release.go` (unchanged, see
    // its own comment in go-ci.yml and HANDOFF.md) still produces all six,
    // because `scripts/prepare-package.ts` still hard-requires exactly that
    // inventory for every `npm pack`, on every platform.
    expect(goCi).toContain("Verify six native release names without publishing");
    expect(goCi).toContain('version="0.0.0-preview.0"');
    expect(goCi).toContain("--dry-run");
    expect(goCi).toContain("grep -c -- ' -> '");
    for (const suffix of [
      "darwin_amd64",
      "darwin_arm64",
      "linux_amd64",
      "linux_arm64",
      "windows_amd64.exe",
      "windows_arm64.exe",
    ]) {
      expect(goCi).toContain(suffix);
    }
  });

  test("all governing workflow actions remain immutable SHA pins", async () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/go-ci.yml",
      ".github/workflows/release.yml",
    ]) {
      const workflow = await readText(path);
      const refs = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gm)].map(match => match[1]!);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  test("docs deployment is pinned, bounded, and scoped to Pages", async () => {
    const workflow = await readText(".github/workflows/deploy-docs.yml");

    expect(workflow).toContain("permissions:\n  contents: read\n  pages: write\n  id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    // The Pages build is deliberately explicit on Windows: the hosted Astro
    // wrapper previously mis-rendered the root locale search JSON. Keep the
    // replacement pinned and assert the upload action that actually feeds the
    // deploy job rather than requiring the retired Bash wrapper.
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9");
    expect(workflow).not.toContain("withastro/action@");
    expect(workflow).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("issue-quality workflow rejects workflow_dispatch pull request numbers before mutation", async () => {
    const workflow = await readText(".github/workflows/enforce-issue-quality.yml");

    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("Translate non-English issue comments");
    expect(workflow).toContain("shouldTranslateComment");
    expect(workflow).toContain("buildTranslatedCommentBody");
    expect(workflow).toContain("github.rest.issues.updateComment");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(workflow).not.toContain("issue-comment-translation-${{ github.event.comment.id }}");
    expect(workflow).toContain("if: github.event_name == 'issue_comment'");
    expect(workflow).toMatch(
      /translate:\s*\n\s*name: Translate non-English issues\s*\n\s*if: github\.event_name == 'issues' \|\| github\.event_name == 'workflow_dispatch'/,
    );
    expect(workflow).toMatch(
      /validate:\s*\n\s*if: github\.event_name == 'issues' \|\| github\.event_name == 'workflow_dispatch'/,
    );

    const commentJob = workflow.split(/\n {2}translate-comment:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentJob).toContain("parse-issue-translation-response.cjs");
    expect(commentJob).toContain("Apply inline comment translation");
    expect(commentJob).toContain("continue-on-error: true");
    expect(commentJob).toContain("Record comment translation availability");
    expect(commentJob).toContain("steps.ai.outcome == 'success'");
    expect(commentJob).toContain("isPreparedSourceStillCurrent");
    expect(commentJob).toContain("updateComment");
    expect(commentJob).toContain("requires_translation == 'true'");
    expect(commentJob).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(commentJob).toContain("# Required to rewrite the triggering issue comment in place.");
    expect(commentJob).toContain("sourceKey:");
    // Same fail-closed parse → apply gate as the issue path.
    const commentParse = commentJob
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline comment translation")[0]!;
    expect(commentParse).toContain("parse-issue-translation-response.cjs");
    const commentRun = commentParse.split(/\n\s*run:\s*/)[1];
    expect(commentRun).toBeDefined();
    expect(commentRun!).not.toContain("${{");
    const commentApply = commentJob
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    const guardAt = commentApply.indexOf("isPreparedSourceStillCurrent({");
    const updateAt = commentApply.indexOf("updateComment");
    const missingAt = commentApply.indexOf("missingRequiredTranslationFields({");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeLessThan(updateAt);
    expect(guardAt).toBeLessThan(updateAt);
    expect(commentApply).toContain("omitted required field(s)");

    // Job-scoped permissions only (no top-level issues:write; no actions:write).
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?permissions:\s*\n(?:\s*#.*\n)*\s*contents: read\s*\n(?:\s*#.*\n)*\s*issues: write\s*\n(?:\s*#.*\n)*\s*models: read/,
    );
    const translateJob = workflow.split(/\n {2}translate:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(translateJob).not.toMatch(/actions:\s*write/);
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?validate:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*#.*\n\s*issues: write/,
    );
    const beforeJobs = workflow.split(/jobs:\s*\n/)[0]!;
    expect(beforeJobs).not.toMatch(/^\s*permissions:/m);

    // Non-cancelling per-issue concurrency at workflow and translate-job scope.
    expect(workflow).toContain("group: issue-quality-${{ github.event.issue.number || inputs.issue_number }}");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number || inputs.issue_number }}");
    const workflowConcurrency = workflow.split(/jobs:\s*\n/)[0]!;
    expect(workflowConcurrency).toMatch(
      /concurrency:\s*\n\s*group: issue-quality-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toMatch(
      /concurrency:\s*\n\s*group: issue-translation-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toContain("translation-state-degraded");
    expect(translateJob).toContain("core.summary");

    // Trusted scripts always come from the repository default branch.
    const checkoutStep = workflow
      .split("- name: Checkout trusted workflow code")[1]!
      .split(/\n {6}- name:/)[0]!;
    expect(checkoutStep).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkoutStep).toContain("persist-credentials: false");
    expect(checkoutStep).toContain("sparse-checkout: .github/scripts");

    const script = workflow
      .split("- name: Validate issue quality")[1]!
      .split("script: |")[1]!
      .split(/\n {6}- name:/)[0]!;

    // Invalid issue numbers fail before any issues API call.
    const invalidNumberIdx = script.indexOf("Invalid workflow_dispatch issue_number:");
    const firstIssuesGetIdx = script.indexOf("github.rest.issues.get({");
    expect(invalidNumberIdx).toBeGreaterThan(-1);
    expect(firstIssuesGetIdx).toBeGreaterThan(-1);
    expect(invalidNumberIdx).toBeLessThan(firstIssuesGetIdx);

    // Non-default-branch dispatches fail before any issues API mutation.
    const branchGuardIdx = script.indexOf("const nonDefaultBranchFailure = rejectsWorkflowDispatchNonDefaultBranch(");
    const firstMutationIdx = script.indexOf("github.rest.issues.update({");
    expect(branchGuardIdx).toBeGreaterThan(-1);
    expect(firstMutationIdx).toBeGreaterThan(-1);
    expect(branchGuardIdx).toBeLessThan(firstMutationIdx);
    expect(branchGuardIdx).toBeLessThan(firstIssuesGetIdx);

    // Pull-request numbers are rejected after issues.get and before mutations.
    const prGuardIdx = script.indexOf("const pullRequestFailure = rejectsWorkflowDispatchPullRequest(");
    const listCommentsIdx = script.indexOf("github.rest.issues.listComments");
    const addLabelsIdx = script.indexOf("github.rest.issues.addLabels");
    expect(prGuardIdx).toBeGreaterThan(-1);
    expect(prGuardIdx).toBeGreaterThan(firstIssuesGetIdx);
    expect(prGuardIdx).toBeLessThan(listCommentsIdx);
    expect(prGuardIdx).toBeLessThan(addLabelsIdx);
    expect(prGuardIdx).toBeLessThan(firstMutationIdx);
    expect(script).toContain("if (pullRequestFailure) {");
    expect(script).toContain("core.setFailed(pullRequestFailure);");

    const translateScript = workflow
      .split("- name: Prepare translation")[1]!
      .split("- name: Detect and translate")[0]!;
    const branchGuardIdxTranslate = translateScript.indexOf(
      "rejectsWorkflowDispatchNonDefaultBranch(",
    );
    const issuesGetIdxTranslate = translateScript.indexOf("github.rest.issues.get({");
    expect(branchGuardIdxTranslate).toBeGreaterThan(-1);
    expect(issuesGetIdxTranslate).toBeGreaterThan(-1);
    expect(branchGuardIdxTranslate).toBeLessThan(issuesGetIdxTranslate);
    expect(translateScript).toContain("resolveControlState");
    expect(translateScript).toContain("Never trust author-editable issue body markers");

    const applyScript = workflow
      .split("- name: Apply inline translation")[1]!
      .split("- name: Persist translation control state")[0]!;
    const staleGuardIdx = applyScript.indexOf("isPreparedSourceStillCurrent({");
    const issueUpdateIdx = applyScript.indexOf("github.rest.issues.update(");
    expect(staleGuardIdx).toBeGreaterThan(-1);
    expect(issueUpdateIdx).toBeGreaterThan(-1);
    expect(staleGuardIdx).toBeLessThan(issueUpdateIdx);
    expect(applyScript).toContain("persistTranslationControlState");
    expect(applyScript).toContain("Translation control state not persisted");
    expect(applyScript).toContain("sourceComplete");
    expect(applyScript).toContain("source remains retryable");
    expect(applyScript).toContain("missingRequiredTranslationFields");
    expect(applyScript).toContain("omitted required field(s)");
    expect(applyScript).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(applyScript.indexOf("missingRequiredTranslationFields({")).toBeLessThan(
      applyScript.indexOf("github.rest.issues.update("),
    );

    const parseStep = workflow
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline translation")[0]!;
    expect(parseStep).toContain("parse-issue-translation-response.cjs");
    expect(parseStep).not.toContain("node -e");
    expect(parseStep).not.toContain("node <<");
    // AI output must stay in env, never interpolated into the shell run script.
    expect(parseStep.split(/\n\s*run:\s*/)[1] || "").not.toContain("${{");

    const persistStep = workflow
      .split("- name: Persist translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(persistStep).toContain("always()");
    expect(persistStep).toContain("requires_translation != 'true'");
    expect(persistStep).toContain("persistTranslationControlState");
    expect(persistStep).toContain("SOURCE_COMPLETE");
    expect(persistStep).toContain("detectedLanguageForControlPersist");
    expect(persistStep).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(persistStep).toMatch(/sourceComplete,\s*\n\s*\}/);
    // Missing DETECTED_LANG on incomplete/skipped parse must not default to English.
    expect(persistStep).not.toContain('DETECTED_LANG || "English"');
    expect(persistStep).not.toContain("DETECTED_LANG || 'English'");
    expect(persistStep).not.toContain("silent_state");
    expect(persistStep).not.toContain("cleanup_comment_ids");
    expect(workflow).not.toContain("Save translation control state cache");
    expect(workflow).not.toContain("Remove migrated English control comments");
    expect(workflow).not.toContain("Restore translation control state cache");

    const commentPersist = workflow
      .split("- name: Persist comment translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentPersist).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(commentPersist).toContain("detectedLanguageForControlPersist");
    expect(commentPersist).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(commentPersist).not.toContain('DETECTED_LANG || "English"');
    expect(commentPersist).not.toContain("DETECTED_LANG || 'English'");
    const commentApplyStep = workflow
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    expect(commentApplyStep).toContain("sourceComplete");
    expect(commentApplyStep).toContain("source remains retryable");
    expect(commentApplyStep).toContain("missingRequiredTranslationFields");
    expect(commentApplyStep).toContain("omitted required field(s)");
    const commentMissingAt = commentApplyStep.indexOf("missingRequiredTranslationFields({");
    const commentUpdateAt = commentApplyStep.indexOf("updateComment");
    expect(commentMissingAt).toBeGreaterThanOrEqual(0);
    expect(commentUpdateAt).toBeGreaterThanOrEqual(0);
    expect(commentMissingAt).toBeLessThan(commentUpdateAt);

    // Helper contract: always-visible bookkeeping; sticky oldest upsert; body non-authoritative.
    const helperSrc = await readText(".github/scripts/issue-translation.cjs");
    expect(helperSrc).toContain("shouldOmitVisibleBookkeeping");
    expect(helperSrc).toContain("findStickyControlComment");
    expect(helperSrc).toContain("detectedLanguageForControlPersist");
    expect(helperSrc).toContain("Automated translation bookkeeping");
    expect(helperSrc).toContain("canonical comment first");
    expect(helperSrc).toContain("Authoritative control state comes only from verified bot-owned comments");
    expect(helperSrc).toContain("sourceComplete");
    expect(helperSrc).not.toContain("writeFileControlState");
    expect(helperSrc).not.toContain(".ocx-translation-state");
  });

  test("react-doctor.yml stays deleted; react-doctor itself remains an on-demand local tool", async () => {
    // It was a gating PR-scan workflow, and this project runs no checks in
    // Actions. The react-doctor npm devDependency and its `doctor:gui*`
    // package scripts are unaffected: `bun run lint:gui`-style on-demand
    // tooling still runs locally, it just never gates a workflow.
    await expect(Bun.file(new URL(".github/workflows/react-doctor.yml", root)).exists()).resolves.toBe(false);
    const guiPkg = await readText("gui/package.json");
    expect(guiPkg).toContain("react-doctor@0.9.2");
  });

  test("React Doctor package scripts pin the exact engine version with no @latest anywhere", async () => {
    const guiPkg = await readText("gui/package.json");
    const rootPkg = await readText("package.json");
    const doctorConfig = await readText("gui/doctor.config.json");

    expect(guiPkg).toContain("react-doctor@0.9.2");
    expect(guiPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).not.toContain("react-doctor@latest");
    expect(doctorConfig).toContain('"blocking": "warning"');
    expect(rootPkg).toContain('"doctor:gui:if-changed": "bun scripts/doctor-gui-if-changed.ts"');
    // `lint:gui` survives as the deliberate on-demand entry point, but it is not
    // wired into `prepush`: lint gates nothing, locally or in CI.
    expect(rootPkg).toContain('"lint:gui": "cd gui && bun run lint"');
    expect(rootPkg).not.toContain("bun run lint:gui && ");
    // Gating steps include React Doctor after privacy scan on gui/ pushes.
    expect(rootPkg).toContain("bun run typecheck && bun run test");
    expect(rootPkg).toContain("bun run privacy:scan && bun run doctor:gui:if-changed");
  });
});

describe("doctor-gui-if-changed", () => {
  test("guiPathsChanged is a slash-guarded gui/ prefix predicate", async () => {
    const { guiPathsChanged } = await import("../scripts/doctor-gui-if-changed");

    expect(guiPathsChanged(["gui/src/App.tsx"])).toBe(true);
    expect(guiPathsChanged(["gui"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts", "gui/package.json"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts"])).toBe(false);
    expect(guiPathsChanged(["guitools/x.ts"])).toBe(false);
    expect(guiPathsChanged([])).toBe(false);
  });

  test("looksLikeDoctorInfraFailure detects registry/network outages", async () => {
    const { looksLikeDoctorInfraFailure } = await import("../scripts/doctor-gui-if-changed");
    expect(looksLikeDoctorInfraFailure("npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org")).toBe(true);
    expect(looksLikeDoctorInfraFailure("npm ERR! code ECONNRESET")).toBe(true);
    expect(looksLikeDoctorInfraFailure("npm ERR! network timeout")).toBe(true);
    expect(looksLikeDoctorInfraFailure("All 2 issues\nBugs > 1 errors")).toBe(false);
    // Findings copy can mention "network" without being an infra outage.
    expect(looksLikeDoctorInfraFailure("Network requests > 1 errors")).toBe(false);
  });

  test("DRY_RUN prints the run/skip decision without spawning the doctor", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("doctor:run");

    const skip = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("doctor:skip");
  });

  test("degrades gracefully when the doctor engine is unavailable (offline prepush)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "definitely-not-a-real-command-xyz",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping scan");
  });

  test("soft-skips when doctor exits nonzero due to a registry/network failure", () => {
    // Simulate `bun run doctor` starting, then npx failing offline: numeric status
    // plus registry noise in stderr — must not gate the push.
    // cwd for DOCTOR_CMD is gui/, so reach fixtures via ../scripts/...
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-offline-exit.ts",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping scan");
  });

  test("propagates a non-zero doctor exit so findings gate the push", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-findings-exit.ts",
      },
    });
    expect(run.exitCode).not.toBe(0);
  });

  test("isDoctorBufferOverflow recognizes ENOBUFS / maxBuffer errors", async () => {
    const { isDoctorBufferOverflow } = await import("../scripts/doctor-gui-if-changed");
    expect(isDoctorBufferOverflow("ENOBUFS")).toBe(true);
    expect(isDoctorBufferOverflow("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")).toBe(true);
    expect(isDoctorBufferOverflow("ENOENT")).toBe(false);
    expect(isDoctorBufferOverflow(undefined)).toBe(false);
  });

  test("hard-fails when doctor output exceeds maxBuffer (does not soft-skip)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-huge-output.ts",
        // Tiny buffer so the fixture's stdout trips the overflow branch.
        OCX_DOCTOR_MAX_BUFFER: "256",
      },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("exceeded buffer");
  });
});

describe("workflow package scripts", () => {
  // The defect this pins: the Go-port lane added workflow steps calling `npm run
  // verify:native-package` and `npm run build:publish`, but the merge that brought the workflow
  // half onto this line left the package.json half behind. Nothing failed until Windows CI ran
  // and npm reported `Missing script`, because a workflow naming a script and a package.json
  // defining one were wired at opposite ends with no check in between. A script that exists in
  // neither package.json is the failure; which of the two holds it is a per-step working
  // directory decision the runner makes, so the union is the honest target here.
  test("every script a workflow invokes is defined in package.json", async () => {
    const workflows = [
      "auto-release.yml",
      "cheap-lfs-cloud-compression.yml",
      "ci.yml",
      "deploy-docs.yml",
      "desktop-installer.yml",
      "enforce-issue-quality.yml",
      "enforce-pr-target.yml",
      "go-ci.yml",
      "gui-preview.yml",
      "issue-triage.yml",
      "pr-labeler.yml",
      "release.yml",
      "stale-needs-info.yml",
      "super-express-release.yml",
    ];
    const rootScripts = Object.keys(
      (JSON.parse(await readText("package.json")) as { scripts: Record<string, string> }).scripts,
    );
    const guiScripts = Object.keys(
      (JSON.parse(await readText("gui/package.json")) as { scripts: Record<string, string> }).scripts,
    );
    const defined = new Set([...rootScripts, ...guiScripts]);

    const missing: string[] = [];
    for (const file of workflows) {
      const text = await readText(`.github/workflows/${file}`);
      // `bun run scripts/x.ts` runs a FILE, not a named script: a token carrying a path
      // separator or a source extension is not a package.json entry and never should be.
      for (const match of text.matchAll(/\b(?:npm|bun) run ([A-Za-z][A-Za-z0-9:_-]*)(?![A-Za-z0-9:_./-])/g)) {
        const name = match[1]!;
        if (!defined.has(name)) missing.push(`${file}: ${name}`);
      }
    }

    expect(missing).toEqual([]);
  });

  test("the native package and publish scripts the release path needs are present", async () => {
    const scripts = (JSON.parse(await readText("package.json")) as { scripts: Record<string, string> }).scripts;
    // Each one is called by name from a workflow step, so a rename here is a red CI run there.
    expect(scripts["verify:native-package"]).toBe("bun scripts/prepare-package.ts --verify-pack pack.json");
    expect(scripts["verify:native-install"]).toBe("node scripts/verify-native-install.mjs pack.json");
    expect(scripts["prepare:native-package"]).toBe("bun scripts/prepare-package.ts --native");
    expect(scripts["test:native-launcher"]).toBe("node --test scripts/ocx-native-launcher.test.mjs");
    expect(scripts["build:publish"]).toContain("build:gui");
  });
});

describe("workflow history depth", () => {
  /**
   * The defect this pins: `auto-release.yml` and `super-express-release.yml` both build release
   * notes with `scripts/count-lines.ts`, whose line attribution walks `git blame` over the whole
   * history and throws "the repository is shallow" rather than publishing a partial count.
   * Neither checkout asked for history, so both failed on every run — and failed late, after the
   * Windows installer had already been built and verified unsigned, which is the expensive part.
   * `release.yml` had `fetch-depth: 0` all along, so the requirement was known; it simply was not
   * carried to the two workflows that copied the notes step.
   *
   * Checked against the parsed document, not the file text: a comment mentioning the script, or a
   * `fetch-depth: 0` sitting on some unrelated checkout, would both fool a grep.
   */
  test("a workflow that counts attributed lines checks out complete history", async () => {
    const files = [
      "auto-release.yml",
      "release.yml",
      "super-express-release.yml",
      "ci.yml",
      "go-ci.yml",
      "gui-preview.yml",
      "desktop-installer.yml",
      "cheap-lfs-cloud-compression.yml",
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const parsed = Bun.YAML.parse(await readText(`.github/workflows/${file}`)) as WorkflowDocument;
      const steps = Object.values(parsed.jobs ?? {}).flatMap(job => job.steps ?? []);
      const needsHistory = steps.some(step => (step.run ?? "").includes("scripts/count-lines.ts"));
      if (!needsHistory) continue;

      const checkouts = steps.filter(step => (step.uses ?? "").startsWith("actions/checkout@"));
      if (checkouts.length === 0) {
        offenders.push(`${file}: counts lines but never checks the repository out`);
        continue;
      }
      for (const checkout of checkouts) {
        const depth = checkout.with?.["fetch-depth"];
        if (depth !== 0) offenders.push(`${file}: ${checkout.name ?? "checkout"} has fetch-depth ${String(depth)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
