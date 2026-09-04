const DAILY_ANTIGRAVITY_HOST = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ANTIGRAVITY_HOST = "https://cloudcode-pa.googleapis.com";

/**
 * Return only the configured Google Cloud Code Assist host and its known peer.
 * Custom destinations never gain a guessed failover peer.
 */
export function antigravityHostCandidates(configuredBase: string): string[] {
  const configured = configuredBase.replace(/\/+$/, "");
  if (configured === DAILY_ANTIGRAVITY_HOST) return [DAILY_ANTIGRAVITY_HOST, PROD_ANTIGRAVITY_HOST];
  if (configured === PROD_ANTIGRAVITY_HOST) return [PROD_ANTIGRAVITY_HOST, DAILY_ANTIGRAVITY_HOST];
  return [configured];
}

/** OAuth bearers never travel to cleartext or malformed destinations. */
export function isAntigravityHttpsHost(host: string): boolean {
  try {
    return new URL(host).protocol === "https:";
  } catch {
    return false;
  }
}
