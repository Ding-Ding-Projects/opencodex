import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChangelogCommand } from "../src/cli/changelog";
import { handleExportCommand } from "../src/cli/export";
import { handleHostCommand } from "../src/cli/host";
import { handleLaunchCommand } from "../src/cli/launch";
import { handleTerminalCommand } from "../src/cli/terminal";
import { getDefaultConfig, saveConfig } from "../src/config";

test("M3 headless resource commands expose safe no-side-effect reads", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleChangelogCommand(["--from", "yesterday"])).toBe(2);
    expect(await handleExportCommand(["data", "--list", "--json"])).toBe(0);
    expect(await handleHostCommand(["--help"])).toBe(0);
    expect(await handleLaunchCommand(["list", "--json"])).toBe(0);
    expect(await handleTerminalCommand(["list", "--json"])).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(call => String(call[0]).includes("datasets"))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes("targets"))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes("presets"))).toBe(true);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("full state export refuses to write without explicit secret acknowledgement", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleExportCommand(["backup.json"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("refusing without --yes");
    expect(await handleExportCommand(["-", "--yes"])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("cannot be written to stdout");
  } finally {
    error.mockRestore();
  }
});

test("M3 resource commands reject malformed options before any side effect", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleChangelogCommand(["--search", "--json"])).toBe(2);
    expect(await handleChangelogCommand(["--from", "2026-02-31"])).toBe(2);
    expect(await handleExportCommand(["data", "providers", "--out", "--json"])).toBe(2);
    expect(await handleHostCommand(["status", "--admin-token", "do-not-log"])).toBe(2);
    expect(await handleHostCommand(["enable", "--key", "do-not-log", "--yes"])).toBe(2);
    expect(await handleLaunchCommand(["list", "extra"])).toBe(2);
    expect(await handleTerminalCommand(["run", "shell", "--command", "--json"])).toBe(2);
    expect(await handleTerminalCommand(["run", "shell", "--wait", "120001"])).toBe(2);

    const output = error.mock.calls.map(call => String(call[0])).join("\n");
    expect(output).not.toContain("do-not-log");
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("the main CLI dispatches and documents every M3 resource command", async () => {
  const cli = await Bun.file(new URL("../src/cli/index.ts", import.meta.url)).text();
  const help = await Bun.file(new URL("../src/cli/help.ts", import.meta.url)).text();
  const commands = [
    ["changelog", "handleChangelogCommand"],
    ["export", "handleExportCommand"],
    ["host", "handleHostCommand"],
    ["launch", "handleLaunchCommand"],
    ["terminal", "handleTerminalCommand"],
  ] as const;

  for (const [command, handler] of commands) {
    expect(cli).toContain(`case "${command}"`);
    expect(cli).toContain(`const { ${handler} } = await import("./${command}")`);
    expect(cli).toContain(`${handler}(args.slice(1))`);
    expect(help).toContain(`${command}: {`);
  }
  expect(help).toContain("remote proxy's ADMIN token");
  expect(help).toContain("never accepts that token (or any credential) in argv");
});

test("full-state export creates one new private file and refuses incomplete or overwrite-prone backups", async () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-cli-export-home-"));
  const out = mkdtempSync(join(tmpdir(), "ocx-cli-export-out-"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(getDefaultConfig());
    writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({ account: { credential: { refreshToken: "test-only-value" } } }));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ provider: { accessToken: "test-only-value" } }));

    const target = join(out, "backup.json");
    expect(await handleExportCommand([target, "--yes"])).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8")).kind).toBe("opencodex-export");
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);

    const firstBytes = readFileSync(target, "utf8");
    expect(await handleExportCommand([target, "--yes"])).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(firstBytes);

    writeFileSync(join(home, "auth.json"), "not json");
    const incomplete = join(out, "incomplete.json");
    expect(await handleExportCommand([incomplete, "--yes"])).toBe(2);
    expect(existsSync(incomplete)).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    log.mockRestore();
    error.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
