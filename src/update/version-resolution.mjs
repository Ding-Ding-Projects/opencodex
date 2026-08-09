const CONCRETE_UPDATE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.(?:0|[1-9]\d*))?$/;

/**
 * Parse the single version line emitted by `npm view ... version`.
 *
 * A package-manager line ending is allowed, but no other whitespace is. Keeping
 * this parser deliberately narrower than general SemVer prevents tags, ranges,
 * alternate prereleases, build metadata, or multi-line output from becoming an
 * installation target.
 *
 * @param {unknown} stdout
 * @returns {string | null}
 */
export function parseConcreteUpdateVersion(stdout) {
  if (typeof stdout !== "string") return null;
  const candidate = stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout;
  return CONCRETE_UPDATE_VERSION.test(candidate) ? candidate : null;
}
