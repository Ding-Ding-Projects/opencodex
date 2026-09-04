import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { nativeArtifactNames } from "./prepare-package";

const MAX_OUTPUT = 256 * 1024;
const MAX_BINARY_SIZE = 40 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 1024 * 1024;
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

type PackageIdentity = { name: string; version: string };

function packageIdentity(): PackageIdentity {
  const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof value.name !== "string" || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(value.name)) {
    fail("package.json has an invalid package name");
  }
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    fail("package.json has an invalid version");
  }
  return { name: value.name, version: value.version };
}

function parseArgs(argv: string[]): Record<string, string> {
  const names = [
    "repository", "tag", "sha", "title", "notes", "prerelease", "archive", "archive-sha256", "native-dir",
    "npm-tag", "npm-integrity",
  ];
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
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(values["--npm-tag"])) fail("invalid npm dist-tag");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(values["--npm-integrity"])) fail("invalid npm integrity");
  const { version } = packageIdentity();
  if (values["--tag"] !== `v${version}`) fail("tag does not match package version");
  return values;
}

type Asset = { id: number; name: string; size: number; digest: string | null };
type Release = {
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string | null;
  assets: Asset[];
};
type LocalAsset = { name: string; path: string; size: number; sha256: string; cap: number };

function verifyLocal(args: Record<string, string>): void {
  run(process.execPath, [
    fileURLToPath(new URL("prepare-release-assets.ts", import.meta.url)),
    "verify",
    "--archive", args["--archive"],
    "--sha256", args["--archive-sha256"],
    "--native-dir", args["--native-dir"],
  ]);
}

function verifyNpm(args: Record<string, string>): void {
  const identity = packageIdentity();
  const immutable = run("npm", ["view", `${identity.name}@${identity.version}`, "dist.integrity", "--json"]);
  let integrity: unknown;
  try { integrity = JSON.parse(immutable.stdout); } catch { fail("npm immutable integrity returned invalid JSON"); }
  if (integrity !== args["--npm-integrity"]) fail("npm immutable integrity changed during reconciliation");
  const mutable = run("npm", ["view", identity.name, `dist-tags.${args["--npm-tag"]}`, "--json"]);
  let tagged: unknown;
  try { tagged = JSON.parse(mutable.stdout); } catch { fail("npm dist-tag returned invalid JSON"); }
  if (tagged !== identity.version) fail(`npm dist-tag ${args["--npm-tag"]} moved during reconciliation`);
}

function remoteTag(args: Record<string, string>): "absent" | "exact" {
  const tag = args["--tag"];
  const result = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const refs = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [sha, ref, extra] = line.trim().split(/\s+/);
    if (!sha || !ref || extra || !/^[0-9a-f]{40}$/.test(sha)) fail("remote tag lookup returned invalid output");
    refs.set(ref, sha);
  }
  if (refs.size === 0) return "absent";
  const direct = refs.get(`refs/tags/${tag}`);
  const peeled = refs.get(`refs/tags/${tag}^{}`);
  if (!direct || (peeled ? peeled !== args["--sha"] : direct !== args["--sha"])) {
    fail("remote tag conflicts with release SHA");
  }
  if (refs.size !== (peeled ? 2 : 1)) fail("remote tag lookup returned unexpected refs");
  return "exact";
}

function parseAsset(value: unknown): Asset {
  if (!value || typeof value !== "object") fail("GitHub Release asset is invalid");
  const candidate = value as Record<string, unknown>;
  const digest = candidate.digest === null || candidate.digest === undefined ? null : candidate.digest;
  if (!Number.isSafeInteger(candidate.id) || (candidate.id as number) <= 0
    || typeof candidate.name !== "string" || !candidate.name
    || !Number.isSafeInteger(candidate.size) || (candidate.size as number) < 0
    || (digest !== null && (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)))) {
    fail("GitHub Release asset is invalid");
  }
  return { id: candidate.id as number, name: candidate.name, size: candidate.size as number, digest: digest as string | null };
}

