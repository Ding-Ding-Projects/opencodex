/**
 * /api/host — the dashboard's surface for `ocx host` and `ocx export`, sharing
 * their implementations so GUI and CLI cannot drift.
 *
 * Endpoints (all behind the standard management-auth gate):
 * - GET  /api/host                → bind status, LAN URLs, credential presence
 * - PUT  /api/host                → { exposed, hostname?, newKeyName? } enable/disable;
 *                                    refuses to expose without a data-plane credential
 *                                    (mirrors assertServerAuthConfig — never writes a
 *                                    config that would kill the next start). Returns
 *                                    the minted key plaintext AT MOST ONCE.
 * - GET  /api/host/admin-token    → the management credential, for handing to another
 *                                    device. The caller by definition already holds
 *                                    management access (this route sits behind it), so
 *                                    this reveals nothing the caller could not already
 *                                    use — but it is still served with no-store.
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
 *                                    or argument ever reaches a process.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, saveConfigPreservingClaudeCode } from "../../config";
import { addCustomDataPlaneKey, describeHost, hasDataPlaneCredential, mintDataPlaneKey } from "../../lib/host-control";
import { listStateHistory, listStateHistoryEntries, restoreStateFromHistory } from "../../lib/state-history";
import { drainAndShutdown, quiesceActiveTurns, setDraining } from "../lifecycle";
import { acceptSystemRestartAfterExternalDrain } from "./system-restart";
import { isLoopbackHostname, jsonResponse } from "../auth-cors";
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

function readJsonIfPresent(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { unreadable: true };
  }
}

export async function handleHostRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/host" && req.method === "GET") {
    return jsonResponse(describeHost(config), 200, req, config);
  }

  if (url.pathname === "/api/host" && req.method === "PUT") {
    let body: { exposed?: boolean; hostname?: string; newKeyName?: string; customKeyValue?: string };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }

    if (body.exposed === false) {
      config.hostname = "127.0.0.1";
      saveConfigPreservingClaudeCode(config);
      return jsonResponse({ ...describeHost(config), restartRequired: true }, 200, req, config);
    }

    // Key-only operation: store a user-chosen key WITHOUT touching the bind.
    // Adding a credential must never be the thing that exposes the proxy.
    if (body.exposed === undefined && typeof body.customKeyValue === "string") {
      const result = addCustomDataPlaneKey(config, (body.newKeyName ?? "custom").trim() || "custom", body.customKeyValue);
      if ("error" in result) return jsonResponse({ error: result.error }, 400, req, config);
      saveConfigPreservingClaudeCode(config);
      return noStore(jsonResponse({ ...describeHost(config), mintedKey: result.key, restartRequired: false }, 200, req, config));
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
    } else if (typeof body.newKeyName === "string") {
      mintedKey = mintDataPlaneKey(config, body.newKeyName.trim() || "network");
    }
    if (!hasDataPlaneCredential(config)) {
      // Mirror assertServerAuthConfig instead of writing a config that kills the next start.
      return jsonResponse({
        error: "An exposed bind requires a data-plane credential. Pass newKeyName to generate one, or create a key first.",
      }, 409, req, config);
    }

    config.hostname = hostname;
    saveConfigPreservingClaudeCode(config);
    // The plaintext key rides this one response and is never readable again.
    return noStore(jsonResponse({ ...describeHost(config), mintedKey, restartRequired: true }, 200, req, config));
  }

  if (url.pathname === "/api/host/admin-token" && req.method === "GET") {
    const envToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
    const { loadAdminTokenFromFile } = await import("../../lib/admin-secrets");
    const token = envToken || loadAdminTokenFromFile();
    if (!token) return jsonResponse({ error: "no admin token exists yet" }, 404, req, config);
    return noStore(jsonResponse({ adminToken: token }, 200, req, config));
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
    return jsonResponse({ targets: listLaunchTargets() }, 200, req, config);
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

  if (url.pathname === "/api/host/restore" && req.method === "POST") {
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
