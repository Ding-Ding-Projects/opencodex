/**
 * /api/host — the dashboard's surface for `ocx host` and `ocx export`, sharing
 * their implementations so GUI and CLI cannot drift.
 *
 * Endpoints (all on the intentionally open management plane):
 * - GET  /api/host                → bind status, LAN URLs, credential presence
 * - PUT  /api/host                → { exposed, hostname?, newKeyName?, mintKeyIfMissing? }
 *                                    enable/disable; refuses to expose without a data-plane
 *                                    credential (mirrors assertServerAuthConfig — never writes
 *                                    a config that would kill the next start). Returns the
 *                                    minted key plaintext AT MOST ONCE.
 * - POST /api/host/pair           → mint a QR pairing token, { token, expiresAt }
 * - DELETE /api/host/pair         → cancel the outstanding token (the panel closed)
 * - POST /api/host/pair/claim     → DELIBERATELY UNAUTHENTICATED. Spend a token, receive a
 *                                    data-plane key once. See the block comment above the
 *                                    handler, and src/lib/pairing.ts for why that is safe.
 * - GET  /api/host/export         → the full state bundle (config + accounts + auth),
 *                                    Content-Disposition: attachment. Same content as
 *                                    `ocx export`; the GUI shows the same warning and
 *                                    requires an explicit confirmation click.
 * - GET  /api/host/history        → account-change snapshots (`ocx export --history`),
 *                                    both as display lines and as addressable entries.
 * - POST /api/host/restore        → { commit, drainMs?, force? } one-click restore.
 *                                    Finishes and hands off in-flight turns first, 409s
 *                                    with the live count rather than cutting sessions off,
 *                                    then rolls the state files back and restarts. The
 *                                    pre-restore state is committed first, so the restore
 *                                    is itself undoable.
 * - POST /api/host/exit           → { drainMs?, force? } graceful "exit app": same
 *                                    hand-off and 409 warning, then the same teardown as
 *                                    POST /api/stop, then exit — so the desktop shell can
 *                                    close behind a proxy that stopped cleanly.
 * - GET  /api/launch               → the Codex/Grok/Claude CLI and desktop-app targets,
 *                                    each with whether it is installed on this machine.
 * - POST /api/launch               → { id } launch one catalog target. The id is matched
 *                                    against a fixed catalog, so no caller-supplied path
 *                                    or argument ever reaches a process. A failure carries
 *                                    a `reason` code as well as a sentence, so the
 *                                    dashboard can offer the fix (install Windows
 *                                    Terminal) instead of only printing the problem.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, saveConfigPreservingClaudeCode } from "../../config";
import { addCustomDataPlaneKey, describeHost, hasDataPlaneCredential, mintDataPlaneKey } from "../../lib/host-control";
import { DEBUG_SANDBOX_ENV, announceDebugSandboxOnce, debugSandboxEnabled, setSandboxExposedPreview } from "../../lib/debug-sandbox";
import { cancelPairing, claimPairingToken, createPairingToken, hasOutstandingPairing } from "../../lib/pairing";
import { takeClaimAttempt } from "../../lib/pairing-rate-limit";
import { listStateHistory, listStateHistoryEntries, restoreStateFromHistory } from "../../lib/state-history";
import { drainAndShutdown, getServerListenHostname, quiesceActiveTurns, setDraining } from "../lifecycle";
import { acceptSystemRestartAfterExternalDrain } from "./system-restart";
import { isLoopbackHostname, jsonResponse } from "../auth-cors";
import type { OcxConfig } from "../../types";
import type { ManagementContext } from "./context";

/** Default hand-off window for restore/exit, and the ceiling a caller may ask for. */
const DEFAULT_DRAIN_MS = 60_000;
const MAX_DRAIN_MS = 300_000;

