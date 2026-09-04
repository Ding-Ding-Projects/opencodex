import { describe, expect, test } from "bun:test";

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { "runs-on"?: unknown; steps?: Step[] }>;
};

const root = new URL("../", import.meta.url);

const RELEASE_WORKFLOWS = [
  ".github/workflows/auto-release.yml",
  ".github/workflows/release.yml",
  ".github/workflows/super-express-release.yml",
] as const;

const WINDOWS_ARTIFACT_WORKFLOWS = [
  ...RELEASE_WORKFLOWS,
  ".github/workflows/desktop-installer.yml",
] as const;

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function parse(text: string): Workflow {
  return Bun.YAML.parse(text) as Workflow;
}

function steps(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs ?? {}).flatMap(job => job.steps ?? []);
}

function commandText(step: Step): string {
  return `${step.name ?? ""}\n${step.run ?? ""}`;
}

function expectBuildOnlyWorkflow(path: string, workflow: Workflow): void {
  const forbidden = /(?:^|&&|\|\||;)\s*(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint(?::[\w-]+)?|typecheck|static[- ]analysis)\b|(?:pytest|vitest|jest|go\s+test|cargo\s+test|eslint|actionlint|shellcheck|react-doctor|codeql)\b)/im;
  const externalQualityWait = /gh\s+run\s+(?:list|watch)\b[^\n]*(?:ci\.yml|test|lint|typecheck|static[- ]analysis|codeql)/i;
  const offenders = steps(workflow)
    .filter(step => forbidden.test(commandText(step)) || externalQualityWait.test(step.run ?? ""))
    .map(step => step.name ?? "(unnamed)");
  expect(offenders, `${path} may build, package, publish, and retain evidence only`).toEqual([]);
}

function expectWindowsOnly(path: string, workflow: Workflow): void {
  const jobs = Object.entries(workflow.jobs ?? {});
  expect(jobs.length, `${path} must retain at least one job`).toBeGreaterThan(0);
  for (const [jobName, job] of jobs) {
    expect(job["runs-on"], `${path}:${jobName} must use the Windows delivery target`).toBe(
      "windows-latest",
    );
  }
}

