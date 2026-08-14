/**
 * `ocx schedule` — the headless counterpart to the dashboard's Scheduled
 * settings page.
 *
 * ## Rules are not readable from here, and this command says so rather than
 * inventing a server-side list
 *
 * A scheduled-settings rule (its days/time window, priority, and what it
 * sets) lives only in the dashboard's own browser profile — `localStorage`
 * under the key `SCHEDULE_KEY` in `gui/src/scheduling/schema.ts`
 * (`ocx-m3:schedule`) — created, edited and deleted entirely client-side by
 * `gui/src/pages/ScheduledSettings.tsx`. Nothing about a rule's shape,
 * membership, or which one is currently matching is ever sent to this
 * process or persisted server-side: `useScheduleRuntime`
 * (`gui/src/scheduling/runtime.ts`) resolves precedence and the active
 * override entirely in React state, and `readScheduleState`/
 * `writeScheduleState` (`gui/src/scheduling/schema.ts`) only ever touch
 * `localStorage`.
 *
 * So `status`, `list`, `show` and `active` all say the same true thing where
 * the dashboard would show a value: there is nothing here to read, and here
 * is exactly where to find it — the same shape `ocx narrator status`
 * (`src/cli/narrator.ts`) uses for the narrator's own browser-only
 * preferences. A command that invented a server-side rule store "to look
 * complete" would be lying about where the data lives, and would silently
 * drift from the real one the moment the dashboard's model changed under it.
 *
 * The precedence rule itself is safe to *state* here — it is a fixed policy,
 * not a computation over rule data this process never receives: highest
 * `priority` wins among the rules currently matching; a tie goes to whichever
 * rule was created more recently. Keep `PRECEDENCE_RULE` below in sync with
 * the canonical statement in `matchingRulesByPrecedence`'s doc comment in
 * `gui/src/scheduling/match.ts`. This file only ever *quotes* that rule in
 * prose — it never recomputes it, because there is no rule data here to
 * compute it over, and duplicating the matching algorithm itself (rather than
 * describing it) is exactly the drift risk the parity contract exists to
 * avoid.
 *
 * ## What genuinely IS headless: the two remote-source checks and the token vault
 *
 * An `api`- or `homeAssistant`-sourced rule depends on a remote endpoint the
 * dashboard already validates through `/api/schedule/resolve-api` and
 * `/api/schedule/ha-state` (see `src/server/management/schedule-routes.ts`)
 * — server-side, bounded, SSRF-checked, and never called directly from the
 * renderer (its CSP is `connect-src 'self'`). `test-api` and `test-ha` are
 * thin passthroughs onto those same routes: same validation, same bounds,
 * same allowlist, so a user can find out — headlessly, before ever opening
 * the dashboard's rule editor — whether a candidate URL or Home Assistant
 * entity will actually resolve. The URL/entity allowlist is deliberately
 * NOT re-validated here: it is a security boundary (SSRF protection), and
 * the route that already enforces it server-side is meant to be the only
 * copy of that check that exists.
 *
 * `ha-token status`/`clear` read and delete presence in the OS credential
 * vault through that same route. There is deliberately no `ha-token set`:
 * storing one requires the plaintext token, and this command must never
 * accept, print, or log a secret. A token is typed once into the dashboard's
 * own password field (`gui/src/pages/ScheduledSettings.tsx`) and stored
 * through `PUT /api/schedule/ha-token` from there — the same boundary
 * `ocx host` draws around minting a data-plane key versus ever printing one
 * back out.
 */

import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx schedule status [--json]
  ocx schedule list [--json]
  ocx schedule show <id> [--json]
  ocx schedule active [--json]
  ocx schedule test-api <url> [--json]
  ocx schedule test-ha --base-url <url> --entity-id <id> --token-ref <ref> [--json]
  ocx schedule ha-token status --token-ref <ref> [--json]
  ocx schedule ha-token clear --token-ref <ref> [--json]`;

/** Where the rules actually live. See the file header for why. */
const RULE_STORE = "the dashboard's own browser profile (local storage key ocx-m3:schedule)";
const RULE_SURFACE = "the dashboard, under Scheduled settings";
/** Must stay in sync with `matchingRulesByPrecedence` in gui/src/scheduling/match.ts. */
const PRECEDENCE_RULE =
  "When more than one enabled rule matches the current moment, the highest priority wins; "
  + "a tie goes to whichever rule was created more recently.";

interface RulesUnavailable {
  readable: false;
  storedIn: string;
  manageAt: string;
  precedence: string;
}

function rulesUnavailable(): RulesUnavailable {
  return { readable: false, storedIn: RULE_STORE, manageAt: RULE_SURFACE, precedence: PRECEDENCE_RULE };
}

/** The shared honest non-answer `list`, `show` and `active` each specialise with one lead line. */
function printUnavailable(lead: string, wantsJson: boolean): void {
  const rules = rulesUnavailable();
  printData({ rules }, wantsJson, [
    lead,
    `Rules are stored in ${rules.storedIn}, not in this machine's server-side configuration.`,
    `Manage and inspect them in ${rules.manageAt}.`,
    `Precedence rule: ${rules.precedence}`,
  ]);
}

/* ----------------------------------------------------------------- status -- */