function drainWindowMs(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_DRAIN_MS;
  return Math.min(Math.max(Math.trunc(requested), 0), MAX_DRAIN_MS);
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** The pairing claim path is kept as a named invariant for its token-bound handler. */
export const PAIRING_CLAIM_PATH = "/api/host/pair/claim";

export function isUnauthenticatedPairingClaim(method: string, pathname: string): boolean {
  return method === "POST" && pathname === PAIRING_CLAIM_PATH;
}

/**
 * The most a pairing claim body may weigh.
 *
 * A claim is `{"token":"<43 chars>"}` — about sixty bytes. 4 KiB is three orders
 * of magnitude of slack for a client that sends odd whitespace or an extra
 * field, and still small enough that an anonymous caller cannot turn the route
 * into a memory-and-CPU sink. Without a ceiling here Bun's own 128 MiB default
 * applies, and this is the only management route that answers with no
 * credential at all.
 */
export const MAX_CLAIM_BODY_BYTES = 4096;

/**
 * Read a request body, giving up once it exceeds `limit` bytes.
 *
 * Streamed rather than `await req.text()` so an oversized body is abandoned
 * partway instead of being fully buffered and then measured — measuring after
 * the fact would mean the allocation this exists to prevent has already
 * happened. Returns `null` when the limit is passed.
 */
async function readBoundedText(req: Request, limit: number): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // A connection that dies mid-body is not a claim; treat it as an empty one
    // and let the JSON parse below answer 400.
    return "";
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

/**
 * Whether the configured bind and the live socket disagree.
 *
 * `PUT /api/host` writes `config.hostname` immediately, but `Bun.serve` fixed
 * the listening address at startup and only a restart moves it. Reporting only
 * the config would have the dashboard say "reachable from other devices" while
 * the socket was still answering loopback alone — the screen claiming a change
 * took effect when nothing outside this process can see it yet.
 *
 * Normalized the same way `startServer` normalizes it, so a config that says
 * `localhost` and a socket bound to `127.0.0.1` are correctly reported as
 * agreeing rather than as a pending restart that will never arrive.
 */
function bindHostFor(config: OcxConfig): string {
  const configured = config.hostname?.trim();
  return !configured || /^localhost$/i.test(configured) ? "127.0.0.1" : configured;
}

function restartPending(config: OcxConfig): boolean {
  const listening = getServerListenHostname();
  // No listener in this process (the CLI, a unit test) means there is nothing
  // for the config to disagree with — not a pending restart.
  if (listening === undefined) return false;
  return listening !== bindHostFor(config);
}

/** GET/PUT /api/host share one body shape, so the dashboard reads one contract. */
function hostStatusBody(config: OcxConfig): ReturnType<typeof describeHost> & { restartPending: boolean } {
  return { ...describeHost(config), restartPending: restartPending(config) };
}

function readJsonIfPresent(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { unreadable: true };
  }
}

