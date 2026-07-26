import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { nativeArtifactNames } from "../scripts/prepare-package";

const repo = join(import.meta.dir, "..");
const helper = join(repo, "scripts", "reconcile-release-assets.ts");
const version = (await import("../package.json")).default.version;
const tag = `v${version}`;
const sha = "a".repeat(40);
const roots: string[] = [];

type State = {
  tagSha: string | null;
  localTagSha?: string | null;
  release: null | { tag_name: string; name: string; body: string; prerelease: boolean; draft: boolean; published_at: string | null; assets: { name: string }[] };
  remoteDir: string;
  createInterrupt?: number;
  tagMoveAt?: number;
  tagReads?: number;
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
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const statePath=process.env.FAKE_STATE!; const log=process.env.FAKE_LOG!;
const state=JSON.parse(readFileSync(statePath,"utf8"));
const command=process.env.FAKE_COMMAND || basename(process.argv[1]).replace(/\\.(cmd|exe)$/i,""); const args=process.argv.slice(2);
appendFileSync(log,JSON.stringify([command,...args])+"\\n");
const save=()=>writeFileSync(statePath,JSON.stringify(state));
if(state.behavior==="timeout" && command==="gh"){await Bun.sleep(1000); process.exit(1)}
if(state.behavior==="over-output" && command==="gh"){process.stdout.write("x".repeat(400000)); process.exit(0)}
if(command==="git"){
 if(args[0]==="ls-remote") { state.tagReads=(state.tagReads||0)+1; save(); const moved=state.tagMoveAt===state.tagReads; const value=moved?"b".repeat(40):state.tagSha; if(value) process.stdout.write(value+"\\t"+args[3]+"\\n"); process.exit(0) }
 if(args[0]==="rev-parse") { if(state.localTagSha){process.stdout.write(state.localTagSha+"\\n");process.exit(0)} process.exit(1) }
 if(args[0]==="tag") { state.localTagSha=args[2]; save(); process.exit(0) }
 if(args[0]==="push") { state.tagSha=state.localTagSha; save(); process.exit(0) }
 process.exit(2)
}
if(command!=="gh") process.exit(2);
if(args[0]==="api") { if(!state.release){process.stderr.write("HTTP 404: Not Found\\n");process.exit(1)} process.stdout.write(JSON.stringify(state.release));process.exit(0) }
if(args[0]==="release" && args[1]==="download") { const name=args[args.indexOf("--pattern")+1]; const dir=args[args.indexOf("--dir")+1]; mkdirSync(dir,{recursive:true}); copyFileSync(join(state.remoteDir,name),join(dir,name)); process.exit(0) }
if(args[0]==="release" && args[1]==="create") {
 const option=args.findIndex((x:string)=>x.startsWith("--")); const paths=args.slice(3,option); const notes=readFileSync(args[args.indexOf("--notes-file")+1],"utf8");
 const count=state.createInterrupt===undefined?paths.length:state.createInterrupt; mkdirSync(state.remoteDir,{recursive:true});
 for(const path of paths.slice(0,count)) copyFileSync(path,join(state.remoteDir,basename(path)));
 state.release={tag_name:args[2],name:args[args.indexOf("--title")+1],body:notes,prerelease:args.includes("--prerelease"),draft:count<paths.length,published_at:count<paths.length?null:"2026-07-27T00:00:00Z",assets:paths.slice(0,count).map((path:string)=>({name:basename(path)}))}; save();
 if(count<paths.length){process.stderr.write("interrupted upload\\n");process.exit(1)} process.exit(0)
}
if(args[0]==="release" && args[1]==="upload") { const option=args.findIndex((x:string,i:number)=>i>2&&x.startsWith("--")); const paths=args.slice(3,option); for(const path of paths){copyFileSync(path,join(state.remoteDir,basename(path))); if(!state.release.assets.some((a:any)=>a.name===basename(path)))state.release.assets.push({name:basename(path)})} save(); process.exit(0) }
if(args[0]==="release" && args[1]==="edit") { state.release.draft=false; state.release.published_at="2026-07-27T00:00:00Z"; save(); process.exit(0) }
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
  const state: State = { tagSha: sha, release: null, remoteDir, ...initial };
  writeFileSync(statePath, JSON.stringify(state));
  const fake = join(binDir, "fake.ts");
  writeFileSync(fake, fakeProgram(), { mode: 0o755 });
  chmodSync(fake, 0o755);
  for (const name of ["git", "gh"]) {
    const path = join(binDir, name);
    writeFileSync(path, fakeProgram(), { mode: 0o755 });
    chmodSync(path, 0o755);
    writeFileSync(`${path}.cmd`, `@set FAKE_COMMAND=${name}\r\n@bun "${fake}" %*\r\n`);
  }
  const args = [
    helper, "--repository", "owner/repo", "--tag", tag, "--sha", sha, "--title", tag,
    "--notes", notes, "--prerelease", "false", "--archive", archive,
    "--archive-sha256", digest(archive), "--native-dir", nativeDir,
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

function publishedRelease(value: ReturnType<typeof fixture>, assetCount = 7) {
  const names = [...nativeArtifactNames(version), `ocx_${version}_checksums.txt`];
  for (const name of names.slice(0, assetCount)) writeFileSync(join(value.remoteDir, name), readFileSync(join(value.nativeDir, name)));
  return { tag_name: tag, name: tag, body: "release notes\n", prerelease: false, draft: false, published_at: "2026-07-27T00:00:00Z", assets: names.slice(0, assetCount).map(name => ({ name })) };
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("reconcile-release-assets", () => {
  test("creates an absent tag and release, then proves the published bytes", () => {
    const value = fixture({ tagSha: null });
    expect(run(value).status).toBe(0);
    const commands = log(value).map(parts => parts.slice(0, 3).join(" "));
    expect(commands).toContain("git tag " + tag);
    expect(commands).toContain("git push origin");
    expect(commands).toContain("gh release create");
    expect(state(value).release?.draft).toBe(false);
  });

  test("repairs an interrupted draft and explicitly publishes it", () => {
    const value = fixture({ createInterrupt: 3 });
    expect(run(value).status).not.toBe(0);
    expect(state(value).release?.draft).toBe(true);
    expect(run(value).status).toBe(0);
    const commands = log(value).map(parts => parts.slice(0, 3).join(" "));
    expect(commands).toContain("gh release upload");
    expect(commands).toContain("gh release edit");
    expect(state(value).release?.draft).toBe(false);
    expect(state(value).release?.assets).toHaveLength(7);
  });

  test("repairs a mismatched draft asset before publication", () => {
    const value = fixture();
    const current = state(value);
    current.release = publishedRelease(value);
    current.release.draft = true;
    current.release.published_at = null;
    writeFileSync(join(value.remoteDir, current.release.assets[0]!.name), "corrupt");
    writeFileSync(value.statePath, JSON.stringify(current));
    expect(run(value).status).toBe(0);
    expect(log(value).some(parts => parts[1] === "release" && parts[2] === "upload")).toBe(true);
    expect(state(value).release?.draft).toBe(false);
  });

  test("published exact state is verification-only", () => {
    const value = fixture();
    const current = state(value);
    current.release = publishedRelease(value);
    writeFileSync(value.statePath, JSON.stringify(current));
    expect(run(value).status).toBe(0);
    expect(log(value).filter(parts => ["tag", "push"].includes(parts[1]!) || ["create", "upload", "edit"].includes(parts[2]!))).toHaveLength(0);
  });

  test("published incomplete and conflicting metadata fail without mutation", () => {
    for (const conflict of ["assets", "metadata"] as const) {
      const value = fixture();
      const current = state(value);
      current.release = publishedRelease(value, conflict === "assets" ? 6 : 7);
      if (conflict === "metadata") current.release.body = "different";
      writeFileSync(value.statePath, JSON.stringify(current));
      expect(run(value).status).not.toBe(0);
      expect(log(value).filter(parts => ["tag", "push"].includes(parts[1]!) || ["create", "upload", "edit"].includes(parts[2]!))).toHaveLength(0);
    }
  });

  test("fails when the authoritative tag moves before a mutation or final proof", () => {
    for (const moveAt of [2, 5]) {
      const value = fixture({ tagMoveAt: moveAt });
      const result = run(value);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("remote tag");
    }
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
