/**
 * The four things a starting proxy changes on the machine **outside its own home**.
 *
 * Codex's `config.toml`, Grok's `config.toml`, the shell profile hook, and
 * system-wide environment variables. All four are reverted on a clean shutdown
 * and none of them by a crash or a force-kill.
 *
 * They live together here for one reason: so the decision to run them is made
 * **once**, and a fifth integration added later cannot quietly miss the gate.
 * The previous arrangement had them scattered across forty lines of the start
 * path, and the debug sandbox — whose entire promise is "look at the app without
 * changing anything" — skipped none of them. A sandboxed start pointed the
 * user's real Codex install at the proxy and rewrote their real Grok config.
 *
 * Dependencies are injected rather than imported so this is testable without a
 * real `ocx start`, which is precisely the thing that edits the machine. An
 * earlier attempt tested the gate by scanning `src/cli/index.ts` for the guard
 * near each call; it passed with a gate deleted (the window was measured from
 * the declaration, which always contains the word), and the tightened version
 * then failed on correct code because a comment sits 325 characters before one
 * of the calls. Source-scanning was measuring comment length. This is the same
 * check done properly.
 */

import { clientIntegrationsAllowed } from "./debug-sandbox";

export interface ClientIntegrations {
  /** System-wide environment variables pointing tools at the proxy. */
  injectSystemEnv: () => Promise<void>;
  /** The shell profile hook. */
  installShellHook: () => void;
  /** Codex's own `config.toml`. */
  syncModelsToCodex: () => Promise<void>;
  /** Grok's own `config.toml`. */
  syncGrokConfig: () => Promise<void>;
}

export interface ApplyResult {
  /** False when the sandbox declined the whole set. */
  applied: boolean;
  /** Integrations that threw, by name. Never fatal — startup must not depend on them. */
  failed: string[];
}

/**
 * Run every client integration, or none.
 *
 * All-or-nothing on purpose: a half-configured machine — Codex pointed at the
 * proxy but Grok not — is harder to reason about than either end state, and the
 * sandbox's promise is about the machine rather than about any one file.
 *
 * Individual failures are collected rather than thrown. None of these may block
 * the proxy from serving, but swallowing them silently is how a stale config
 * survives unnoticed, so the caller gets the names and reports them.
 */
export async function applyClientIntegrations(
  integrations: ClientIntegrations,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyResult> {
  if (!clientIntegrationsAllowed(env)) return { applied: false, failed: [] };

  const failed: string[] = [];
  const run = async (name: keyof ClientIntegrations) => {
    try { await integrations[name](); }
    catch { failed.push(name); }
  };

  // Environment first, and only after the caller has installed its signal
  // handlers: the revert runs from those, so injecting earlier leaves a window
  // where a crash strands a system-wide variable pointing at a dead port.
  await run("injectSystemEnv");
  await run("installShellHook");
  await run("syncModelsToCodex");
  await run("syncGrokConfig");
  return { applied: true, failed };
}
