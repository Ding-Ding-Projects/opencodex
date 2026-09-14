import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeDesktopCommand } from "../src/cli/claude-desktop";
import { loadConfig, saveConfig } from "../src/config";
import type { DataPlaneApiKey } from "../src/types";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

let dir = "";
let previousHome: string | undefined;
let previousDesktopDir: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDesktopDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "ocx-desktop-cli-"));
  process.env.OPENCODEX_HOME = join(dir, "ocx");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "desktop");
  saveConfig({
    port: 10100,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopDir;
  removeTempDir(dir);
});

test("show --json, move, default and export use the same persisted profile", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.profile.assignments["mock/test-model"].family).toBe("opus");

    expect(await handleClaudeDesktopCommand(["move", "mock/test-model", "sonnet", "--default"])).toBe(0);
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const target = join(dir, "profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(exported.assignments["mock/test-model"].family).toBe("sonnet");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("import rejects invalid profiles without replacing saved state", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleClaudeDesktopCommand(["move", "mock/test-model", "haiku", "--default"]);
    const before = structuredClone(loadConfig().claudeCode?.desktopProfile);
    const source = join(dir, "bad.json");
    writeFileSync(source, JSON.stringify({ version: 1, assignments: {}, defaults: { opus: "missing", fable: null, sonnet: null, haiku: null } }));
    expect(await handleClaudeDesktopCommand(["import", source])).toBe(1);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(before);
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("no-arg and legacy mode flags apply Desktop config", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand([])).toBe(0);
    expect(await handleClaudeDesktopCommand(["--static"])).toBe(0);
    expect(readFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR!, "_meta.json"), "utf8")).toContain("opencodex");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

// SEC-01 (Copilot admission security review): a key created with purpose
// "github-copilot-desktop" is an integration-scoped credential (issue #10) and must
// never be written into the Claude Desktop third-party gateway config as the shared
// inferenceGatewayApiKey (src/cli/claude-desktop.ts applyProfile, ~line 47).
test("apply never writes a purpose-scoped API key into the Claude Desktop 3P config", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const COPILOT_SECRET = "ocx_data_copilot_only_secret_must_stay_scoped";
    const config = loadConfig();
    config.apiKeys = [{
      id: "copilot-key",
      name: "GitHub Copilot Desktop",
      key: COPILOT_SECRET,
      createdAt: "2026-07-11T00:00:00.000Z",
      purpose: "github-copilot-desktop",
    } satisfies DataPlaneApiKey];
    saveConfig(config);

    expect(await handleClaudeDesktopCommand(["apply"])).toBe(0);

    const libraryDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR!;
    const meta = JSON.parse(readFileSync(join(libraryDir, "_meta.json"), "utf8")) as { entries: Array<{ id: string; name: string }> };
    const entry = meta.entries.find(e => e.name === "opencodex");
    expect(entry).toBeDefined();
    const written = readFileSync(join(libraryDir, `${entry!.id}.json`), "utf8");
    expect(written).not.toContain(COPILOT_SECRET);
    expect((JSON.parse(written) as { inferenceGatewayApiKey: string }).inferenceGatewayApiKey).toBe("ocx");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
