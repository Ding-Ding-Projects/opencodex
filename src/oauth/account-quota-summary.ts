import type { OAuthAccountHealth } from "./health";
import type { ProviderAccountQuota, ProviderQuota } from "../providers/quota";

export interface AccountQuotaSummaryRow {
  accountId: string;
  health: OAuthAccountHealth;
  quota?: ProviderQuota | null;
  unavailable?: boolean;
}

export interface AccountQuotaSummary {
  total: number;
  activeAccountId: string | null;
  /** Credential readiness only; quota capacity is reported separately. */
  ready: number;
  coolingDown: number;
  reauthRequired: number;
  unavailable: number;
  unknownQuota: number;
  knownQuota: number;
  /** Known future reset, if any. */
  nextResetAt?: number;
}

export function buildAccountQuotaSummary(
  rows: readonly AccountQuotaSummaryRow[],
  activeAccountId: string | null,
  now = Date.now(),
): AccountQuotaSummary {
  const known = rows.filter(row => row.quota !== null && row.quota !== undefined && row.unavailable !== true);
  const resets = known.flatMap(row => [
    row.quota?.fiveHourResetAt,
    row.quota?.weeklyResetAt,
    row.quota?.monthlyResetAt,
    ...(row.quota?.customWindows ?? []).map(window => window.resetAt),
  ]).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > now);
  const nextResetAt = resets.sort((a, b) => a - b)[0];
  return {
    total: rows.length,
    activeAccountId,
    // “ready” deliberately means credential/health readiness, not quota capacity.
    ready: rows.filter(row => row.health.status === "healthy" && row.unavailable !== true).length,
    coolingDown: rows.filter(row => row.health.status === "cooldown").length,
    reauthRequired: rows.filter(row => row.health.status === "reauth_required").length,
    unavailable: rows.filter(row => row.unavailable === true).length,
    unknownQuota: rows.length - known.length,
    knownQuota: known.length,
    ...(nextResetAt === undefined ? {} : { nextResetAt }),
  };
}

/** Type-level import anchor for the route DTO; no credential fields are accepted here. */
export type AccountQuotaRow = Pick<ProviderAccountQuota, "accountId" | "quota" | "unavailable">;
