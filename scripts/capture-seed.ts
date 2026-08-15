/**
 * Seeds a throwaway `OPENCODEX_HOME` with synthetic-but-realistic state before
 * `capture-shots.ts` launches Electron against it.
 *
 * ## Why this exists
 *
 * `capture-shots.ts` isolates the *renderer* profile (`--user-data-dir`) so
 * first-run surfaces are deterministic, but it never isolated the *proxy's*
 * state directory. Left unset, `OPENCODEX_HOME` falls back to `~/.opencodex` —
 * this machine's real config, real usage history, real accounts — which is two
 * bugs at once: the captures are non-deterministic (two machines, two sets of
 * screenshots from the same commit), and a real profile has been observed to
 * freeze the proxy solid (devlog b3-proxyhang; see `fetchWhamUsage` in
 * `src/codex/auth-api.ts`). `capture-shots.ts` now points `OPENCODEX_HOME`,
 * `CODEX_HOME` and `GROK_HOME` at directories under `node_modules/.cache/`,
 * wiped every run — this module is what fills the OPENCODEX_HOME one back up.
 *
 * An *empty* isolated profile was tried first and works, but it produces
 * useless screenshots: no providers beyond the keyless OAuth default, no
 * usage history, and — concretely — the app-bar cost chip and the whole Usage
 * page render nothing at all (`CostMeter.tsx` hides itself when no lane
 * priced anything, by design; see its own doc comment). `cost-meter` is an
 * existing capture target, so an unseeded isolated profile would silently
 * regress a target that used to pass against a real machine's data.
 *
 * ## Two stages, not one, because "rich" and "first-run" contradict each other
 *
 * `seedMinimalCaptureHome()` writes nothing but the stock default config with
 * its one builtin provider disabled — a genuinely first-run-looking state.
 * `seedRichCaptureHome()` layers the synthetic providers, combo and usage
 * history on top, once the running proxy is up. `capture-shots.ts` calls the
 * minimal one before Electron ever starts and the rich one immediately after
 * the wizard is captured, because `onboarding-state.ts`'s
 * `hasConfiguredProvider()` asks the live `/api/providers` endpoint whether
 * any provider is `configurationStatus: "ready"` and refuses to show the
 * wizard at all if one is — "the wizard must never be the reason a user
 * cannot reach the app", its own doc comment says, and correctly so.
 *
 * ## Why the rich stage is HTTP calls to the running proxy, not a file write
 *
 * An earlier version of this function just called `saveConfig()` a second
 * time, overwriting `config.json` on disk while Electron's proxy was already
 * running. That looked right — `loadConfig()` re-reads the file with no
 * caching of its own — and it silently produced a permanently stale
 * `dashboard.png`: "Providers 1 · Ready (0) · Disabled (1)", the MINIMAL
 * seed's exact numbers, no matter how long the harness waited or how hard it
 * reloaded the page afterward (`Page.reload({ ignoreCache: true })` changed
 * nothing either — reproduced, then ruled out as the cause).
 *
 * The real cause: `startServer()` (`src/server/index.ts`) calls `loadConfig()`
 * exactly ONCE, at startup, and holds the result in a closure variable for the
 * process's entire lifetime. Every `/api/*` handler reads THAT variable, not
 * the file — confirmed by fetching `/api/providers` from inside the page,
 * immediately after this module's `saveConfig()` call returned, and getting
 * the disabled MINIMAL row back. Nothing was wrong with the write; the
 * long-lived proxy process simply never looks at the file again once it has
 * booted, and closing over the config at startup is not a bug this capture
 * harness gets to work around by editing files underneath a process that
 * isn't watching them.
 *
 * The management API's own PATCH/POST/PUT handlers do not have this problem —
 * they mutate the SAME in-memory `config` object the request handlers close
 * over, then persist it, so the two can never disagree. So the rich stage
 * drives the exact endpoints the Providers and Combos pages themselves use:
 * `PATCH /api/providers?name=openai` to re-enable the disabled builtin,
 * `POST /api/providers` to add the two key-auth providers, and
 * `PUT /api/combos` for the combo — all against `apiBase`, all in-process.
 * Usage entries are the one exception and stay a direct file append:
 * `readUsageEntries()`/summary code reads `usage.jsonl` fresh on every
 * request (real traffic keeps appending to it forever; a request-scoped
 * re-read is the only sane design), which is exactly why the cost chip and
 * the token count updated correctly even while `Providers` stayed stuck.
 *
 * ## What this deliberately does NOT do
 *
 * - **No Codex OAuth accounts.** `listCodexAuthAccounts()` always returns at
 *   least the `main` row (native Codex login) even with zero pool accounts and
 *   zero network access — `readCodexTokensResult()` against an empty, isolated
 *   `CODEX_HOME` returns `"missing"` before any `fetch()` is attempted, so the
 *   `account-switcher` target's button and menu render with no network
 *   dependency at all. Adding fake *pool* accounts would only buy a second
 *   menu row at the cost of a real outbound call to `chatgpt.com` with a
 *   credential that cannot possibly authenticate — pure risk, no benefit.
 * - **No Grok / native-Codex config writes.** `GROK_HOME` is pointed at a
 *   directory that is never created, so `injectGrokConfig()` takes its
 *   documented `no-grok-home` no-op path. `CODEX_HOME` starts with no
 *   `config.toml`, so `currentExternalCodexModelProvider()` reads nothing and
 *   `syncModelsToCodex()` never writes to it either. Nothing this script does
 *   reaches outside `OPENCODEX_HOME`.
 *
 * ## The credentials below are sentinels, not secrets
 *
 * Every API key is an obviously-fake string that cannot resolve to a real
 * account under any provider's key format. They exist only so the Providers
 * page has more than one keyless OAuth row to show.
 */

