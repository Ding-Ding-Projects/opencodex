import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { nativeArtifactNames } from "./prepare-package";

const MAX_OUTPUT = 256 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

function fail(message: string): never {
  throw new Error(message);
}

type CommandResult = { stdout: string; stderr: string; status: number };

function commandTimeout(): number {
  const requested = Number(process.env.OCX_RELEASE_COMMAND_TIMEOUT_MS ?? COMMAND_TIMEOUT_MS);
  return Number.isSafeInteger(requested) && requested >= 50 && requested <= COMMAND_TIMEOUT_MS
    ? requested
    : COMMAND_TIMEOUT_MS;
}

function run(command: string, args: string[], allowFailure = false): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: commandTimeout(),
    maxBuffer: MAX_OUTPUT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  const status = result.status ?? 1;
  const output = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status };
  if (status !== 0 && !allowFailure) {
    fail(`${command} exited ${status}: ${output.stderr.trim() || output.stdout.trim()}`);
  }
  return output;
}

function packageVersion(): string {
  const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    fail("package.json has an invalid version");
  }
  return value.version;
}

function parseArgs(argv: string[]): Record<string, string> {
  const names = ["repository", "tag", "sha", "title", "notes", "prerelease", "archive", "archive-sha256", "native-dir"];
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values[key]) fail("invalid reconciliation arguments");
    values[key] = value;
  }
  if (Object.keys(values).length !== names.length || names.some(name => !values[`--${name}`])) {
    fail("invalid reconciliation arguments");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values["--repository"])) fail("invalid repository");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(values["--tag"])) fail("invalid tag");
  if (!/^[0-9a-f]{40}$/.test(values["--sha"])) fail("invalid commit SHA");
  if (/[\0\r\n]/.test(values["--title"])) fail("invalid title");
  if (!/^[0-9a-f]{64}$/.test(values["--archive-sha256"])) fail("invalid archive SHA-256");
  if (!/^(true|false)$/.test(values["--prerelease"])) fail("invalid prerelease value");
  const version = packageVersion();
  if (values["--tag"] !== `v${version}`) fail("tag does not match package version");
  return values;
}

type Asset = { name: string };
type Release = {
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string | null;
  assets: Asset[];
};

function verifyLocal(args: Record<string, string>, nativeDir = args["--native-dir"]): void {
  run(process.execPath, [
    fileURLToPath(new URL("prepare-release-assets.ts", import.meta.url)),
    "verify",
    "--archive", args["--archive"],
    "--sha256", args["--archive-sha256"],
    "--native-dir", nativeDir,
  ]);
}

function remoteTag(args: Record<string, string>): "absent" | "exact" {
  const tag = args["--tag"];
  const result = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const shas = result.stdout.split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/, 1)[0]!);
  if (shas.length === 0) return "absent";
  if (shas.some(sha => sha !== args["--sha"]) || new Set(shas).size !== 1) fail("remote tag conflicts with release SHA");
  return "exact";
}

