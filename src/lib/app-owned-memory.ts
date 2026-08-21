/**
 * Payload-free application-owned memory projection for the recall probe.
 *
 * This is intentionally derived from live runtime counters rather than a second
 * accounting registry: active turns come from the lifecycle owner and retained
 * continuation bytes come from the response-state owner. A zero budget field
 * means this current runtime has no separate weighted budget, not that a budget
 * verdict was fabricated.
 */
import { responseStateMetrics } from "../responses/state";
import { getActiveTurnCount } from "../server/lifecycle";

export type AppOwnedMemorySnapshot = {
  retainedBytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  overBudgetBytes: number;
  observedInFlight: Record<string, { currentBytes: number; highWaterBytes: number; active: number }>;
};

export function appOwnedBytesSnapshot(): AppOwnedMemorySnapshot {
  const active = getActiveTurnCount();
  const continuation = responseStateMetrics();
  return {
    retainedBytes: continuation.totalBytes,
    evictableBytes: continuation.totalBytes,
    pinnedBytes: 0,
    overBudgetBytes: 0,
    observedInFlight: {
      turns: { currentBytes: 0, highWaterBytes: 0, active },
    },
  };
}
