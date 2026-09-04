#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

function fail(message) {
  throw new Error(`native install verification failed: ${message}`);
}

const reportArg = process.argv[2];
if (!reportArg || process.argv.length !== 3) {
  fail("usage: node scripts/verify-native-install.mjs <existing-pack.json>");
}
const reportPath = resolve(reportArg);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== "string") {
  fail("pack report must contain exactly one archive");
}
const filename = report[0].filename;
if (isAbsolute(filename) || basename(filename) !== filename || !filename.endsWith(".tgz")) {
  fail(`unsafe archive filename: ${filename}`);
}
const archive = join(dirname(reportPath), filename);
const archiveStat = lstatSync(archive);
if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) fail("archive must be a regular non-symlink file");
const archiveBytes = readFileSync(archive);
if (archiveStat.size !== report[0].size) fail("archive size does not match the pack report");
if (createHash("sha1").update(archiveBytes).digest("hex") !== report[0].shasum) {
  fail("archive SHA-1 does not match the pack report");
}
if (`sha512-${createHash("sha512").update(archiveBytes).digest("base64")}` !== report[0].integrity) {
  fail("archive integrity does not match the pack report");
}

const prefix = mkdtempSync(join(tmpdir(), "ocx-native-install-"));
const poisonLog = join(prefix, "poison.log");
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npm, ["install", "-g", "--ignore-scripts", "--prefix", prefix, archive], {
    encoding: "utf8",
    timeout: 180_000,
    shell: process.platform === "win32",
  });
  if (install.status !== 0) fail(`npm install exited ${install.status ?? "without status"}: ${install.stderr}`);

  const rootResult = spawnSync(npm, ["root", "-g", "--prefix", prefix], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (rootResult.status !== 0) fail(`npm root exited ${rootResult.status ?? "without status"}`);
  const packageRoot = join(rootResult.stdout.trim(), "@bitkyc08", "opencodex");
  const bunRoot = join(packageRoot, "node_modules", "bun");
  const installJs = join(bunRoot, "install.js");
  if (!existsSync(installJs)) fail("installed package does not retain the Bun dependency");
  writeFileSync(installJs, `require("node:fs").appendFileSync(${JSON.stringify(poisonLog)}, "install.js\\n"); process.exit(91);\n`);
  for (const name of ["bun", "bun.exe"]) {
    const binary = join(bunRoot, "bin", name);
    if (!existsSync(binary)) continue;
    writeFileSync(binary, `#!/bin/sh\nprintf 'bun:${name}\\n' >> "$OCX_POISON_LOG"\nexit 92\n`);
    if (process.platform !== "win32") chmodSync(binary, 0o755);
  }
  const sourceCli = join(packageRoot, "src", "cli", "index.ts");
  if (!existsSync(sourceCli)) fail("installed package does not retain the source bridge");
  writeFileSync(sourceCli, `throw new Error("source runtime poison");\n`);

  const entry = process.platform === "win32" ? join(prefix, "ocx.cmd") : join(prefix, "bin", "ocx");
  const env = { ...process.env, OPENCODEX_HOME: join(prefix, "home"), OCX_POISON_LOG: poisonLog };
  delete env.OPENCODEX_RUNTIME;
  delete env.OPENCODEX_GO_BINARY;
  delete env.OPENCODEX_BUN_PATH;
  const run = spawnSync(entry, ["help"], {
    encoding: "utf8",
    timeout: 30_000,
    env,
    shell: process.platform === "win32",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /opencodex \(ocx\).*Universal provider proxy/i);
  assert.equal(existsSync(poisonLog), false, "Bun or install.js poison executed");
  process.stdout.write(`verified native install: ${filename}\n`);
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