import { getDefaultConfig, saveConfig } from "../src/config";
import { appendUsageEntry, type PersistedUsageEntry } from "../src/usage/log";
import type { OcxProviderConfig } from "../src/types";

const FAKE_ANTHROPIC_KEY = "sk-ant-CAPTURE-FIXTURE-000000000000000000000000";
const FAKE_OPENAI_KEY = "sk-CAPTURE-FIXTURE-0000000000000000000000000000";

const RICH_PROVIDERS: { name: string; provider: OcxProviderConfig }[] = [
  {
    name: "anthropic-apikey",
    provider: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: FAKE_ANTHROPIC_KEY },
  },
  {
    name: "openai-apikey",
    provider: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: FAKE_OPENAI_KEY },
  },
];

interface UsagePlanRow {
  provider: string;
  model: string;
  /** How long ago this request happened, in fractional days. */
  daysAgo: number;
  input: number;
  output: number;
  /** Defaults to 200. */
  status?: number;
  durationMs?: number;
}

/**
 * Twenty-two requests across the last ~23 days, spanning the `7d`/`30d`/`all`
 * Usage-page ranges and mixing every priced lane so the Providers, Usage,
 * Logs and Dashboard pages all have something real to show:
 *
 * - `openai` / `anthropic` (OAuth) price on the `api_equivalent` lane.
 * - `openai-apikey` / `anthropic-apikey` price on the `direct` lane — the one
 *   the app-bar cost chip prefers, so this is what makes it render at all.
 *
 * Two rows carry a non-200 status so the Logs page is not uniformly green,
 * the way a real week of traffic never is.
 */
const USAGE_PLAN: UsagePlanRow[] = [
  { provider: "openai", model: "gpt-5.6-sol", daysAgo: 0.05, input: 4200, output: 980 },
  { provider: "anthropic-apikey", model: "claude-sonnet-5", daysAgo: 0.2, input: 6100, output: 1450 },
  { provider: "openai", model: "gpt-5.6-terra", daysAgo: 0.6, input: 2300, output: 640 },
  { provider: "anthropic", model: "claude-sonnet-5", daysAgo: 1.1, input: 3100, output: 820 },
  { provider: "openai-apikey", model: "gpt-5.6-luna", daysAgo: 1.4, input: 1800, output: 410 },
  { provider: "openai", model: "gpt-5.6-sol", daysAgo: 2.0, input: 5200, output: 1230, status: 429 },
  { provider: "anthropic-apikey", model: "claude-opus-5", daysAgo: 2.3, input: 8900, output: 2100 },
  { provider: "openai", model: "gpt-5.6-terra", daysAgo: 3.1, input: 3400, output: 760 },
  { provider: "anthropic", model: "claude-haiku-4-5", daysAgo: 3.6, input: 1200, output: 380 },
  { provider: "openai-apikey", model: "gpt-5.6-sol", daysAgo: 4.2, input: 4700, output: 1100 },
  { provider: "openai", model: "gpt-5.6-luna", daysAgo: 5.0, input: 2100, output: 520 },
  { provider: "anthropic-apikey", model: "claude-sonnet-5", daysAgo: 6.4, input: 5600, output: 1340 },
  { provider: "openai", model: "gpt-5.6-sol", daysAgo: 7.2, input: 3900, output: 910 },
  { provider: "anthropic", model: "claude-sonnet-5", daysAgo: 8.5, input: 2700, output: 690 },
  { provider: "openai", model: "gpt-5.6-terra", daysAgo: 9.8, input: 6200, output: 1480, status: 500 },
  { provider: "openai-apikey", model: "gpt-5.6-luna", daysAgo: 11.0, input: 1500, output: 340 },
  { provider: "anthropic-apikey", model: "claude-opus-5", daysAgo: 12.5, input: 9800, output: 2450 },
  { provider: "openai", model: "gpt-5.6-sol", daysAgo: 14.0, input: 4100, output: 960 },
  { provider: "anthropic", model: "claude-opus-5", daysAgo: 16.2, input: 3300, output: 810 },
  { provider: "openai", model: "gpt-5.6-luna", daysAgo: 18.7, input: 1900, output: 430 },
  { provider: "anthropic-apikey", model: "claude-sonnet-5", daysAgo: 20.3, input: 4400, output: 1050 },
  { provider: "openai", model: "gpt-5.6-terra", daysAgo: 22.9, input: 2800, output: 650 },
];

