/**
 * Disposable-host service-class acceptance entry point for WP13.
 *
 * This runner is deliberately outside ordinary test discovery. It performs the
 * owned service lifecycle on an explicitly disposable host, proves health after
 * each lifecycle transition, and emits only scalar evidence. A workstation is
 * refused before any service command is started.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const SERVICE_CLASS_PROFILES = ["P09", "P10", "P18", "P34", "P35", "P36"] as const;
export type ServiceClassProfile = (typeof SERVICE_CLASS_PROFILES)[number];
type Phase = "install" | "start" | "probe" | "restart" | "stop" | "uninstall";
type PhaseResult = { phase: Phase; status: "passed" | "failed"; detail: string };

export type ServiceHealth = {
  service: "opencodex";
  status: "ok";
  pid: number;
  port: number;
  hostname: string;
  coordinator: "ready";
  sourceCommit: string;
  buildCommit: string;
};

export type ServiceAcceptanceEvidence = {
  profile: ServiceClassProfile;
  status: "verified" | "failed" | "refused";
  sourceCommit?: string;
  buildCommit?: string;
  serviceId?: string;
  health?: Pick<ServiceHealth, "pid" | "port" | "hostname" | "coordinator">;
  phases: readonly PhaseResult[];
  reason?: string;
};

export type ServiceLifecycleAdapter = {
  install(): Promise<void> | void;
  start(): Promise<void> | void;
  probe(): Promise<ServiceHealth> | ServiceHealth;
  restart(): Promise<void> | void;
  stop(): Promise<void> | void;
  uninstall(): Promise<void> | void;
  verifyGone(): Promise<void> | void;
};

function parseProfile(value: string | undefined): ServiceClassProfile {
  if (!value || !(SERVICE_CLASS_PROFILES as readonly string[]).includes(value)) throw new Error(`profile must be one of ${SERVICE_CLASS_PROFILES.join(", ")}`);
  return value as ServiceClassProfile;
}

function exactCommit(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${name} must be a full 40-character commit SHA`);
  return value.toLowerCase();
}

function child(args: string[], timeoutMs: number): Promise<void> {
  const proc = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  return Promise.race([
    proc.exited.then(code => { if (code !== 0) throw new Error(`service command exited ${code}`); }),
    new Promise<never>((_, reject) => setTimeout(() => { try { proc.kill(); } catch { /* bounded teardown */ } reject(new Error("service command timed out")); }, timeoutMs)),
  ]);
}

