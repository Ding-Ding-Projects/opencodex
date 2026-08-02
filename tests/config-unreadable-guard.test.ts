/**
 * What must NOT happen when `config.json` cannot be read.
 *
 * `readConfigDiagnostics()` always hands back a usable object. On an unreadable
 * file that object is `getDefaultConfig()`, with the real story in `source:
 * "fallback"` and `error`. Two callers took the config and ignored the error,
 * and both turned a recoverable problem into a permanent one:
 *
 *  - `ocx config set` wrote that object back. One malformed byte in the file and
 *    a single `set` replaced every provider, key and pooled account with factory
 *    defaults, printed "Set …" and exited 0. Unlike `loadConfig`, this path
 *    takes no backup on the way past, so there was nothing left to restore from.
 *  - `ocx export` put it in a bundle labelled `opencodex-export`, printed
 *    "Exported config + accounts + auth" and exited 0 — a backup of defaults,
 *    which is worse than no backup because it looks like one. Restoring from it
 *    later would complete the loss.
 *
 * These run the real CLI against a real temp `OPENCODEX_HOME` holding a real
 * broken file. Stubbing the diagnostics would test the guard against a mock of
 * the thing the guard exists to survive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "bin", "ocx.mjs");

let home: string;
let configPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-broken-config-"));
  configPath = join(home, "config.json");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[]) {
  const proc = Bun.spawnSync(["node", CLI, ...args], {
    env: { ...process.env, OPENCODEX_HOME: home },
  });
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** A config that is real, recognisable, and not valid JSON. */
const BROKEN = '{ "providers": { "openai": { "apiKey": "sk-REAL-KEY" } },,, }';

describe("ocx config set, against an unreadable config", () => {
  test("refuses instead of writing defaults over it", () => {
    writeFileSync(configPath, BROKEN, "utf8");
    const result = run(["config", "set", "defaultProvider", "openai"]);

    expect(result.code).not.toBe(0);
    // The file is untouched — that is the whole point.
    expect(readFileSync(configPath, "utf8")).toBe(BROKEN);
  });

  test("says what is wrong and how to look at it", () => {
    writeFileSync(configPath, BROKEN, "utf8");
    const said = run(["config", "set", "defaultProvider", "openai"]);
    const text = said.stdout + said.stderr;

    expect(text).toContain("could not be read");
    expect(text).toContain("ocx config validate");
  });

  test("unset is guarded too, not just set", () => {
    writeFileSync(configPath, BROKEN, "utf8");
    const result = run(["config", "unset", "defaultProvider"]);

    expect(result.code).not.toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(BROKEN);
  });

  test("a valid config still writes, so the guard is not just refusing everything", () => {
    writeFileSync(configPath, JSON.stringify({ providers: {} }), "utf8");
    const result = run(["config", "set", "port", "10123"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).port).toBe(10123);
  });
});

describe("ocx export, against an unreadable config", () => {
  test("refuses rather than writing a bundle of defaults", () => {
    writeFileSync(configPath, BROKEN, "utf8");
    const out = join(home, "backup.json");
    const result = run(["export", out, "--yes"]);

    expect(result.code).not.toBe(0);
    // No file at all is the honest outcome. A bundle that exists and contains
    // defaults is the failure this guards.
    expect(existsSync(out)).toBe(false);
  });

  test("names the file and points at the validator", () => {
    writeFileSync(configPath, BROKEN, "utf8");
    const text = run(["export", join(home, "backup.json"), "--yes"]).stderr;

    expect(text).toContain("could not be read");
    expect(text).toContain("ocx config validate");
  });

  test("a valid config still exports", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ providers: {} }), "utf8");
    const out = join(home, "backup.json");
    const result = run(["export", out, "--yes"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).kind).toBe("opencodex-export");
  });
});
