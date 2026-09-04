import { randomUUID } from "node:crypto";

export type ResetCreditAutoRedeemState = Readonly<{
  accountId: string;
  generation: string;
  available: number;
  expiresAt: number;
}>;

export type ResetCreditAutoRedeemIntent = Readonly<{
  accountId: string;
  generation: string;
  expiresAt: number;
  operationId: string;
}>;

export type ResetCreditAutoRedeemDependencies = {
  isEnabled: () => boolean;
  refreshAuthoritative: (accountId: string) => Promise<ResetCreditAutoRedeemState | null>;
  consume: (intent: ResetCreditAutoRedeemIntent) => Promise<"reset" | "already_redeemed" | "nothing_to_reset" | "no_credit">;
  loadIntent?: (accountId: string) => ResetCreditAutoRedeemIntent | null;
  saveIntent?: (intent: ResetCreditAutoRedeemIntent) => void;
  clearIntent?: (intent: ResetCreditAutoRedeemIntent) => void;
  now?: () => number;
};

const DEFAULT_LEAD_TIME_MS = 10 * 60_000;
const MAX_LEAD_TIME_MS = 24 * 60 * 60_000;

/** Crash-safe scheduling primitive. It never dispatches from cached expiry alone. */
export class ResetCreditAutoRedeemScheduler {
  readonly #deps: ResetCreditAutoRedeemDependencies;
  readonly #leadTimeMs: number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Map<string, { epoch: number; promise: Promise<void> }>();
  readonly #epochs = new Map<string, number>();
  #disposed = false;

  constructor(deps: ResetCreditAutoRedeemDependencies, leadTimeMs = DEFAULT_LEAD_TIME_MS) {
    if (!Number.isSafeInteger(leadTimeMs) || leadTimeMs < 0 || leadTimeMs > MAX_LEAD_TIME_MS) {
      throw new TypeError("leadTimeMs must be a bounded non-negative integer");
    }
    this.#deps = deps;
    this.#leadTimeMs = leadTimeMs;
  }

  schedule(state: ResetCreditAutoRedeemState): void {
    if (!state.accountId || !state.generation) return;
    if (!this.#deps.isEnabled() || state.available <= 0 || !Number.isFinite(state.expiresAt)) {
      this.cancel(state.accountId);
      return;
    }
    const key = `${state.accountId}\0${state.generation}`;
    this.cancel(state.accountId);
    const epoch = this.#epochs.get(state.accountId) ?? 0;
    const prior = this.#deps.loadIntent?.(state.accountId);
    const intent: ResetCreditAutoRedeemIntent = {
      accountId: state.accountId,
      generation: state.generation,
      expiresAt: state.expiresAt,
      operationId: prior?.generation === state.generation
        ? prior.operationId
        : randomUUID(),
    };
    this.#deps.saveIntent?.(intent);
    const delay = Math.max(0, state.expiresAt - this.now() - this.#leadTimeMs);
    this.#timers.set(key, setTimeout(() => { void this.#run(intent, epoch); }, delay));
  }

  recover(accountId: string): void {
    if (!this.#deps.isEnabled()) return;
    const intent = this.#deps.loadIntent?.(accountId);
    if (!intent) return;
    void this.#run(intent, this.#epochs.get(accountId) ?? 0);
  }

  cancel(accountId: string, generation?: string): void {
    this.#epochs.set(accountId, (this.#epochs.get(accountId) ?? 0) + 1);
    for (const [key, timer] of this.#timers) {
      if (key.startsWith(`${accountId}\0`) && (generation === undefined || key === `${accountId}\0${generation}`)) {
        clearTimeout(timer);
        this.#timers.delete(key);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const accountId of this.#epochs.keys()) this.#epochs.set(accountId, (this.#epochs.get(accountId) ?? 0) + 1);
    for (const key of this.#timers.keys()) {
      const accountId = key.split("\0", 1)[0]!;
      this.#epochs.set(accountId, (this.#epochs.get(accountId) ?? 0) + 1);
    }
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  private now(): number { return this.#deps.now?.() ?? Date.now(); }

  async #run(intent: ResetCreditAutoRedeemIntent, epoch: number): Promise<void> {
    if (!this.#isCurrent(intent, epoch)) return;
    const key = `${intent.accountId}\0${intent.generation}`;
    const existing = this.#inFlight.get(key);
    if (existing?.epoch === epoch) return existing.promise;
    const flight = (async () => {
      const fresh = await this.#deps.refreshAuthoritative(intent.accountId);
      if (!this.#isCurrent(intent, epoch)) return;
      const now = this.now();
      if (!fresh || fresh.accountId !== intent.accountId || fresh.generation !== intent.generation
        || fresh.available <= 0 || !Number.isFinite(fresh.expiresAt)
        || fresh.expiresAt !== intent.expiresAt || now < fresh.expiresAt - this.#leadTimeMs || now >= fresh.expiresAt) return;
      const terminal = await this.#deps.consume(intent);
      if (!this.#isCurrent(intent, epoch)) return;
      const persisted = this.#deps.loadIntent?.(intent.accountId);
      const sameIntent = this.#deps.loadIntent === undefined
        || (!!persisted && persisted.operationId === intent.operationId
          && persisted.generation === intent.generation
          && persisted.expiresAt === intent.expiresAt);
      if (sameIntent && (terminal === "reset" || terminal === "already_redeemed" || terminal === "nothing_to_reset" || terminal === "no_credit")) {
        this.#deps.clearIntent?.(intent);
      }
    })();
    this.#inFlight.set(key, { epoch, promise: flight });
    try { await flight; } finally {
      if (this.#inFlight.get(key)?.promise === flight) this.#inFlight.delete(key);
    }
  }

  #isCurrent(intent: ResetCreditAutoRedeemIntent, epoch: number): boolean {
    return !this.#disposed && this.#deps.isEnabled() && this.#epochs.get(intent.accountId) === epoch;
  }
}
