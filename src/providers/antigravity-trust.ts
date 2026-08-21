import { resolvePublicAddresses, type UrlDestinationAssessment, assessUrlDestination } from "../lib/destination-policy";

/**
 * Bearer policy for CCA. This module performs an immediate DNS resolution and safety check before
 * each dispatch; the current Bun fetch executor does not connect to the returned address directly,
 * so this is deliberately documented as non-pinned revalidation, not a socket-pinning guarantee.
 * A future transport may consume the returned address through the existing pinned HTTP primitive.
 */

export const ANTIGRAVITY_DAILY_ORIGIN = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_PROD_ORIGIN = "https://cloudcode-pa.googleapis.com";

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    if (url.search && url.search !== "?alt=sse") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function isKnownAntigravityOrigin(value: string): boolean {
  const origin = normalizedOrigin(value);
  return origin === ANTIGRAVITY_DAILY_ORIGIN || origin === ANTIGRAVITY_PROD_ORIGIN;
}

/** Synchronous preflight used before a bearer is placed in a request. */
export function assertAntigravityBearerUrl(value: string): void {
  const origin = normalizedOrigin(value);
  if (!origin || !isKnownAntigravityOrigin(origin)) {
    throw new Error("Antigravity OAuth bearer requires a known HTTPS Cloud Code Assist destination");
  }
  const assessment: UrlDestinationAssessment | null = assessUrlDestination(value);
  if (assessment && assessment.kind !== "hostname" && assessment.kind !== "public") {
    throw new Error(`Antigravity OAuth bearer destination blocked: ${assessment.detail}`);
  }
}

/** Re-resolve immediately before dispatch to reduce DNS-rebinding exposure. */
export async function resolveAntigravityBearerDestination(
  value: string,
  resolveAddresses: typeof resolvePublicAddresses = resolvePublicAddresses,
): Promise<{
  origin: string;
  addresses: Array<{ address: string; family: number }>;
}> {
  assertAntigravityBearerUrl(value);
  const resolved = await resolveAddresses(value, { context: "Antigravity OAuth bearer", allowPrivateNetwork: false });
  for (const address of resolved.addresses) {
    const literal = address.family === 6 ? `[${address.address}]` : address.address;
    const assessment = assessUrlDestination(`https://${literal}`);
    if (assessment && assessment.kind !== "public") throw new Error(`Antigravity OAuth bearer resolved to ${assessment.detail}`);
  }
  const origin = normalizedOrigin(value)!;
  return { origin, addresses: resolved.addresses };
}
