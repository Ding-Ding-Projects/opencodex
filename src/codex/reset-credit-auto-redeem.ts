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
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(deps: ResetCreditAutoRedeemDependencies, leadTimeMs = DEFAULT_LEAD_TIME_MS) {
    if (!Number.isSafeInteger(leadTimeMs) || leadTimeMs < 0 || leadTimeMs > MAX_LEAD_TIME_MS) {
      throw new TypeError("leadTimeMs must be a bounded non-negative integer");
    }
    this.#deps = deps;
    this.#leadTimeMs = leadTimeMs;
  }

  schedule(state: ResetCreditAutoRedeemState): void {
    if (!this.#deps.isEnabled() || !state.accountId || !state.generation || state.available <= 0
      || !Number.isFinite(state.expiresAt)) return;
    const key = `${state.accountId}\0${state.generation}`;
    this.cancel(state.accountId, state.generation);
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
    this.#timers.set(key, setTimeout(() => { void this.#run(intent); }, delay));
  }

  recover(accountId: string): void {
    if (!this.#deps.isEnabled()) return;
    const intent = this.#deps.loadIntent?.(accountId);
    if (!intent) return;
    void this.#run(intent);
  }

  cancel(accountId: string, generation?: string): void {
    for (const [key, timer] of this.#timers) {
      if (key.startsWith(`${accountId}\0`) && (generation === undefined || key === `${accountId}\0${generation}`)) {
        clearTimeout(timer);
        this.#timers.delete(key);
      }
    }
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  private now(): number { return this.#deps.now?.() ?? Date.now(); }

  async #run(intent: ResetCreditAutoRedeemIntent): Promise<void> {
    if (!this.#deps.isEnabled()) return;
    const key = `${intent.accountId}\0${intent.generation}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const flight = (async () => {
      const fresh = await this.#deps.refreshAuthoritative(intent.accountId);
      const now = this.now();
      if (!fresh || fresh.accountId !== intent.accountId || fresh.generation !== intent.generation
        || fresh.available <= 0 || !Number.isFinite(fresh.expiresAt)
        || fresh.expiresAt !== intent.expiresAt || now < fresh.expiresAt - this.#leadTimeMs || now >= fresh.expiresAt) return;
      const terminal = await this.#deps.consume(intent);
      if (terminal === "reset" || terminal === "already_redeemed" || terminal === "nothing_to_reset" || terminal === "no_credit") {
        this.#deps.clearIntent?.(intent);
      }
    })();
    this.#inFlight.set(key, flight);
    try { await flight; } finally { this.#inFlight.delete(key); }
  }
}
