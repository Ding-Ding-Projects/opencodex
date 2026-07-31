import { win32 } from "node:path";
import { resolveOnTrustedPath } from "../lib/trusted-path.mjs";

const CMD_META = /([()%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg) {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${out}"`.replace(CMD_META, "^$1");
}

function escapeCmdCommand(command) {
  return command.replace(CMD_META, "^$1");
}

/**
 * Absolute npm on Windows, resolved off a trusted PATH entry so a bare `npm` can never
 * be picked up out of the launch directory. The scan itself lives in
 * `src/lib/trusted-path.mjs` because the Bun update path needs exactly the same rule.
 */
export function resolveNpmCommand(
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  if (platform !== "win32") return "npm";
  return resolveOnTrustedPath("npm", env, deps);
}

function systemCommandProcessor(env) {
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot && win32.isAbsolute(systemRoot)) {
    return win32.join(systemRoot, "System32", "cmd.exe");
  }
  const comSpec = env.ComSpec;
  return comSpec && win32.isAbsolute(comSpec) ? win32.resolve(comSpec) : null;
}

export function npmInvocation(
  args,
  platform = process.platform,
  env = process.env,
  deps = {},
) {
  const npm = resolveNpmCommand(platform, env, deps);
  if (!npm) return null;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(npm)) {
    return { file: npm, args: [...args], options: {} };
  }

  const commandProcessor = systemCommandProcessor(env);
  if (!commandProcessor) return null;
  const line = [escapeCmdCommand(npm), ...args.map(escapeCmdArg)].join(" ");
  return {
    file: commandProcessor,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