function buildUsageEntries(now: number): PersistedUsageEntry[] {
  return USAGE_PLAN.map((row, index) => {
    const timestamp = Math.round(now - row.daysAgo * 24 * 60 * 60 * 1000);
    const status = row.status ?? 200;
    return {
      requestId: `capture-seed-${index}-${timestamp}`,
      timestamp,
      provider: row.provider,
      model: row.model,
      resolvedModel: row.model,
      requestedModel: row.model,
      promptInputTokens: row.input,
      status,
      durationMs: row.durationMs ?? 800 + (index * 137) % 4200,
      usageStatus: "reported",
      usage: { inputTokens: row.input, outputTokens: row.output },
      totalTokens: row.input + row.output,
    } satisfies PersistedUsageEntry;
  });
}

/**
 * Nothing `hasConfiguredProvider()` (`gui/src/shell/onboarding-state.ts`) can
 * call ready, so the `onboarding` target's wizard actually opens.
 *
 * Not simply `getDefaultConfig()` as written. That default's `openai` entry
 * uses `authMode: "forward"`, and `providerConfigurationState()`
 * (`src/providers/setup-status.ts`) treats every forward/oauth/local/
 * key-optional provider as `"ready"` UNCONDITIONALLY — deliberately, so the
 * app works the moment a user's existing Codex login is available, with zero
 * setup. Proven live against this exact default config with an otherwise
 * empty, isolated `OPENCODEX_HOME`: `GET /api/providers` answers
 * `configurationStatus: "ready", configurationReason: "forward"` for `openai`
 * alone. `hasConfiguredProvider()` finds that one "ready" row and
 * `decideFirstRun()` refuses to open the wizard — correctly, per its own
 * tests (`gui/tests/onboarding-wizard.test.tsx`, "stays shut when a provider
 * is already configured", asserted with `configurationReason: "forward"`
 * verbatim). So the stock default is not actually a state the wizard is
 * *meant* to open on, whatever "fresh install" suggests.
 *
 * The state it IS meant to open on, per that same suite's own fixture, is no
 * ready provider at all: `stubProviders([])` for "opens on a fresh profile
 * with nothing connected". This mirrors that with a real config rather than a
 * mocked fetch — the default provider stays present (so nothing downstream
 * that expects `providers.openai` to exist sees a dangling `defaultProvider`
 * reference) but disabled, which `providerConfigurationState()` reports as
 * `"disabled"`, never `"ready"`.
 *
 * This is the one stage still allowed to write `config.json` directly: it
 * runs BEFORE Electron (and the proxy it spawns) ever starts, so there is no
 * long-lived process holding a stale in-memory copy yet — see the module doc
 * comment for why the rich stage below cannot do the same thing.
 */
export async function seedMinimalCaptureHome(): Promise<void> {
  const config = getDefaultConfig();
  config.providers = {
    ...config.providers,
    openai: { ...config.providers.openai, disabled: true },
  };
  saveConfig(config);
}

async function postJson(url: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * The full synthetic providers, combo and usage history, applied against the
 * ALREADY-RUNNING proxy at `apiBase` (e.g. `http://127.0.0.1:10188`). See the
 * module doc comment for why this goes through the management API rather
 * than a second `saveConfig()` call.
 */
export async function seedRichCaptureHome(apiBase: string): Promise<void> {
  await postJson(`${apiBase}/api/providers?name=openai`, "PATCH", { disabled: false });
  for (const { name, provider } of RICH_PROVIDERS) {
    await postJson(`${apiBase}/api/providers`, "POST", { name, provider });
  }
  await postJson(`${apiBase}/api/combos`, "PUT", {
    id: "daily-driver",
    combo: {
      targets: [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "anthropic-apikey", model: "claude-sonnet-5" },
      ],
      strategy: "failover",
    },
  });
  for (const entry of buildUsageEntries(Date.now())) appendUsageEntry(entry);
}

if (import.meta.main) {
  const port = Number(process.env.OCX_CAPTURE_PORT || 10188);
  await seedMinimalCaptureHome();
  console.log("Seeded minimal OPENCODEX_HOME. Start the proxy, then run with OCX_CAPTURE_SEED_RICH=1 to layer the rich seed on.");
  if (process.env.OCX_CAPTURE_SEED_RICH === "1") {
    await seedRichCaptureHome(`http://127.0.0.1:${port}`);
    console.log("Seeded rich capture state via the live management API.");
  }
}