function expectReleasePublication(path: string, workflow: Workflow): void {
  const allSteps = steps(workflow);
  const publicationCommands = allSteps.flatMap(step => step.run?.match(/gh release create\b/g) ?? []);
  expect(publicationCommands.length, `${path} must contain exactly one release creation command`).toBe(1);
  const publication = allSteps.find(step => /gh release create\b/.test(step.run ?? ""))!;
  expect(publication, `${path} must retain its publication step`).toBeDefined();
  const run = publication.run ?? "";
  const token = JSON.stringify(workflow);

  expect(token, `${path} must use the complete additive release token chain`).toContain(
    "secrets.RELEASE_TOKEN || secrets.ORG_TOKEN || secrets.GITHUB_TOKEN",
  );
  expect(run, `${path} must publish the exact checked-out SHA`).toMatch(
    /gh release create[\s\S]{0,800}?--target\s+["']?\$(?:\{(?:GITHUB_SHA|SHA|sha)\}|(?:GITHUB_SHA|SHA|sha)\b)/i,
  );
  expect(run, `${path} must never create a draft`).not.toMatch(/(?:^|\s)--draft(?:\s|$)/m);
  const publicationIndex = allSteps.indexOf(publication);
  const prePublicationCommands = allSteps
    .slice(0, publicationIndex + 1)
    .map(step => step.run ?? "")
    .join("\n");
  expect(prePublicationCommands, `${path} must query for a pre-existing release before creation`).toMatch(
    /gh release view\b/,
  );
}

function expectReleaseEvidence(path: string, text: string): void {
  expect(text, `${path} must measure line counts at the released commit`).toContain(
    "scripts/count-lines.ts",
  );
  expect(text, `${path} must record the workflow start`).toContain("Workflow started");
  expect(text, `${path} must record release publication completion`).toContain("Workflow completed");
  expect(text, `${path} must record a stable duration`).toContain("Workflow duration");
}

function expectSafeArtifactEvidence(path: string, workflow: Workflow): void {
  const uploads = steps(workflow).filter(step => step.uses?.startsWith("actions/upload-artifact@"));
  expect(uploads.length, `${path} must retain bounded failure evidence`).toBeGreaterThan(0);
  for (const upload of uploads) {
    expect(String(upload.if ?? ""), `${path}:${upload.name} must survive an earlier failure`).toContain(
      "always()",
    );
    expect(upload["continue-on-error"], `${path}:${upload.name} must not mask the original failure`).toBe(
      true,
    );
    expect(upload.with?.["if-no-files-found"], `${path}:${upload.name} must report absent evidence`).toBe(
      "warn",
    );
    expect(Number(upload.with?.["retention-days"]), `${path}:${upload.name} retention must be bounded`).toBeGreaterThan(
      0,
    );
  }
}

describe("release workflow contract", () => {
  test("the hand-written workflow inventory is build-only and Windows-only", async () => {
    for (const path of WINDOWS_ARTIFACT_WORKFLOWS) {
      const workflow = parse(await source(path));
      expectBuildOnlyWorkflow(path, workflow);
      expectWindowsOnly(path, workflow);
      expectSafeArtifactEvidence(path, workflow);
    }
  });

  test("all publishers create one exact-SHA, unique, non-draft release with complete evidence", async () => {
    for (const path of RELEASE_WORKFLOWS) {
      const text = await source(path);
      const workflow = parse(text);
      expectReleasePublication(path, workflow);
      expectReleaseEvidence(path, text);
    }
  });

  test("packaging is permanently unsigned Squirrel.Windows", async () => {
    const config = await source("electron-builder.yml");
    expect(config).toMatch(/target:\s*squirrel\b/);
    expect(config).toMatch(/forceCodeSigning:\s*false\b/);
    expect(config).toMatch(/signExecutable:\s*false\b/);

    for (const path of WINDOWS_ARTIFACT_WORKFLOWS) {
      const text = await source(path);
      const workflow = parse(text);
      expect(text, `${path} must produce Squirrel.Windows artifacts`).toMatch(
        /squirrel|Setup\.exe|\*-full\.nupkg/i,
      );
      expect(text, `${path} must verify that setup executables are unsigned`).toMatch(
        /NotSigned|unsigned/i,
      );
      expect(text, `${path} must not discover or invoke a signer`).not.toMatch(
        /certificateFile|certificatePassword|signtool/i,
      );
      for (const step of steps(workflow)) {
        for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) {
          if (key in (step.env ?? {})) {
            expect(step.env?.[key], `${path}:${step.name} must clear ${key}`).toBe("");
          }
        }
      }
    }
  });

  test("release notes link the public dim-sum catalog without copied consumer assets", async () => {
    const resolver = await source("scripts/release-codename.ts");
    expect(resolver).toContain("Ding-Ding-Projects/dim-sum-photos");
    expect(resolver).toContain("catalog-v1");

    for (const path of RELEASE_WORKFLOWS) {
      const text = await source(path);
      const workflow = parse(text);
      const resolutionSteps = steps(workflow).filter(step =>
        /bun\s+scripts\/release-codename\.ts\b/.test(step.run ?? ""),
      );
      expect(resolutionSteps.length, `${path} must use the authoritative public catalog resolver`).toBe(1);
      expect(text, `${path} must not read a consumer-local photo`).not.toMatch(
        /gui\/public\/dimsum|gui[\\/]public[\\/]dimsum/i,
      );
      expect(text, `${path} must not attach a copied photo`).not.toMatch(
        /["']?[^\s"']*(?:dim[-_ ]?sum|dimsum)[^\s"']*\.(?:png|jpe?g|webp)["']?/i,
      );
    }
  });

  test("the negative helpers turn red when a job changes platform or gains analysis", () => {
    const wrongPlatform: Workflow = { jobs: { release: { "runs-on": "ubuntu-latest", steps: [] } } };
    expect(() => expectWindowsOnly("mutation", wrongPlatform)).toThrow();

    const analysisAdded: Workflow = {
      jobs: { release: { "runs-on": "windows-latest", steps: [{ name: "Lint", run: "bun run lint:gui" }] } },
    };
    expect(() => expectBuildOnlyWorkflow("mutation", analysisAdded)).toThrow();
  });

  test("the publication helper turns red for duplicate or draft creation", () => {
    const baseRun = 'gh release view "$tag" && exit 1\ngh release create "$tag" --target "$SHA"';
    const base: Workflow = {
      jobs: {
        release: {
          "runs-on": "windows-latest",
          steps: [{ env: { GH_TOKEN: "secrets.RELEASE_TOKEN || secrets.ORG_TOKEN || secrets.GITHUB_TOKEN" }, run: baseRun }],
        },
      },
    };
    expect(() => expectReleasePublication("mutation", base)).not.toThrow();

    const duplicate: Workflow = {
      jobs: {
        release: {
          "runs-on": "windows-latest",
          steps: [
            {
              env: { GH_TOKEN: "secrets.RELEASE_TOKEN || secrets.ORG_TOKEN || secrets.GITHUB_TOKEN" },
              run: `${baseRun}\ngh release create "$tag-2" --target "$SHA"`,
            },
          ],
        },
      },
    };
    expect(() => expectReleasePublication("mutation", duplicate)).toThrow();

    const draft: Workflow = structuredClone(base);
    draft.jobs!.release.steps![0].run = `${baseRun} \\\n  --draft`;
    expect(() => expectReleasePublication("mutation", draft)).toThrow();
  });
});
