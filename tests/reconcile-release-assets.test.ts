import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { nativeArtifactNames } from "../scripts/prepare-package";

const repo = join(import.meta.dir, "..");
const helper = join(repo, "scripts", "reconcile-release-assets.ts");
const pkg = (await import("../package.json")).default;
const version = pkg.version;
const tag = `v${version}`;
const sha = "a".repeat(40);
const integrity = "sha512-AAAA";
const roots: string[] = [];
setDefaultTimeout(30_000);

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
type State = {
  tagSha: string | null;
  tagObjectSha?: string | null;
  peeledSha?: string | null;
  localTagSha?: string | null;
  release: Release | null;
  remoteDir: string;
  nextAssetId: number;
  npmIntegrity: string;
  npmTagVersion: string;
  npmChecks?: number;
  npmMoveAt?: number;
  releaseReads?: number;
  assetMoveAt?: number;
  downloadOverflowId?: number;
  behavior?: "timeout" | "over-output";
};

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeManifest(nativeDir: string): void {
  const rows = nativeArtifactNames(version).map(name => `${digest(join(nativeDir, name))}  ${name}`);
  writeFileSync(join(nativeDir, `ocx_${version}_checksums.txt`), `${rows.join("\n")}\n`, { mode: 0o644 });
}

function fakeProgram(): string {
  return `#!/usr/bin/env bun
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
const statePath=process.env.FAKE_STATE!; const log=process.env.FAKE_LOG!;
const state=JSON.parse(readFileSync(statePath,"utf8"));
const command=process.env.FAKE_COMMAND || basename(process.argv[1]).replace(/\\.(cmd|exe)$/i,""); const args=process.argv.slice(2);
appendFileSync(log,JSON.stringify([command,...args])+"\\n");
const save=()=>writeFileSync(statePath,JSON.stringify(state));
const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const asset=(path:string)=>({id:state.nextAssetId++,name:basename(path),size:statSync(path).size,digest:"sha256:"+hash(path)});
if(state.behavior==="timeout" && command==="gh"){await Bun.sleep(1000); process.exit(1)}
if(state.behavior==="over-output" && command==="gh"){process.stdout.write("x".repeat(400000)); process.exit(0)}
if(command==="npm"){
 if(args[1].includes("@") && args[2]==="dist.integrity"){process.stdout.write(JSON.stringify(state.npmIntegrity));process.exit(0)}
 if(args[2].startsWith("dist-tags.")){state.npmChecks=(state.npmChecks||0)+1;save();const value=state.npmMoveAt===state.npmChecks?"0.0.0":state.npmTagVersion;process.stdout.write(JSON.stringify(value));process.exit(0)}
 process.exit(2)
}
if(command==="git"){
 if(args[0]==="ls-remote") { const direct=state.tagObjectSha??state.tagSha; if(direct)process.stdout.write(direct+"\\t"+args[2]+"\\n");if(state.peeledSha)process.stdout.write(state.peeledSha+"\\t"+args[3]+"\\n");process.exit(0) }
 if(args[0]==="rev-parse") { if(state.localTagSha){process.stdout.write(state.localTagSha+"\\n");process.exit(0)} process.exit(1) }
 if(args[0]==="tag") { state.localTagSha=args[2]; save(); process.exit(0) }
 if(args[0]==="push") { state.tagSha=state.localTagSha; state.tagObjectSha=null; state.peeledSha=null; save(); process.exit(0) }
 process.exit(2)
}
if(command!=="gh") process.exit(2);
if(args[0]==="api" && args[1]==="--method" && args[2]==="DELETE"){
 const id=Number(args[3].split("/").pop());const found=state.release.assets.find((x:any)=>x.id===id);if(!found)process.exit(1);state.release.assets=state.release.assets.filter((x:any)=>x.id!==id);rmSync(join(state.remoteDir,found.name),{force:true});save();process.exit(0)
}
if(args[0]==="api" && args[1].includes("/releases/assets/")){
 const id=Number(args[1].split("/").pop());const found=state.release?.assets.find((x:any)=>x.id===id);if(!found)process.exit(1);const bytes=readFileSync(join(state.remoteDir,found.name));process.stdout.write(bytes);if(state.downloadOverflowId===id)process.stdout.write(Buffer.from("overflow"));process.exit(0)
}
if(args[0]==="api") {
 if(!state.release){process.stderr.write("HTTP 404: Not Found\\n");process.exit(1)}
 state.releaseReads=(state.releaseReads||0)+1;
 if(state.assetMoveAt===state.releaseReads && state.release.assets.length){state.release.assets[0].id=state.nextAssetId++}save();
 process.stdout.write(JSON.stringify(state.release));process.exit(0)
}
if(args[0]==="release" && args[1]==="create") {
 const notes=readFileSync(args[args.indexOf("--notes-file")+1],"utf8");
 state.release={tag_name:args[2],name:args[args.indexOf("--title")+1],body:notes,prerelease:args.includes("--prerelease"),draft:true,published_at:null,assets:[]};save();process.exit(0)
}
if(args[0]==="release" && args[1]==="upload") {
 const path=args[3];mkdirSync(state.remoteDir,{recursive:true});copyFileSync(path,join(state.remoteDir,basename(path)));state.release.assets.push(asset(path));save();process.exit(0)
}
if(args[0]==="release" && args[1]==="edit") { state.release.draft=false;state.release.published_at="2026-07-27T00:00:00Z";save();process.exit(0) }
process.exit(2)
`;
}