function releaseState(args: Record<string, string>): Release | null {
  const result = run("gh", ["api", `repos/${args["--repository"]}/releases/tags/${args["--tag"]}`], true);
  if (result.status !== 0) {
    if (/HTTP 404|not found/i.test(result.stderr)) return null;
    fail(`gh release lookup failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  let release: Release;
  try { release = JSON.parse(result.stdout) as Release; } catch { fail("GitHub Release returned invalid JSON"); }
  const notes = readFileSync(args["--notes"], "utf8");
  if (release.tag_name !== args["--tag"] || release.name !== args["--title"] || release.body !== notes
    || release.prerelease !== (args["--prerelease"] === "true")) {
    fail("GitHub Release metadata conflicts with release candidate");
  }
  if (!Array.isArray(release.assets) || release.assets.some(asset => !asset || typeof asset.name !== "string")) {
    fail("GitHub Release assets are invalid");
  }
  if (release.draft ? release.published_at !== null : typeof release.published_at !== "string") {
    fail("GitHub Release publication state is inconsistent");
  }
  return release;
}

function expectedAssets(version: string, nativeDir: string): { names: string[]; paths: string[] } {
  const names = [...nativeArtifactNames(version), `ocx_${version}_checksums.txt`];
  return { names, paths: names.map(name => join(nativeDir, name)) };
}

function validateInventory(release: Release, names: string[], requireExact: boolean): void {
  const actual = release.assets.map(asset => asset.name);
  if (new Set(actual).size !== actual.length || actual.some(name => !names.includes(name))) {
    fail("GitHub Release contains duplicate or unexpected assets");
  }
  if (requireExact && (actual.length !== names.length || names.some(name => !actual.includes(name)))) {
    fail("GitHub Release asset inventory is incomplete");
  }
}

function downloadAndVerify(args: Record<string, string>, names: string[]): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-release-download-"));
  try {
    for (const name of names) {
      run("gh", ["release", "download", args["--tag"], "--repo", args["--repository"], "--pattern", name, "--dir", root]);
    }
    const entries = lstatSync(root).isDirectory() ? names.map(name => join(root, name)) : [];
    for (const path of entries) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`downloaded release asset is not regular: ${basename(path)}`);
      chmodSync(path, path.endsWith("checksums.txt") ? 0o644 : 0o755);
    }
    verifyLocal(args, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function remoteAssetMatches(args: Record<string, string>, name: string, localPath: string): boolean {
  const root = mkdtempSync(join(tmpdir(), "ocx-release-compare-"));
  try {
    run("gh", ["release", "download", args["--tag"], "--repo", args["--repository"], "--pattern", name, "--dir", root]);
    const remote = join(root, name);
    const stat = lstatSync(remote);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`downloaded release asset is not regular: ${name}`);
    return readFileSync(remote).equals(readFileSync(localPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function exactPublished(args: Record<string, string>, names: string[]): Release {
  if (remoteTag(args) !== "exact") fail("remote tag disappeared during reconciliation");
  const release = releaseState(args);
  if (!release || release.draft || release.published_at === null) fail("GitHub Release is not published");
  validateInventory(release, names, true);
  downloadAndVerify(args, names);
  if (remoteTag(args) !== "exact") fail("remote tag changed during final verification");
  const finalRelease = releaseState(args);
  if (!finalRelease || finalRelease.draft || finalRelease.published_at === null) fail("GitHub Release changed during final verification");
  validateInventory(finalRelease, names, true);
  if (remoteTag(args) !== "exact") fail("remote tag changed before reconciliation completed");
  return finalRelease;
}

function beforeMutation(args: Record<string, string>, expectedRelease: "absent" | "draft"): void {
  verifyLocal(args);
  const tag = remoteTag(args);
  const release = releaseState(args);
  if (expectedRelease === "absent") {
    if (release !== null) fail("GitHub Release appeared before mutation");
    if (tag !== "exact") fail("remote tag is not exact before release mutation");
  } else {
    if (tag !== "exact" || !release || !release.draft) fail("draft release changed before mutation");
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const version = packageVersion();
  const { names, paths } = expectedAssets(version, args["--native-dir"]);
  verifyLocal(args);
  let tag = remoteTag(args);
  let release = releaseState(args);

  if (!release) {
    if (tag === "absent") {
      verifyLocal(args);
      if (remoteTag(args) !== "absent") fail("remote tag appeared before local tag creation");
      const local = run("git", ["rev-parse", "-q", "--verify", `refs/tags/${args["--tag"]}^{commit}`], true);
      if (local.status === 0 && local.stdout.trim() !== args["--sha"]) fail("local tag conflicts with release SHA");
      if (local.status !== 0) run("git", ["tag", args["--tag"], args["--sha"]]);
      verifyLocal(args);
      if (remoteTag(args) !== "absent") fail("remote tag appeared before push");
      run("git", ["push", "origin", `refs/tags/${args["--tag"]}`]);
      if (remoteTag(args) !== "exact") fail("remote tag push did not resolve to release SHA");
      tag = "exact";
    }
    if (tag !== "exact") fail("remote tag is not exact");
    beforeMutation(args, "absent");
    const createArgs = ["release", "create", args["--tag"], ...paths, "--repo", args["--repository"], "--verify-tag", "--title", args["--title"], "--notes-file", args["--notes"]];
    if (args["--prerelease"] === "true") createArgs.push("--prerelease");
    run("gh", createArgs);
    release = releaseState(args);
    if (!release) fail("GitHub Release was not created");
  }

  validateInventory(release, names, !release.draft);
  if (!release.draft) {
    exactPublished(args, names);
    process.stdout.write(`verified published release ${args["--tag"]}\n`);
    return;
  }

  const present = new Set(release.assets.map(asset => asset.name));
  const repair = paths.filter(path => {
    const name = basename(path);
    return !present.has(name) || !remoteAssetMatches(args, name, path);
  });
  if (repair.length > 0) {
    beforeMutation(args, "draft");
    run("gh", ["release", "upload", args["--tag"], ...repair, "--repo", args["--repository"], "--clobber"]);
  }
  release = releaseState(args);
  if (!release || !release.draft) fail("draft release changed before verification");
  validateInventory(release, names, true);
  downloadAndVerify(args, names);
  beforeMutation(args, "draft");
  release = releaseState(args);
  if (!release) fail("draft release disappeared before publication");
  validateInventory(release, names, true);
  run("gh", ["release", "edit", args["--tag"], "--repo", args["--repository"], "--draft=false"]);
  exactPublished(args, names);
  process.stdout.write(`reconciled published release ${args["--tag"]}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
