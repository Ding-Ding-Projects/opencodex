import { describe, expect, test } from "bun:test";
import {
  appExecutionAliasExists,
  commandInvocation,
  escapeCmdArg,
  escapeCmdCommand,
  resolveWindowsCommand,
  shellInvocation,
} from "../src/lib/win-exec";

describe("escapeCmdArg / escapeCmdCommand (cross-spawn parity)", () => {
  test("plain token is quoted, with the quotes themselves caret-escaped", () => {
    expect(escapeCmdArg("abc")).toBe('^"abc^"');
  });

  test("spaces and quotes are caret-escaped inside the quoted arg", () => {
    expect(escapeCmdArg("hello world")).toBe('^"hello^ world^"');
    expect(escapeCmdArg('a"b')).toBe('^"a\\^"b^"');
  });

  test("trailing backslashes are doubled so the closing quote survives", () => {
    expect(escapeCmdArg("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
  });

  test("percent and shell metacharacters are caret-escaped", () => {
    expect(escapeCmdArg("50%")).toBe('^"50^%^"');
    expect(escapeCmdArg("a&b")).toBe('^"a^&b^"');
  });

  test("double escaping (cmd shims) escapes the carets again", () => {
    expect(escapeCmdArg("a b", true)).toBe('^^^"a^^^ b^^^"');
  });

  test("command token is escaped without quoting", () => {
    expect(escapeCmdCommand("C:\\npm\\claude.cmd")).toBe("C:\\npm\\claude.cmd");
    expect(escapeCmdCommand("we ird.cmd")).toBe("we^ ird.cmd");
  });
});

describe("resolveWindowsCommand", () => {
  const env = { PATH: "C:\\bin;D:\\tools", PATHEXT: undefined } as Record<string, string | undefined>;

  test("bare name resolves through PATH x PATHEXT (win32 grammar)", () => {
    const exists = (p: string) => p === "D:\\tools\\claude.cmd";
    expect(resolveWindowsCommand("claude", { env, exists })).toBe("D:\\tools\\claude.cmd");
  });

  test(".exe beats .cmd via PATHEXT order in the same dir", () => {
    const exists = (p: string) => p === "C:\\bin\\codex.exe" || p === "C:\\bin\\codex.cmd";
    expect(resolveWindowsCommand("codex", { env, exists })).toBe("C:\\bin\\codex.exe");
  });

  test("explicit extension / separators / absolute prefixes short-circuit", () => {
    const exists = () => { throw new Error("must not probe"); };
    expect(resolveWindowsCommand("C:\\x\\codex.cmd", { env, exists })).toBe("C:\\x\\codex.cmd");
    expect(resolveWindowsCommand(".\\codex", { env, exists })).toBe(".\\codex");
    expect(resolveWindowsCommand("codex.exe", { env, exists })).toBe("codex.exe");
  });

  test("unresolvable or empty-PATH names fall back unchanged (honest miss)", () => {
    expect(resolveWindowsCommand("claude", { env, exists: () => false })).toBe("claude");
    expect(resolveWindowsCommand("claude", { env: {}, exists: () => true })).toBe("claude");
  });
});

describe("commandInvocation", () => {
  test("POSIX platforms pass through untouched", () => {
    expect(commandInvocation("claude", ["chat", "hello world"], "darwin"))
      .toEqual({ file: "claude", args: ["chat", "hello world"], options: {} });
  });

  test("win32 .exe target spawns directly with preserved args", () => {
    const deps = { env: { PATH: "C:\\bin" }, exists: (p: string) => p === "C:\\bin\\codex.exe" };
    expect(commandInvocation("codex", ["features", "enable", "multi_agent_v2"], "win32", deps))
      .toEqual({ file: "C:\\bin\\codex.exe", args: ["features", "enable", "multi_agent_v2"], options: {} });
  });

  test("win32 generic .cmd routes through ComSpec /d /s /c with single escaping", () => {
    const deps = {
      env: { PATH: "C:\\npm", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
      exists: (p: string) => p === "C:\\npm\\claude.cmd",
    };
    const inv = commandInvocation("claude", ["hello world"], "win32", deps);
    expect(inv.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", '"C:\\npm\\claude.cmd ^"hello^ world^""']);
    expect(inv.options).toEqual({ windowsVerbatimArguments: true });
  });

  test("win32 npm local-bin shim gets cross-spawn double escaping", () => {
    const shim = "C:\\proj\\node_modules\\.bin\\foo.cmd";
    const inv = commandInvocation(shim, ["a b"], "win32", { env: {}, exists: () => true });
    expect(inv.args[3]).toBe(`"${shim} ^^^"a^^^ b^^^""`);
  });

  test("win32 ComSpec falls back to cmd.exe", () => {
    const inv = commandInvocation("x.cmd", [], "win32", { env: {}, exists: () => true });
    expect(inv.file).toBe("cmd.exe");
  });
});

describe("app execution aliases", () => {
  /**
   * These exist because of a bug that produced no error at all. winget and
   * Windows Terminal ship as MSIX app execution aliases — zero-byte reparse
   * points under `…\WindowsApps` that `existsSync` reports as absent and
   * `statSync` refuses with EACCES/ENOENT, while `readdirSync` lists them. Every
   * "is it installed" probe in this repo used stat, so on an ordinary Windows
   * machine the app concluded winget was missing and quietly offered a download
   * page instead of installing anything.
   */
  const listing = (dir: string) => {
    if (dir === "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps") return ["wt.exe", "winget.exe"];
    if (dir === "C:\\bin") return ["wt.exe"];
    throw new Error("ENOENT");
  };

  test("a name listed in WindowsApps counts as present even though stat cannot see it", () => {
    expect(appExecutionAliasExists("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe", listing))
      .toBe(true);
    expect(appExecutionAliasExists("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\WT.EXE", listing))
      .toBe(true);
  });

  test("only WindowsApps is probed, and a missing name is still missing", () => {
    // The scope is deliberate: without it, every unresolved command would
    // enumerate System32 on the way to answering no.
    expect(appExecutionAliasExists("C:\\bin\\wt.exe", listing)).toBe(false);
    expect(appExecutionAliasExists("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\nope.exe", listing))
      .toBe(false);
  });

  test("an unreadable directory is not an alias, not an exception", () => {
    expect(appExecutionAliasExists("D:\\gone\\WindowsApps\\wt.exe", listing)).toBe(false);
  });

  test("PATH resolution finds an alias that stat says is not there", () => {
    const deps = {
      env: { PATH: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps" },
      exists: () => false,
      aliasExists: (p: string) => p.toLowerCase().endsWith("windowsapps\\winget.exe"),
    };
    expect(resolveWindowsCommand("winget", deps))
      .toBe("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe");
  });

  test("an alias is spawned from its own directory, because an absolute path ENOENTs", () => {
    // Bun refuses to spawn what it cannot stat: the absolute path and the bare
    // name both fail, while `./winget.exe` with cwd set goes straight to
    // CreateProcess, which follows the link. Measured on Bun 1.3.14.
    const deps = {
      env: { PATH: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps" },
      exists: () => false,
      aliasExists: (p: string) => p.toLowerCase().endsWith("windowsapps\\winget.exe"),
    };
    expect(commandInvocation("winget", ["install", "--id", "Microsoft.WindowsTerminal"], "win32", deps)).toEqual({
      file: "./winget.exe",
      args: ["install", "--id", "Microsoft.WindowsTerminal"],
      options: { cwd: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps" },
    });
  });

  test("a real file wins over the alias treatment, so nothing else changes shape", () => {
    // Both probes answer yes for the same path here: a real program must still
    // spawn by absolute path with no cwd, or every existing call site would
    // quietly acquire a working directory it did not ask for.
    const deps = {
      env: { PATH: "C:\\bin" },
      exists: (p: string) => p === "C:\\bin\\codex.exe",
      aliasExists: (p: string) => p === "C:\\bin\\codex.exe",
    };
    expect(commandInvocation("codex", ["--version"], "win32", deps))
      .toEqual({ file: "C:\\bin\\codex.exe", args: ["--version"], options: {} });
  });
});

describe("shellInvocation (sh -c analog)", () => {
  test("POSIX stays byte-identical to sh -c", () => {
    expect(shellInvocation("cat >/dev/null; printf '%s' 'x'", "darwin"))
      .toEqual({ file: "sh", args: ["-c", "cat >/dev/null; printf '%s' 'x'"], options: {} });
  });

  test("win32 wraps the verbatim command in the outer quotes /s requires", () => {
    const cmd = '"C:\\Program Files\\executor.exe" --json';
    expect(shellInvocation(cmd, "win32", { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" })).toEqual({
      file: "C:\\WINDOWS\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `"${cmd}"`],
      options: { windowsVerbatimArguments: true },
    });
  });

  test("win32 metacharacters in the configured command stay verbatim (CMD-native syntax contract)", () => {
    const cmd = "type in.json | executor.exe --mode=full & echo done";
    const inv = shellInvocation(cmd, "win32", {});
    expect(inv.file).toBe("cmd.exe");
    expect(inv.args[3]).toBe(`"${cmd}"`);
  });
});