function fixture(initial: Partial<State> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-reconcile-release-"));
  roots.push(root);
  const nativeDir = join(root, "package", "bin", "native");
  const remoteDir = join(root, "remote");
  const binDir = join(root, "fake-bin");
  mkdirSync(nativeDir, { recursive: true });
  mkdirSync(remoteDir);
  mkdirSync(binDir);
  for (const [index, name] of nativeArtifactNames(version).entries()) {
    writeFileSync(join(nativeDir, name), Buffer.alloc(256 + index, index + 1), { mode: 0o755 });
    chmodSync(join(nativeDir, name), 0o755);
  }
  writeManifest(nativeDir);
  const archive = join(root, "release.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", root, "package"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr);
  const notes = join(root, "notes.md");
  writeFileSync(notes, "release notes\n");
  const statePath = join(root, "state.json");
  const log = join(root, "commands.log");
  writeFileSync(log, "");
  const state: State = {
    tagSha: sha,
    release: null,
    remoteDir,
    nextAssetId: 100,
    npmIntegrity: integrity,
    npmTagVersion: version,
    ...initial,
  };
  writeFileSync(statePath, JSON.stringify(state));
  const fake = join(binDir, "fake.ts");
  writeFileSync(fake, fakeProgram(), { mode: 0o755 });
  chmodSync(fake, 0o755);
  for (const name of ["git", "gh", "npm"]) {
    const path = join(binDir, name);
    writeFileSync(path, fakeProgram(), { mode: 0o755 });
    chmodSync(path, 0o755);
    writeFileSync(`${path}.cmd`, `@set FAKE_COMMAND=${name}\r\n@bun "${fake}" %*\r\n`);
  }
  const args = [
    helper, "--repository", "owner/repo", "--tag", tag, "--sha", sha, "--title", tag,
    "--notes", notes, "--prerelease", "false", "--archive", archive,
    "--archive-sha256", digest(archive), "--native-dir", nativeDir,
    "--npm-tag", "preview", "--npm-integrity", integrity,
  ];
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, FAKE_STATE: statePath, FAKE_LOG: log };
  return { root, nativeDir, remoteDir, statePath, log, args, env };
}

function run(value: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, value.args, { cwd: repo, encoding: "utf8", env: { ...value.env, ...extraEnv } });
}

function state(value: ReturnType<typeof fixture>): State {
  return JSON.parse(readFileSync(value.statePath, "utf8"));
}

