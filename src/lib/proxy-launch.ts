/**
 * Shared argv/environment policy for launching the proxy.
 *
 * A configured port is a preference for automatic launchers. Only an explicit
 * operator request or a captured in-place restart port is a hard pin.
 */

function validPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const port = Math.trunc(value);
  return port > 0 && port <= 65_535 ? port : undefined;
}

/** Build `ocx start`, optionally with an explicit hard port pin. */
export function proxyStartArgv(cli: string, pinnedPort?: number): string[] {
  const args = [cli, "start"];
  const port = validPort(pinnedPort);
  if (port !== undefined) args.push("--port", String(port));
  return args;
}

/**
 * Detached children are not service-manager children, even when their parent
 * happens to have been launched by a service. Never let that marker leak.
 */
export function directProxyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.OCX_SERVICE;
  return env;
}

export interface ServiceStartArgvOptions {
  env?: NodeJS.ProcessEnv;
  /** `null` forces the normal soft policy; a number is an explicit hard pin. */
  pinnedPort?: number | null;
}

/**
 * `OCX_BAKE_PORT` is an update-only, one-shot request to generate a hard-pinned
 * service asset. Normal service artifacts are deliberately soft.
 */
export function servicePinnedPort(options: ServiceStartArgvOptions = {}): number | undefined {
  if (options.pinnedPort === null) return undefined;
  const explicit = validPort(options.pinnedPort);
  if (explicit !== undefined) return explicit;
  const baked = (options.env ?? process.env).OCX_BAKE_PORT?.trim();
  if (!baked || !/^\d+$/.test(baked)) return undefined;
  return validPort(Number(baked));
}

/** Build the service child's argv, soft unless update explicitly baked a pin. */
export function serviceStartArgv(
  cli: string,
  options: ServiceStartArgvOptions = {},
): string[] {
  return proxyStartArgv(cli, servicePinnedPort(options));
}