async function status(argv: string[], _deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);

  const rules = rulesUnavailable();
  printData(
    {
      rules,
      headlessChecks: {
        testApi: "ocx schedule test-api <url>",
        testHa: "ocx schedule test-ha --base-url <url> --entity-id <id> --token-ref <ref>",
        haTokenStatus: "ocx schedule ha-token status --token-ref <ref>",
      },
    },
    wantsJson,
    [
      "Scheduled-settings rules are not readable from here.",
      `They live in ${rules.storedIn}.`,
      `List, create, edit and delete them in ${rules.manageAt}.`,
      `Precedence rule: ${rules.precedence}`,
      "",
      "What this machine CAN check headlessly, without the dashboard:",
      "  ocx schedule test-api <url>",
      "      Test an api-sourced rule's endpoint the same way the dashboard would.",
      "  ocx schedule test-ha --base-url <url> --entity-id <id> --token-ref <ref>",
      "      Test a Home Assistant-gated rule's entity the same way the dashboard would.",
      "  ocx schedule ha-token status --token-ref <ref>",
      "      Whether a Home Assistant token is stored for a rule — never its value.",
    ],
  );
}

/* --------------------------------------------------------- list/show/active -- */

async function list(argv: string[], _deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printUnavailable("Scheduled-settings rules cannot be listed from here — none is stored server-side.", wantsJson);
}

async function show(argv: string[], _deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("ocx schedule show requires a rule id", USAGE);
  printUnavailable(`Rule "${id}" cannot be inspected from here — no rule is stored server-side to look up.`, wantsJson);
}

async function active(argv: string[], _deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printUnavailable(
    "Which rule is currently winning cannot be reported from here — matching and precedence are"
    + " resolved entirely in the dashboard's own browser state, and nothing about the result is"
    + " sent to or stored by this process.",
    wantsJson,
  );
}

/* ------------------------------------------------------------- test-api -- */

interface ResolveApiResult {
  ok: boolean;
  values?: Record<string, unknown>;
  reason?: string;
  error?: string;
}

async function testApi(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const url = args.shift();
  rejectArgs(args, USAGE);
  if (!url) throw new CliUsageError("ocx schedule test-api requires a URL", USAGE);

  const result = await runtimeRequest<ResolveApiResult>(
    "/api/schedule/resolve-api",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) },
    deps,
  );

  if (result.ok) {
    const entries = Object.entries(result.values ?? {});
    printData(result, wantsJson, [
      `OK — ${entries.length} value(s) resolved:`,
      ...entries.map(([key, value]) => `  ${key}: ${String(value)}`),
    ]);
    return;
  }
  // Reported, not thrown — the same treatment `ocx narrator voices --edge`
  // gives an unreachable Edge catalogue: the check ran and got a definite
  // answer, which is success for this command even when the answer is "no".
  printData(result, wantsJson, [`Failed (${result.reason}): ${result.error}`]);
}

/* -------------------------------------------------------------- test-ha -- */

interface HaStateResult {
  ok: boolean;
  state?: string;
  reason?: string;
  error?: string;
}

async function testHa(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const baseUrl = takeOption(args, "--base-url");
  const entityId = takeOption(args, "--entity-id");
  const tokenRef = takeOption(args, "--token-ref");
  rejectArgs(args, USAGE);
  if (!baseUrl || !entityId || !tokenRef) {
    throw new CliUsageError("ocx schedule test-ha requires --base-url, --entity-id and --token-ref", USAGE);
  }

  const result = await runtimeRequest<HaStateResult>(
    "/api/schedule/ha-state",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl, entityId, tokenRef }) },
    deps,
  );

  if (result.ok) {
    printData(result, wantsJson, [
      `OK — state: ${result.state}`,
      result.state === "on"
        ? "This rule would apply its values right now (a time/priority match still decides whether it wins)."
        : `This rule would NOT apply right now — the entity reports "${result.state}", not "on".`,
    ]);
    return;
  }
  printData(result, wantsJson, [`Failed (${result.reason}): ${result.error}`]);
}

/* ------------------------------------------------------------- ha-token -- */

interface HaTokenStatusResult {
  configured: boolean;
  error?: string;
}

async function haToken(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const [sub, ...rest] = argv;
  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const tokenRef = takeOption(args, "--token-ref");
  rejectArgs(args, USAGE);
  if (!tokenRef) throw new CliUsageError("ocx schedule ha-token requires --token-ref", USAGE);

  if (sub === "status") {
    const result = await runtimeRequest<HaTokenStatusResult>(
      `/api/schedule/ha-token?tokenRef=${encodeURIComponent(tokenRef)}`,
      {},
      deps,
    );
    printData(result, wantsJson, [
      result.configured
        ? `A Home Assistant token IS stored for "${tokenRef}".`
        : `No Home Assistant token is stored for "${tokenRef}".`,
    ]);
    return;
  }

  if (sub === "clear") {
    const result = await runtimeRequest<{ ok: boolean }>(
      "/api/schedule/ha-token",
      { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenRef }) },
      deps,
    );
    printData(result, wantsJson, [`Cleared any Home Assistant token stored for "${tokenRef}".`]);
    return;
  }

  throw new CliUsageError(`unknown schedule ha-token command "${sub ?? ""}"`, USAGE);
}

/* ---------------------------------------------------------------- entry -- */

export async function handleScheduleCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "list") await list(rest, deps);
    else if (sub === "show") await show(rest, deps);
    else if (sub === "active") await active(rest, deps);
    else if (sub === "test-api") await testApi(rest, deps);
    else if (sub === "test-ha") await testHa(rest, deps);
    else if (sub === "ha-token") await haToken(rest, deps);
    else throw new CliUsageError(`unknown schedule command "${sub}"`, USAGE);
  });
}

export const SCHEDULE_USAGE = USAGE;