function releaseState(args: Record<string, string>): Release | null {
  const result = run("gh", ["api", `repos/${args["--repository"]}/releases/tags/${args["--tag"]}`], true);
  if (result.status !== 0) {
    if (/HTTP 404|not found/i.test(result.stderr)) return null;
    fail(`gh release lookup failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { fail("GitHub Release returned invalid JSON"); }
  if (!raw || typeof raw !== "object") fail("GitHub Release returned invalid JSON");
  const candidate = raw as Record<string, unknown>;
  const notes = readFileSync(args["--notes"], "utf8");
  if (candidate.tag_name !== args["--tag"] || candidate.name !== args["--title"] || candidate.body !== notes
    || candidate.prerelease !== (args["--prerelease"] === "true")) {
    fail("GitHub Release metadata conflicts with release candidate");
  }
  if (!Array.isArray(candidate.assets)) fail("GitHub Release assets are invalid");
  const draft = candidate.draft;
  const publishedAt = candidate.published_at;
  if (typeof draft !== "boolean" || (draft ? publishedAt !== null : typeof publishedAt !== "string")) {
    fail("GitHub Release publication state is inconsistent");
  }
  return {
    tag_name: candidate.tag_name as string,
    name: candidate.name as string,
    body: candidate.body as string,
    prerelease: candidate.prerelease as boolean,
    draft,
    published_at: publishedAt as string | null,
    assets: candidate.assets.map(parseAsset),
  };
}

async function hashLocal(path: string, cap: number, label: string): Promise<{ size: number; sha256: string }> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) fail(`${label} is not a bounded regular file`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > cap) fail(`${label} exceeds ${cap} bytes`);
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

async function expectedAssets(version: string, nativeDir: string): Promise<LocalAsset[]> {
  const names = [...nativeArtifactNames(version), `ocx_${version}_checksums.txt`];
  return Promise.all(names.map(async name => {
    const path = join(nativeDir, name);
    const cap = name.endsWith(".txt") ? MAX_MANIFEST_SIZE : MAX_BINARY_SIZE;
    return { name, path, cap, ...(await hashLocal(path, cap, `local release asset ${name}`)) };
  }));
}

function validateInventory(release: Release, local: LocalAsset[], requireExact: boolean): void {
  const expected = new Map(local.map(asset => [asset.name, asset]));
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const asset of release.assets) {
    if (ids.has(asset.id) || names.has(asset.name) || !expected.has(asset.name)) {
      fail("GitHub Release contains duplicate or unexpected assets");
    }
    ids.add(asset.id);
    names.add(asset.name);
    const canonical = expected.get(asset.name)!;
    if (asset.size > canonical.cap) fail(`GitHub Release asset exceeds bound: ${asset.name}`);
  }
  if (requireExact && (release.assets.length !== local.length || local.some(asset => !names.has(asset.name)))) {
    fail("GitHub Release asset inventory is incomplete");
  }
}

function assetIdentity(release: Release): string {
  return JSON.stringify([...release.assets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name, size, digest }) => ({ id, name, size, digest })));
}

async function downloadAsset(args: Record<string, string>, remote: Asset, local: LocalAsset, path: string): Promise<void> {
  if (remote.size !== local.size) fail(`GitHub Release asset size mismatch: ${remote.name}`);
  if (remote.digest && remote.digest !== `sha256:${local.sha256}`) fail(`GitHub Release asset digest mismatch: ${remote.name}`);
  const fd = openSync(path, "wx", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("gh", [
        "api", `repos/${args["--repository"]}/releases/assets/${remote.id}`,
        "-H", "Accept: application/octet-stream",
      ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      const hash = createHash("sha256");
      let size = 0;
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) { settled = true; reject(new Error("gh asset download timed out")); }
      }, commandTimeout());
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        stderr += String(chunk);
        if (Buffer.byteLength(stderr) > MAX_OUTPUT) child.kill("SIGKILL");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > local.cap || size > remote.size) {
          child.kill("SIGKILL");
          return;
        }
        hash.update(chunk);
        writeSync(fd, chunk);
      });
      child.on("error", error => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(error); }
      });
      child.on("close", status => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (status !== 0) return reject(new Error(`gh asset download failed: ${stderr.trim() || `exit ${status}`}`));
        if (size !== remote.size || size !== local.size) return reject(new Error(`downloaded asset size mismatch: ${remote.name}`));
        if (hash.digest("hex") !== local.sha256) return reject(new Error(`downloaded asset SHA-256 mismatch: ${remote.name}`));
        resolve();
      });
    });
  } finally {
    closeSync(fd);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== local.size) fail(`downloaded release asset is invalid: ${remote.name}`);
}

async function proveRemoteAssets(args: Record<string, string>, release: Release, local: LocalAsset[]): Promise<void> {
  validateInventory(release, local, true);
  const before = assetIdentity(release);
  const root = mkdtempSync(join(tmpdir(), "ocx-release-download-"));
  try {
    for (const canonical of local) {
      const remote = release.assets.find(asset => asset.name === canonical.name)!;
      const output = join(root, canonical.name);
      await downloadAsset(args, remote, canonical, output);
      chmodSync(output, canonical.name.endsWith(".txt") ? 0o644 : 0o755);
    }
    const after = releaseState(args);
    if (!after || assetIdentity(after) !== before) fail("GitHub Release asset identity changed during verification");
    validateInventory(after, local, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function beforeMutation(
  args: Record<string, string>,
  expectedRelease: "absent" | "draft",
  expectedIdentity?: string,
): Release | null {
  verifyLocal(args);
  verifyNpm(args);
  const tag = remoteTag(args);
  const release = releaseState(args);
  if (expectedRelease === "absent") {
    if (release !== null) fail("GitHub Release appeared before mutation");
    if (tag !== "exact") fail("remote tag is not exact before release mutation");
    return null;
  }
  if (tag !== "exact" || !release || !release.draft) fail("draft release changed before mutation");
  if (expectedIdentity !== undefined && assetIdentity(release) !== expectedIdentity) {
    fail("draft release asset identity changed before mutation");
  }
  return release;
}

async function exactPublished(args: Record<string, string>, local: LocalAsset[]): Promise<Release> {
  verifyNpm(args);
  if (remoteTag(args) !== "exact") fail("remote tag disappeared during reconciliation");
  const release = releaseState(args);
  if (!release || release.draft || release.published_at === null) fail("GitHub Release is not published");
  const identity = assetIdentity(release);
  await proveRemoteAssets(args, release, local);
  verifyNpm(args);
  if (remoteTag(args) !== "exact") fail("remote tag changed during final verification");
  const finalRelease = releaseState(args);
  if (!finalRelease || finalRelease.draft || finalRelease.published_at === null
    || assetIdentity(finalRelease) !== identity) {
    fail("GitHub Release changed during final verification");
  }
  validateInventory(finalRelease, local, true);
  return finalRelease;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const identity = packageIdentity();
  const local = await expectedAssets(identity.version, args["--native-dir"]);
  verifyLocal(args);
  verifyNpm(args);
  let tag = remoteTag(args);
  let release = releaseState(args);

  if (!release && tag === "absent") {
    const localTag = run("git", ["rev-parse", "-q", "--verify", `refs/tags/${args["--tag"]}^{commit}`], true);
    if (localTag.status === 0 && localTag.stdout.trim() !== args["--sha"]) fail("local tag conflicts with release SHA");
    if (localTag.status !== 0) run("git", ["tag", args["--tag"], args["--sha"]]);
    verifyLocal(args);
    verifyNpm(args);
    if (remoteTag(args) !== "absent" || releaseState(args) !== null) fail("remote release state appeared before tag push");
    run("git", ["push", "origin", `refs/tags/${args["--tag"]}`]);
    if (remoteTag(args) !== "exact") fail("remote tag push did not resolve to release SHA");
    tag = "exact";
  }

  if (!release) {
    if (tag !== "exact") fail("remote tag is not exact");
    beforeMutation(args, "absent");
    const createArgs = [
      "release", "create", args["--tag"], "--repo", args["--repository"], "--verify-tag", "--draft",
      "--title", args["--title"], "--notes-file", args["--notes"],
    ];
    if (args["--prerelease"] === "true") createArgs.push("--prerelease");
    run("gh", createArgs);
    release = releaseState(args);
    if (!release || !release.draft || release.assets.length !== 0) fail("GitHub draft Release was not created empty");
  }

  validateInventory(release, local, !release.draft);
  if (!release.draft) {
    await exactPublished(args, local);
    process.stdout.write(`verified published release ${args["--tag"]}\n`);
    return;
  }

  for (const canonical of local) {
    let current = releaseState(args);
    if (!current || !current.draft) fail("draft release changed during repair");
    validateInventory(current, local, false);
    let remote = current.assets.find(asset => asset.name === canonical.name);
    if (remote) {
      let matches = remote.size === canonical.size && (!remote.digest || remote.digest === `sha256:${canonical.sha256}`);
      if (matches) {
        const snapshot = assetIdentity(current);
        try {
          const root = mkdtempSync(join(tmpdir(), "ocx-release-compare-"));
          try { await downloadAsset(args, remote, canonical, join(root, canonical.name)); }
          finally { rmSync(root, { recursive: true, force: true }); }
          const after = releaseState(args);
          if (!after || assetIdentity(after) !== snapshot) fail("GitHub Release asset identity changed during draft verification");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/downloaded asset (?:size|SHA-256) mismatch/.test(message)) throw error;
          matches = false;
        }
      }
      if (!matches) {
        const snapshot = assetIdentity(current);
        beforeMutation(args, "draft", snapshot);
        run("gh", ["api", "--method", "DELETE", `repos/${args["--repository"]}/releases/assets/${remote.id}`]);
        current = releaseState(args);
        if (!current || !current.draft
          || current.assets.some(asset => asset.id === remote!.id || asset.name === canonical.name)) {
          fail(`draft asset deletion was not visible: ${canonical.name}`);
        }
        remote = undefined;
      }
    }
    if (!remote) {
      const snapshot = assetIdentity(current);
      beforeMutation(args, "draft", snapshot);
      run("gh", ["release", "upload", args["--tag"], canonical.path, "--repo", args["--repository"]]);
      const uploaded = releaseState(args);
      const asset = uploaded?.assets.find(value => value.name === canonical.name);
      if (!uploaded || !uploaded.draft || !asset || asset.size !== canonical.size) {
        fail(`draft asset upload was not visible: ${canonical.name}`);
      }
    }
  }

  release = releaseState(args);
  if (!release || !release.draft) fail("draft release changed before verification");
  await proveRemoteAssets(args, release, local);
  const snapshot = assetIdentity(release);
  beforeMutation(args, "draft", snapshot);
  run("gh", ["release", "edit", args["--tag"], "--repo", args["--repository"], "--draft=false"]);
  await exactPublished(args, local);
  process.stdout.write(`reconciled published release ${args["--tag"]}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
