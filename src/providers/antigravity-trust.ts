import { resolvePublicAddresses, type UrlDestinationAssessment, assessUrlDestination } from "../lib/destination-policy";

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
export async function resolveAntigravityBearerDestination(value: string): Promise<{
  origin: string;
  addresses: Array<{ address: string; family: number }>;
}> {
  assertAntigravityBearerUrl(value);
  const resolved = await resolvePublicAddresses(value, { context: "Antigravity OAuth bearer", allowPrivateNetwork: false });
  const origin = normalizedOrigin(value)!;
  return { origin, addresses: resolved.addresses };
}
