/**
 * Containment for the two local git-backed history stores.
 *
 * `state-history.ts` and `secret-history.ts` each create a private,
 * machine-written git repository and stamp a fixed identity into it:
 *
 *     git -C <store> config user.name  "opencodex state history"
 *     git -C <store> config user.email "state-history@localhost"
 *     git -C <store> config core.autocrlf false
 *
 * Both spawned git with the WHOLE inherited environment, so any variable that
 * points git at another repository (GIT_DIR and friends) silently moved those
 * writes somewhere else. It is not hypothetical: with GIT_DIR exported, `git
 * -C <store> init` reports success while creating nothing in `<store>`, and
 * the three writes that follow land in the redirected repository's config
 * instead. A checkout in this project was hit by exactly that: its own
 * `.git/config` came back carrying `user.name = opencodex state history`,
 * `user.email = state-history@localhost` and `core.autocrlf = false`, and the
 * next commit made there was authored under that identity.
 *
 * These two stores are private bookkeeping. Neither is ever allowed to write
 * configuration into a repository it was not pointed at, whatever the
 * environment says, so that is what is asserted here: an untouched stand-in
 * for the user's project, and a real store beside it that still works.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordStateSnapshot } from "../src/lib/state-history";
import { recordSecretHistoryMutation, resetSecretHistoryQueueForTests } from "../src/lib/secret-history";
import { removeTempDir } from "./helpers/temp-dir";

// Real git, on the same theory cli-export-history.test.ts and
// secret-history.test.ts already state: a mocked git proves nothing about
// which repository a real one would have resolved. A cold runner needs more
// than bun's 5000ms default for several git processes in a row.
const GIT_TEST_TIMEOUT_MS = 30_000;

/** Identity the stand-in project is given, and must still have afterwards. */
const PROJECT_USER_NAME = "hunt-ops-05 project owner";
const PROJECT_USER_EMAIL = "project-owner@example.invalid";
/** Deliberately not "false": the live incident overwrote this key too. */
const PROJECT_AUTOCRLF = "input";

let root = "";

/**
 * Run git for the assertions with the redirecting variables stripped, so the
 * check itself can never be pointed somewhere else by the very variable the
 * test sets. Reading the project repository through a redirected git would
 * report whatever that redirect found and quietly pass.
 */
function gitOut(dir: string, args: string[]): string {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "GIT_DIR" || name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE") delete env[name];
  }
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env, timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** A stand-in for the user's own project: a real repository with a real identity. */
function makeProjectRepo(): string {
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  gitOut(dir, ["init", "--quiet"]);
  gitOut(dir, ["config", "--local", "user.name", PROJECT_USER_NAME]);
  gitOut(dir, ["config", "--local", "user.email", PROJECT_USER_EMAIL]);
  gitOut(dir, ["config", "--local", "core.autocrlf", PROJECT_AUTOCRLF]);
  return dir;
}

/**
 * Drive a history store while the environment points git at `gitDir`.
 *
 * This is the mechanism the incident ran through, reproduced rather than
 * described: git itself exports GIT_DIR to the processes it runs (hooks, for
 * one), and a suite started from there inherits it.
 */
async function withGitDir<T>(gitDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = gitDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
}

/** Everything the live incident actually damaged, read back from the project repo. */
function projectState(project: string): Record<string, string> {
  return {
    userName: gitOut(project, ["config", "--local", "--get", "user.name"]),
    userEmail: gitOut(project, ["config", "--local", "--get", "user.email"]),
    autocrlf: gitOut(project, ["config", "--local", "--get", "core.autocrlf"]),
    commits: gitOut(project, ["rev-list", "--all", "--count"]),
  };
}

const UNTOUCHED = {
  userName: PROJECT_USER_NAME,
  userEmail: PROJECT_USER_EMAIL,
  autocrlf: PROJECT_AUTOCRLF,
  commits: "0",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-hunt-ops-05-"));
  resetSecretHistoryQueueForTests();
});

afterEach(() => {
  resetSecretHistoryQueueForTests();
  if (root) removeTempDir(root);
});

test("the state history never writes configuration into a repository it was not pointed at", async () => {
  const project = makeProjectRepo();
  // A separate directory, outside the project entirely — this is the only
  // repository the store is allowed to touch.
  const store = join(root, "state-store");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "config.json"), "{}\n", "utf8");

  // recordStateSnapshot is the real exported entry point and does not consult
  // OCX_DISABLE_STATE_HISTORY — that flag is read in exactly one place,
  // src/config.ts's implicit save-path snapshot — so the test runner setting
  // it to 1 cannot suppress this call, and nothing here needs to clear it.
  const committed = await withGitDir(join(project, ".git"), () => recordStateSnapshot("hunt-ops-05 state", store));

  expect(projectState(project)).toEqual(UNTOUCHED);
  // And the store is a working history in its own right, rather than a
  // feature quietly turned off: the incident left the intended directory
  // with no repository at all.
  expect(existsSync(join(store, ".git"))).toBe(true);
  expect(committed).toBe(true);
}, GIT_TEST_TIMEOUT_MS);

test("the secret history never writes configuration into a repository it was not pointed at", async () => {
  const project = makeProjectRepo();
  const store = join(root, "secret-store");
  mkdirSync(store, { recursive: true });

  // `sensitive: null` keeps this on the git path only: nothing sensitive means
  // no encryption, so the OS credential vault is never consulted and this
  // stays a test about which repository git resolved.
  const result = await withGitDir(join(project, ".git"), () => recordSecretHistoryMutation(
    { kind: "display-name", action: "renamed", redacted: { to: "hunt-ops-05" }, sensitive: null },
    store,
  ));

  expect(projectState(project)).toEqual(UNTOUCHED);
  expect(existsSync(join(store, "secret-history", ".git"))).toBe(true);
  expect(result.recorded).toBe(true);
}, GIT_TEST_TIMEOUT_MS);