function defaultAdapter(): ServiceLifecycleAdapter {
  const command = (action: string) => ["service", action, "--native"];
  return {
    install: () => child(command("install"), 30_000),
    start: () => child(command("start"), 30_000),
    probe: async () => {
      const port = Number(process.env.OCX_DISPOSABLE_HOST_PORT ?? "10100");
      const hostname = process.env.OCX_DISPOSABLE_HOSTNAME ?? "127.0.0.1";
      const response = await fetch(`http://${hostname}:${port}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`health probe returned ${response.status}`);
      const body = await response.json() as Partial<ServiceHealth>;
      if (body.service !== "opencodex" || body.status !== "ok" || !Number.isSafeInteger(body.pid) || !Number.isSafeInteger(body.port) || typeof body.hostname !== "string" || body.coordinator !== "ready") throw new Error("health probe was incomplete or fabricated");
      const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
      const sourceCommit = source.success ? new TextDecoder().decode(source.stdout).trim() : "";
      return { service: "opencodex", status: "ok", pid: body.pid, port: body.port, hostname: body.hostname, coordinator: "ready", sourceCommit: exactCommit(sourceCommit, "source commit"), buildCommit: exactCommit(typeof body.commit === "string" ? body.commit : undefined, "build commit") };
    },
    restart: () => child(command("restart"), 30_000),
    stop: () => child(command("stop"), 30_000),
    uninstall: () => child(command("uninstall"), 30_000),
    verifyGone: async () => {
      const port = Number(process.env.OCX_DISPOSABLE_HOST_PORT ?? "10100");
      const hostname = process.env.OCX_DISPOSABLE_HOSTNAME ?? "127.0.0.1";
      try { await fetch(`http://${hostname}:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }); throw new Error("health endpoint remained reachable after uninstall"); } catch (error) { if (error instanceof Error && /remained reachable/.test(error.message)) throw error; }
      const status = Bun.spawnSync(["sc.exe", "query", "opencodex"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
      if (status.success) throw new Error("service registration remained after uninstall");
    },
  };
}

function assertFreshDisposableHost(hostRoot: string): void {
  if (!existsSync(hostRoot) || !lstatSync(hostRoot).isDirectory()) throw new Error("disposable host root must be an existing directory");
  const attestationPath = resolve(hostRoot, "disposable-host-attestation.json");
  if (!existsSync(attestationPath)) throw new Error("disposable host attestation is required");
  const parsed = JSON.parse(readFileSync(attestationPath, "utf8")) as { expiresAt?: string; nonce?: string; hostId?: string; owner?: string };
  const owner = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!parsed.hostId || !parsed.nonce || !parsed.expiresAt || !parsed.owner || parsed.owner !== owner || Date.parse(parsed.expiresAt) <= Date.now()) throw new Error("disposable host attestation is stale, forged, or incomplete");
  unlinkSync(attestationPath);
}

export async function runServiceAcceptance(options: { profile: string | undefined; hostRoot: string | undefined; disposableHost: string | undefined; sourceCommit?: string; buildCommit?: string; adapter?: ServiceLifecycleAdapter }): Promise<ServiceAcceptanceEvidence> {
  const profile = parseProfile(options.profile);
  if (options.disposableHost !== "1") return { profile, status: "refused", phases: [], reason: "service-class acceptance requires OCX_DISPOSABLE_HOST_ACCEPTANCE=1" };
  if (!options.hostRoot || !isAbsolute(options.hostRoot)) throw new Error("OCX_DISPOSABLE_HOST_ROOT must be an absolute disposable-host path");
  const hostRoot = resolve(options.hostRoot);
  assertFreshDisposableHost(hostRoot);
  const sourceCommit = exactCommit(options.sourceCommit ?? process.env.OCX_ACCEPTANCE_SOURCE_COMMIT, "source commit");
  const buildCommit = exactCommit(options.buildCommit ?? process.env.OCX_ACCEPTANCE_BUILD_COMMIT, "build commit");
  const serviceId = `opencodex-${profile.toLowerCase()}`;
  const adapter = options.adapter ?? defaultAdapter();
  const phases: PhaseResult[] = [];
  let installed = false;
  let health: ServiceHealth | undefined;
  const run = async (phase: Phase, action: () => Promise<void> | void): Promise<void> => {
    try { await action(); phases.push({ phase, status: "passed", detail: "completed" }); }
    catch (error) { phases.push({ phase, status: "failed", detail: error instanceof Error ? error.message : "phase failed" }); throw error; }
  };
  try {
    await run("install", () => adapter.install()); installed = true;
    await run("start", () => adapter.start());
    await run("probe", async () => { health = await adapter.probe(); if (health.sourceCommit !== sourceCommit || health.buildCommit !== buildCommit) throw new Error("health evidence commit does not match requested source/build commit"); });
    await run("restart", () => adapter.restart());
    await run("probe", async () => { const restarted = await adapter.probe(); if (!health || restarted.pid === health.pid) throw new Error("restart did not produce a new live process identity"); health = restarted; });
    await run("stop", () => adapter.stop());
    await run("uninstall", () => adapter.uninstall()); installed = false;
    await run("probe", () => adapter.verifyGone());
    return { profile, status: "verified", sourceCommit, buildCommit, serviceId, health: health && { pid: health.pid, port: health.port, hostname: health.hostname, coordinator: health.coordinator }, phases };
  } catch (error) {
    if (installed) { try { await adapter.stop(); } catch { /* preserve original failure */ } try { await adapter.uninstall(); } catch { /* preserve original failure */ } }
    return { profile, status: "failed", sourceCommit, buildCommit, serviceId, health: health && { pid: health.pid, port: health.port, hostname: health.hostname, coordinator: health.coordinator }, phases, reason: error instanceof Error ? error.message : "service acceptance failed" };
  }
}

if (import.meta.main) {
  runServiceAcceptance({ profile: process.env.OCX_SERVICE_ACCEPTANCE_PROFILE, hostRoot: process.env.OCX_DISPOSABLE_HOST_ROOT, disposableHost: process.env.OCX_DISPOSABLE_HOST_ACCEPTANCE }).then(evidence => { console.log(JSON.stringify(evidence)); process.exitCode = evidence.status === "verified" ? 0 : evidence.status === "refused" ? 2 : 1; }).catch(error => { console.error(error instanceof Error ? error.message : "service acceptance failed"); process.exitCode = 1; });
}