function log(value: ReturnType<typeof fixture>): string[][] {
  return readFileSync(value.log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function localNames(): string[] {
  return [...nativeArtifactNames(version), `ocx_${version}_checksums.txt`];
}

function releaseFromLocal(value: ReturnType<typeof fixture>, draft = false): Release {
  const assets = localNames().map((name, index) => {
    const local = join(value.nativeDir, name);
    writeFileSync(join(value.remoteDir, name), readFileSync(local));
    return { id: 100 + index, name, size: readFileSync(local).length, digest: `sha256:${digest(local)}` };
  });
  return {
    tag_name: tag,
    name: tag,
    body: "release notes\n",
    prerelease: false,
    draft,
    published_at: draft ? null : "2026-07-27T00:00:00Z",
    assets,
  };
}

function mutations(value: ReturnType<typeof fixture>): string[][] {
  return log(value).filter(parts =>
    (parts[0] === "git" && parts[1] === "push")
    || (parts[0] === "gh" && parts[1] === "release" && ["create", "upload", "edit"].includes(parts[2]!))
    || (parts[0] === "gh" && parts[1] === "api" && parts[2] === "--method"));
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("reconcile-release-assets", () => {
  test("creates an empty draft, uploads each asset separately, and publishes", () => {
    const value = fixture({ tagSha: null });
    expect(run(value).status).toBe(0);
    const writes = mutations(value);
    expect(writes.filter(parts => parts[0] === "git")).toHaveLength(1);
    const create = writes.find(parts => parts[2] === "create")!;
    expect(create).toContain("--draft");
    expect(create.some(part => part.startsWith(value.nativeDir))).toBe(false);
    const uploads = writes.filter(parts => parts[2] === "upload");
    expect(uploads).toHaveLength(7);
    expect(uploads.every(parts => !parts.includes("--clobber"))).toBe(true);
    expect(state(value).release?.draft).toBe(false);
  });

  test("accepts an annotated tag only when its peeled SHA is exact", () => {
    const exact = fixture({ tagObjectSha: "b".repeat(40), peeledSha: sha });
    exactState(exact, false);
    expect(run(exact).status).toBe(0);

    const conflict = fixture({ tagObjectSha: "b".repeat(40), peeledSha: "c".repeat(40) });
    exactState(conflict, false);
    const result = run(conflict);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("remote tag conflicts");
  });

  test("repairs mismatched draft bytes with guarded exact-ID delete and non-clobber upload", () => {
    const value = fixture();
    exactState(value, true);
    const current = state(value);
    const first = current.release!.assets[0]!;
    writeFileSync(join(value.remoteDir, first.name), Buffer.alloc(first.size, 9));
    first.digest = `sha256:${digest(join(value.remoteDir, first.name))}`;
    writeFileSync(value.statePath, JSON.stringify(current));
    expect(run(value).status).toBe(0);
    const writes = mutations(value);
    const deletion = writes.find(parts => parts[2] === "--method")!;
    expect(deletion).toEqual(["gh", "api", "--method", "DELETE", `repos/owner/repo/releases/assets/${first.id}`]);
    const upload = writes.find(parts => parts[2] === "upload")!;
    expect(upload).not.toContain("--clobber");
  });

  test("npm movement blocks tag push, release creation, upload, publication, and post-delete upload", () => {
    const tagPush = fixture({ tagSha: null, npmMoveAt: 2 });
    expect(run(tagPush).status).not.toBe(0);
    expect(mutations(tagPush)).toHaveLength(0);

    const create = fixture({ npmMoveAt: 2 });
    expect(run(create).status).not.toBe(0);
    expect(mutations(create)).toHaveLength(0);

    const upload = fixture({ npmMoveAt: 3 });
    expect(run(upload).status).not.toBe(0);
    expect(mutations(upload).map(parts => parts[2])).toEqual(["create"]);

    const publish = fixture({ npmMoveAt: 2 });
    exactState(publish, true);
    expect(run(publish).status).not.toBe(0);
    expect(mutations(publish).some(parts => parts[2] === "edit")).toBe(false);

    const repair = fixture({ npmMoveAt: 3 });
    exactState(repair, true);
    const repairing = state(repair);
    repairing.release!.assets[0]!.size -= 1;
    writeFileSync(repair.statePath, JSON.stringify(repairing));
    expect(run(repair).status).not.toBe(0);
    const repairWrites = mutations(repair);
    expect(repairWrites.some(parts => parts[2] === "--method")).toBe(true);
    expect(repairWrites.some(parts => parts[2] === "upload")).toBe(false);
  });

  test("published verification rejects metadata bounds, streamed overflow, and identity replacement", () => {
    const oversized = fixture();
    exactState(oversized, false);
    const oversizedState = state(oversized);
    oversizedState.release!.assets[0]!.size = 40 * 1024 * 1024 + 1;
    writeFileSync(oversized.statePath, JSON.stringify(oversizedState));
    expect(run(oversized).status).not.toBe(0);

    const overflow = fixture();
    exactState(overflow, false);
    const overflowState = state(overflow);
    overflowState.downloadOverflowId = overflowState.release!.assets[0]!.id;
    writeFileSync(overflow.statePath, JSON.stringify(overflowState));
    expect(run(overflow).status).not.toBe(0);

    const replacement = fixture();
    exactState(replacement, false);
    const replacementState = state(replacement);
    replacementState.assetMoveAt = 3;
    writeFileSync(replacement.statePath, JSON.stringify(replacementState));
    const result = run(replacement);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("identity changed");
  });

  test("published exact state is verification-only and final npm movement fails", () => {
    const value = fixture();
    exactState(value, false);
    expect(run(value).status).toBe(0);
    expect(mutations(value)).toHaveLength(0);

    const moved = fixture({ npmMoveAt: 3 });
    exactState(moved, false);
    expect(run(moved).status).not.toBe(0);
    expect(mutations(moved)).toHaveLength(0);
  });

  test("bounds command timeout and output", () => {
    for (const behavior of ["timeout", "over-output"] as const) {
      const value = fixture({ behavior });
      const result = run(value, { OCX_RELEASE_COMMAND_TIMEOUT_MS: "50" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/failed|buffer|timed out|ENOBUFS/i);
    }
  });
});

function exactState(value: ReturnType<typeof fixture>, draft: boolean): void {
  const current = state(value);
  current.release = releaseFromLocal(value, draft);
  current.nextAssetId = 200;
  writeFileSync(value.statePath, JSON.stringify(current));
}