/**
 * Percent-decode a path segment, or null when it is malformed.
 *
 * `new URL()` leaves an invalid escape (`/api/launch/install/%`) verbatim in
 * `pathname`, so `decodeURIComponent` throws a `URIError` — and nothing between
 * here and `Bun.serve` catches it, so the request that should have produced a
 * tidy 404 got Bun's generic 500 error page instead.
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function handleHostRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/host" && req.method === "GET") {
    return jsonResponse(hostStatusBody(config), 200, req, config);
  }

  if (url.pathname === "/api/host" && req.method === "PUT") {
    let body: {
      exposed?: boolean; hostname?: string; newKeyName?: string;
      customKeyValue?: string; mintKeyIfMissing?: boolean;
    };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }

    if (body.exposed === false) {
      if (debugSandboxEnabled()) {
        setSandboxExposedPreview(null);
        return jsonResponse({ ...hostStatusBody(config), restartRequired: false }, 200, req, config);
      }
      config.hostname = "127.0.0.1";
      saveConfigPreservingClaudeCode(config);
      return jsonResponse({ ...hostStatusBody(config), restartRequired: true }, 200, req, config);
    }

    // Key-only operation: store a user-chosen key WITHOUT touching the bind.
    // Adding a credential must never be the thing that exposes the proxy.
    if (body.exposed === undefined && typeof body.customKeyValue === "string") {
      const result = addCustomDataPlaneKey(config, (body.newKeyName ?? "custom").trim() || "custom", body.customKeyValue);
      if ("error" in result) return jsonResponse({ error: result.error }, 400, req, config);
      saveConfigPreservingClaudeCode(config);
      return noStore(jsonResponse({ ...hostStatusBody(config), mintedKey: result.key, restartRequired: false }, 200, req, config));
    }

    if (body.exposed !== true) {
      return jsonResponse({ error: "exposed must be true or false" }, 400, req, config);
    }

    const hostname = typeof body.hostname === "string" && body.hostname.trim() ? body.hostname.trim() : "0.0.0.0";
    if (isLoopbackHostname(hostname)) {
      return jsonResponse({ error: "hostname is a loopback address, which other devices cannot reach" }, 400, req, config);
    }

    let mintedKey: string | null = null;
    if (typeof body.customKeyValue === "string") {
      // User-chosen key: validated (length floor, no whitespace) and stored in
      // plaintext like every data-plane key — the GUI warns against reusing a
      // real password before this request is ever sent.
      const result = addCustomDataPlaneKey(config, (body.newKeyName ?? "custom").trim() || "custom", body.customKeyValue);
      if ("error" in result) return jsonResponse({ error: result.error }, 400, req, config);
      mintedKey = result.key;
    } else if (body.mintKeyIfMissing === true) {
      // The one-click opt-in. Enabling remote access used to mean inventing a
      // password on the laptop and typing it on the phone, which is most of the
      // reason the feature went unused — so the caller may ask for the
      // credential to be generated as PART of enabling.
      //
      // The invariant is untouched: this mints a credential, it does not waive
      // the requirement for one. The `hasDataPlaneCredential` gate below still
      // runs, and still refuses the exposed bind if nothing ended up stored.
      //
      // "IfMissing", not "always". `newKeyName` on its own mints unconditionally,
      // so a user toggling remote access off and on three times accreted three
      // live keys they never asked for and could not read. Enabling something
      // that is already enabled should add nothing.
      //
      // Not in the debug sandbox, which promises to issue no credential. Without
      // this the one-click opt-in handed out a real `ocx_…` key captioned "shown
      // once, store it now" — live against the running process and gone at the
      // next start, so the user was being told to save something worthless while
      // a mode that says it issues no keys quietly issued one.
      if (!hasDataPlaneCredential(config) && !debugSandboxEnabled()) {
        mintedKey = mintDataPlaneKey(config, (body.newKeyName ?? "network").trim() || "network");
      }
    } else if (typeof body.newKeyName === "string" && !debugSandboxEnabled()) {
      mintedKey = mintDataPlaneKey(config, body.newKeyName.trim() || "network");
    }
    // The credential gate is waived in the sandbox, and only there. Its purpose
    // is to refuse writing a config whose next start would die on a missing
    // credential — and in the sandbox there is no write and therefore no next
    // start to protect. Enforcing it here would instead make the screen
    // unreachable in the one mode built for looking at it.
    if (!hasDataPlaneCredential(config) && !debugSandboxEnabled()) {
      // Mirror assertServerAuthConfig instead of writing a config that kills the next start.
      return jsonResponse({
        error: "An exposed bind requires a data-plane credential. Pass mintKeyIfMissing to generate one, or create a key first.",
      }, 409, req, config);
    }

    // In the sandbox the bind is recorded for display and the live config is left
    // exactly as it was. Writing it here would be pointless (the save is blocked)
    // and actively harmful: `isApiAuthRequired` reads `config.hostname`, so the
    // running process would start demanding a credential for `/api/*` and `/v1/*`
    // while the sandbox refuses to mint one — leaving a process no credential can
    // satisfy, on the very flow this mode exists to demonstrate.
    if (debugSandboxEnabled()) {
      setSandboxExposedPreview(hostname);
      return noStore(jsonResponse({ ...hostStatusBody(config), mintedKey: null, restartRequired: true }, 200, req, config));
    }

    config.hostname = hostname;
    saveConfigPreservingClaudeCode(config);
    // The plaintext key rides this one response and is never readable again.
    return noStore(jsonResponse({ ...hostStatusBody(config), mintedKey, restartRequired: true }, 200, req, config));
  }

  // ---- QR pairing --------------------------------------------------------
  //
  // Minting and cancelling sit behind the standard management gate like every
  // other route in this file. Only the claim below is exempt.

  if (url.pathname === "/api/host/pair" && req.method === "POST") {
    const offer = createPairingToken();
    // no-store for the same reason the minted key is: this body is a live
    // secret, and a cached copy of it outlives the five minutes it is supposed
    // to be worth anything for.
    return noStore(jsonResponse({ token: offer.token, expiresAt: offer.expiresAt }, 200, req, config));
  }

  if (url.pathname === "/api/host/pair" && req.method === "DELETE") {
    // The dashboard calls this when the pairing panel closes, so a QR that was
    // displayed and then dismissed stops being claimable immediately rather
    // than lingering for the rest of its TTL.
    cancelPairing();
    return jsonResponse({ ok: true }, 200, req, config);
  }

  /**
   * Spend a pairing token for a data-plane key. **Deliberately unauthenticated.**
   *
   * It has to be: a phone that has never paired holds no credential to present.
   * `src/lib/pairing.ts` documents every property that makes that safe — 256
   * bits, single use, five-minute TTL, one outstanding at a time, constant-time
   * compare, and never an admin token — and `tests/pairing.test.ts` pins each
   * of them individually. `src/server/index.ts` is where the exemption is
   * actually made, keyed on `isUnauthenticatedPairingClaim`.
   *
   * Three things this handler owes on top of that core:
   *
   * 1. **Never 401.** The dashboard's fetch wrapper treats a 401 on `/api/*` as
   *    "ask the user for the admin token", so answering a mistyped pairing
   *    token with 401 would pop an admin-credential prompt on the phone of
   *    someone who by definition does not have one. A refused claim is a 400.
   * 2. **Never log the token or the key.** Nothing here writes either to a log,
   *    and the token travels in the body rather than the URL precisely so the
   *    request-line logging upstream cannot capture it.
   * 3. **Persist before answering.** The key is only real once it is on disk.
   */
  if (isUnauthenticatedPairingClaim(req.method, url.pathname)) {
    // Which budget pays depends on whether a code is actually on screen, so that
    // draining the endpoint while nobody is pairing cannot refuse the scan that
    // follows. Deliberately `hasOutstandingPairing` and not `peekPairing`: the
    // latter drops an expired token on read, which would rewrite this claim's
    // refusal from "expired" to "no-pairing" before it was even attempted.
    const attempt = takeClaimAttempt(hasOutstandingPairing());
    if (!attempt.allowed) {
      const response = jsonResponse({ error: "too many pairing attempts" }, 429, req, config);
      response.headers.set("Retry-After", String(attempt.retryAfterSeconds));
      return noStore(response);
    }

    // Read the body with a ceiling rather than trusting Bun's 128 MiB default.
    // This is the one route that answers without a credential, so an unbounded
    // body means an anonymous caller can make the process parse a hundred
    // megabytes of JSON and then copy it into a Buffer for a comparison that was
    // always going to fail on length. A pairing token is 43 characters.
    const raw = await readBoundedText(req, MAX_CLAIM_BODY_BYTES);
    if (raw === null) return noStore(jsonResponse({ error: "pairing request was too large" }, 413, req, config));

    let body: { token?: unknown };
    try { body = JSON.parse(raw) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
    const presented = typeof body.token === "string" ? body.token : "";

    const keysBefore = config.apiKeys;
    const result = claimPairingToken(presented, config);
    if (!result.ok) {
      // The reason is safe to hand back and is the difference between "scan a
      // fresh code" and "start pairing on the desktop first". It says nothing
      // about the token that was presented.
      return noStore(jsonResponse({ error: "pairing token was not accepted", reason: result.reason }, 400, req, config));
    }

    try {
      saveConfigPreservingClaudeCode(config);
    } catch (err) {
      // `claimPairingToken` mutates the live config and leaves persisting to us.
      // A failed write would otherwise leave a key this process honours but the
      // next one has never heard of — working now, gone after a restart, which
      // is the worst of the three possible outcomes. Roll the in-memory config
      // back so the state is simply "not paired", and say so.
      config.apiKeys = keysBefore;
      // No `detail`. This is the one route that answers without a credential, and
      // a write error's message is a filesystem path — the config directory, and
      // with it the account name it sits under. The desktop can see the real
      // failure; an unauthenticated caller gets "it did not save".
      void err;
      return noStore(jsonResponse({ error: "the pairing key could not be saved" }, 500, req, config));
    }

    // Shown exactly once, like every other minted key.
    return noStore(jsonResponse({ key: result.key }, 200, req, config));
  }

  if (url.pathname === "/api/host/export" && req.method === "GET") {
    const dir = getConfigDir();
    const bundle = {
      kind: "opencodex-export",
      exportedAt: new Date().toISOString(),
      warning: "CONTAINS PLAINTEXT SECRETS: provider API keys and Codex OAuth access/refresh tokens.",
      config,
      codexAccounts: readJsonIfPresent(join(dir, "codex-accounts.json")),
      auth: readJsonIfPresent(join(dir, "auth.json")),
    };
    const response = jsonResponse(bundle, 200, req, config);
    response.headers.set("Content-Disposition", 'attachment; filename="opencodex-export.json"');
    return noStore(response);
  }

  if (url.pathname === "/api/host/history" && req.method === "GET") {
    // `snapshots` stays for the plain reader; `entries` carries the hash a restore
    // needs as its own field, rather than something scraped off a display string.
    return jsonResponse({
      snapshots: listStateHistory(50),
      entries: listStateHistoryEntries(50),
    }, 200, req, config);
  }

  // One-press launching of the agent CLIs and their desktop apps. GET reports what is
  // actually installed so a button is never offered for something that cannot start.
  if (url.pathname === "/api/launch" && req.method === "GET") {
    const { listLaunchTargets } = await import("../../lib/app-launcher");
    const { canInstall, hasInstallRoute } = await import("../../lib/app-installer");
    // `installable` drives whether "Get it" installs or merely opens a page, so the
    // button can say which of the two it is going to do before it is pressed.
    const targets = listLaunchTargets().map(target => ({
      ...target,
      installable: canInstall(target.id),
      hasInstallRoute: hasInstallRoute(target.id),
    }));
    return jsonResponse({ targets }, 200, req, config);
  }

  // Automatic installation. The body carries a catalog id and nothing else — the
  // package id and every command-line argument come from constants in the installer.
  if (url.pathname === "/api/launch/install" && req.method === "POST") {
    let body: { id?: unknown };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return jsonResponse({ error: "id is required" }, 400, req, config);
    const { startInstall } = await import("../../lib/app-installer");
    const { launchTargetInstallUrl } = await import("../../lib/app-launcher");
    const result = startInstall(id);
    if (result.ok) return jsonResponse({ ok: true, job: result.job }, 200, req, config);
    // A target with no automatic route is not an error the user can act on by
    // retrying, so hand back the page to open instead of only saying "no".
    return jsonResponse(
      {
        ok: false,
        error: result.error,
        manual: result.manual === true,
        // "already there" is not a failure for a caller that is installing in
        // order to retry something else; it is the go-ahead.
        installed: result.installed === true,
        installUrl: launchTargetInstallUrl(id),
      },
      result.manual ? 200 : 409,
      req,
      config,
    );
  }

  if (url.pathname === "/api/launch/install" && req.method === "GET") {
    const { listInstallJobs } = await import("../../lib/app-installer");
    return jsonResponse({ jobs: listInstallJobs() }, 200, req, config);
  }

  if (url.pathname.startsWith("/api/launch/install/") && req.method === "GET") {
    const jobId = decodeSegment(url.pathname.slice("/api/launch/install/".length));
    if (jobId === null) return jsonResponse({ error: "unknown install job" }, 404, req, config);
    const { getInstallJob } = await import("../../lib/app-installer");
    const job = getInstallJob(jobId);
    if (!job) return jsonResponse({ error: "unknown install job" }, 404, req, config);
    return jsonResponse({ job }, 200, req, config);
  }

  if (url.pathname === "/api/launch" && req.method === "POST") {
    let body: { id?: unknown };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return jsonResponse({ error: "id is required" }, 400, req, config);
    // `id` is matched against a fixed catalog before anything spawns — no path and no
    // argument a caller sends ever reaches a process.
    const { launchTarget } = await import("../../lib/app-launcher");
    const outcome = launchTarget(id);
    return jsonResponse(outcome, outcome.ok ? 200 : 409, req, config);
  }

  // Discovery is user-initiated only: the wizard's "find an existing install"
  // button, never a background sweep. See lan-discovery.ts for what it refuses
  // to do and why.
  if (url.pathname === "/api/host/discover" && req.method === "POST") {
    const { discoverProxies } = await import("../../lib/lan-discovery");
    const found = await discoverProxies(config.port);
    return jsonResponse({ found }, 200, req, config);
  }

  // ---- Embedded terminal -------------------------------------------------
  //
  // Every route here is refused outright when the proxy is published to other
  // devices. A terminal is a shell: exposing one on a LAN-reachable dashboard
  // would turn a leaked management credential into a foothold on the machine,
  // which is a categorically worse outcome than leaking the provider config.
  if (url.pathname.startsWith("/api/terminal")) {
    const { isLoopbackHostname } = await import("../auth-cors");
    const { getServerListenHostname } = await import("../lifecycle");

    // The LIVE bind, not `config.hostname`. That field is writable at runtime by
    // `PUT /api/host` above, while the socket's address is fixed at Bun.serve()
    // and only a restart changes it. Reading the config would let a caller flip
    // the stored hostname to 127.0.0.1 and be handed a shell on a listener that
    // is still answering 0.0.0.0 — the gate would report a closed door while the
    // door stood open.
    //
    // Before the server is up there is no listener to ask. That is "unknown",
    // and unknown is treated as exposed: refusing a terminal that might have
    // been safe costs nothing, and the reverse costs the machine.
    const listening = getServerListenHostname();
    const boundLocally = listening !== undefined && isLoopbackHostname(listening);
    if (!boundLocally && config.terminal?.allowRemote !== true) {
      return jsonResponse({
        error: "The embedded terminal is disabled while the proxy is reachable from other devices. "
          + "Bind to 127.0.0.1, or set terminal.allowRemote if you accept that anyone who reaches "
          + "this dashboard gets a shell on this machine.",
      }, 403, req, config);
    }

    const terminal = await import("../../lib/terminal-session");

    if (url.pathname === "/api/terminal" && req.method === "GET") {
      return jsonResponse(
        { presets: terminal.PRESETS, sessions: terminal.listSessions() },
        200, req, config,
      );
    }

    if (url.pathname === "/api/terminal" && req.method === "POST") {
      let body: { preset?: unknown };
      try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
      const preset = typeof body.preset === "string" ? body.preset.trim() : "";
      if (!preset) return jsonResponse({ error: "preset is required" }, 400, req, config);
      const result = terminal.createSession(preset);
      return jsonResponse(result, result.ok ? 200 : 409, req, config);
    }

    const inputMatch = url.pathname.match(/^\/api\/terminal\/([^/]+)\/input$/);
    if (inputMatch && req.method === "POST") {
      let body: { data?: unknown };
      try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
      if (typeof body.data !== "string") return jsonResponse({ error: "data is required" }, 400, req, config);
      const sessionId = decodeSegment(inputMatch[1]);
      if (sessionId === null) return jsonResponse({ error: "unknown terminal session" }, 404, req, config);
      const result = terminal.writeSession(sessionId, body.data);
      return jsonResponse(result, result.ok ? 200 : 409, req, config);
    }

    const sessionMatch = url.pathname.match(/^\/api\/terminal\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const sessionId = decodeSegment(sessionMatch[1]);
      const read = sessionId === null ? null : terminal.readSession(
        sessionId,
        Number.isFinite(since) && since > 0 ? since : 0,
      );
      if (!read) return jsonResponse({ error: "unknown terminal session" }, 404, req, config);
      return jsonResponse(read, 200, req, config);
    }

    if (sessionMatch && req.method === "DELETE") {
      const killId = decodeSegment(sessionMatch[1]);
      if (killId === null) return jsonResponse({ error: "unknown terminal session" }, 404, req, config);
      const result = terminal.killSession(killId);
      return jsonResponse(result, result.ok ? 200 : 404, req, config);
    }
  }

  if (url.pathname === "/api/host/restore" && req.method === "POST") {
    // `restoreStateFromHistory` rewrites the state files directly — it does not
    // go through `saveConfig`, so the sandbox's guard never sees it. Restoring an
    // old revision would therefore be the one action in this mode that really
    // does change the machine's config on disk, which is precisely what the mode
    // exists not to do. Refused up front, before anything drains.
    if (debugSandboxEnabled()) {
      announceDebugSandboxOnce();
      return jsonResponse({
        success: false,
        error: `${DEBUG_SANDBOX_ENV} is set: restoring would write the state files directly, which this mode exists to prevent. Restart without it to restore.`,
      }, 409, req, config);
    }
    let body: { commit?: unknown; drainMs?: unknown; force?: unknown };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
    const commit = typeof body.commit === "string" ? body.commit.trim() : "";
    if (!commit) return jsonResponse({ error: "commit is required" }, 400, req, config);
    const force = body.force === true;

    // Finish and hand off before touching the state files: a restore rewrites the
    // credentials that in-flight requests are reading.
    const { drained, remaining } = await quiesceActiveTurns(drainWindowMs(body.drainMs));
    if (!drained && !force) {
      // Sessions are still running. Never cut them off behind the user's back —
      // resume serving and report the real count so the dashboard can warn.
      setDraining(false);
      return jsonResponse({
        success: false,
        reason: "sessions-in-progress",
        activeTurnCount: remaining,
        message: `${remaining} request(s) still in flight. Wait for them to finish, or repeat with force to restore anyway.`,
      }, 409, req, config);
    }

    const result = await restoreStateFromHistory(commit);
    if (!result.ok) {
      if (!result.touchedDisk) {
        // Nothing was written, so the live config still matches disk: go back to serving.
        setDraining(false);
        return jsonResponse({ success: false, ...result }, 400, req, config);
      }
      // Disk may have moved under us. Restart rather than let the stale in-memory
      // config save over a half-restored tree.
      acceptSystemRestartAfterExternalDrain();
      return jsonResponse({ success: false, ...result, restarting: true }, 500, req, config);
    }

    // Hand the restart over: the live config object predates the restore, and the
    // next save would write it straight back over the restored files.
    acceptSystemRestartAfterExternalDrain();
    return jsonResponse({
      success: true,
      ...result,
      restarting: true,
      abandonedTurnCount: remaining,
      message: "State restored. The proxy is restarting to load it.",
    }, 200, req, config);
  }

  // "Exit app": the graceful counterpart to killing the window. Drains first, warns
  // about live sessions instead of dropping them, then tears down the same fences
  // POST /api/stop does and exits — so the desktop shell can close behind it.
  if (url.pathname === "/api/host/exit" && req.method === "POST") {
    let body: { drainMs?: unknown; force?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* an empty body is a valid exit request */ }
    const force = body.force === true;

    const { drained, remaining } = await quiesceActiveTurns(drainWindowMs(body.drainMs));
    if (!drained && !force) {
      setDraining(false);
      return jsonResponse({
        success: false,
        reason: "sessions-in-progress",
        activeTurnCount: remaining,
        message: `${remaining} request(s) still in flight. Wait for them to finish, or repeat with force to exit anyway.`,
      }, 409, req, config);
    }

    const { stopServiceIfInstalled, isServiceOwnershipError } = await import("../../service");
    try {
      stopServiceIfInstalled();
    } catch (err) {
      // The installed service belongs to another OPENCODEX_HOME and would respawn this
      // proxy immediately. Refuse rather than half-exit — and resume serving, because
      // we already stopped admitting traffic.
      if (isServiceOwnershipError(err)) {
        setDraining(false);
        return jsonResponse({ success: false, message: (err as Error).message }, 409, req, config);
      }
      setDraining(false);
      throw err;
    }

    const { restoreNativeCodex } = await import("../../codex/inject");
    const codex = restoreNativeCodex();
    const { stripGrokConfig } = await import("../../grok/inject");
    const grok = stripGrokConfig();

    // Exit after the response has flushed, exactly as POST /api/stop does.
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);

    return jsonResponse({
      success: true,
      exiting: true,
      drained,
      abandonedTurnCount: remaining,
      codexRestored: codex.success,
      grokRestored: grok.ok,
      message: codex.success
        ? "Proxy stopping, native Codex restored."
        : `Proxy stopping, but native Codex restore failed: ${codex.message}. Run \`ocx restore\`.`,
    }, 200, req, config);
  }

  return null;
}
