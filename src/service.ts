/**
 * `ocx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets OCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandUserPath, getConfigDir, readPid, removePid, removeRuntimePort } from "./config";
import { loadConfig } from "./config";
import { restoreNativeCodex } from "./codex/inject";
import { stripGrokConfig } from "./grok/inject";
import { isWslRuntime } from "./codex/home";
import { durableBunPath, durableBunRuntime } from "./lib/bun-runtime";
import { isProcessAlive, stopProxy } from "./lib/process-control";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "./lib/service-secrets";
import { randomUUID } from "node:crypto";
import {
  ELEVATION_REQUEST_TIMEOUT_MS,
  OCX_ELEVATED_PROTOCOL_FAILED,
  raceWithTimeout,
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSchtasksExe,
  startElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  toWindowsSchtasksError,
  WindowsElevationError,
  type ElevatedSchedulerOutcome,
  type ElevatedSchtasksCreateAndRunExecution,
  type ElevatedSchtasksCreateAndRunResult,
} from "./lib/windows-elevation";
import { buildWinswXml, defaultWinswEntry, installWinswService, startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswStatusSummary, winswXmlPath, WINSW_SERVICE_ID, WINSW_SHA256, WINSW_VERSION, type WinswStatus } from "./lib/winsw";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "./lib/win-paths";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { servicePinnedPort, serviceStartArgv } from "./lib/proxy-launch";
import { redactUserPath } from "./lib/redact";
import { waitForProxyIdentity, type ProxyReadinessOptions } from "./cli/proxy-readiness";
import { findLiveProxy, type LiveProxy } from "./server/proxy-liveness";
import { revertSystemEnv } from "./server/system-env";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

export type ServiceBackend = "scheduler" | "native";

function cliEntry(): { bun: string; cli: string } {
  // Bake the bundled Bun (npm global prefix, survives `ocx update`) rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
  return { bun: durableBunPath(), cli: join(import.meta.dir, "cli", "index.ts") };
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function serviceLogPath(): string {
  return logPath();
}

function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "opencodex-service.cmd");
}

function windowsLauncherVbsPath(): string {
  return join(getConfigDir(), "opencodex-service-launcher.vbs");
}

function windowsTaskXmlPath(): string {
  return join(getConfigDir(), "opencodex-service-task.xml");
}

function serviceStatePath(): string {
  return join(getConfigDir(), "service-state.json");
}

function defaultOpenCodexHome(): string {
  return resolve(join(homedir(), ".opencodex"));
}

function serviceStatePaths(): string[] {
  const paths = [serviceStatePath()];
  const defaultPath = join(defaultOpenCodexHome(), "service-state.json");
  if (normalizePathForCompare(defaultPath) !== normalizePathForCompare(paths[0])) paths.push(defaultPath);
  return paths;
}

function currentCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

function currentOpenCodexHome(): string {
  // getConfigDir() already resolves OPENCODEX_HOME with ~ expansion; keep the
  // install-state comparison on the same normalization or `~/...` values falsely
  // fail the environment-match check depending on cwd.
  return getConfigDir();
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface ServiceInstallState {
  version: 1 | 2;
  codexHome: string;
  opencodexHome: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath?: string;
  cliPath?: string;
  /** v2: which Windows backend was chosen at install; absent (v1/legacy) means scheduler. */
  backend?: ServiceBackend;
  winswVersion?: string;
  winswSha256?: string;
}

export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 && state.version !== 2) return null;
  if (typeof state.codexHome !== "string" || state.codexHome.length === 0) return null;
  if (typeof state.opencodexHome !== "string" || state.opencodexHome.length === 0) return null;
  for (const key of ["bunPath", "cliPath", "winswVersion", "winswSha256"] as const) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || state[key].length === 0)) return null;
  }
  if (state.version === 1) {
    if (state.backend !== undefined) return null;
  } else if (state.backend !== "scheduler" && state.backend !== "native") {
    return null;
  }
  return state as unknown as ServiceInstallState;
}

function writeServiceInstallState(backend: ServiceBackend = "scheduler"): void {
  const { bun, cli } = cliEntry();
  const state: ServiceInstallState = {
    version: 2,
    codexHome: currentCodexHome(),
    opencodexHome: currentOpenCodexHome(),
    bunPath: bun,
    cliPath: cli,
    backend,
    ...(backend === "native" ? { winswVersion: WINSW_VERSION, winswSha256: WINSW_SHA256 } : {}),
  };
  for (const path of serviceStatePaths()) {
    const dir = dirname(path);
    recordOwnedConfigPath(getConfigDir(), path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
  }
}

function readServiceInstallState(): ServiceInstallState | null {
  for (const path of serviceStatePaths()) {
    try {
      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* try the next known state path */
    }
  }
  return null;
}

/** Single accessor for update/reinstall code — v1/legacy state maps to scheduler. */
export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/** The `ocx` argv that reinstalls the currently-chosen service backend (update paths). */
export function serviceReinstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
}

/**
 * The service was installed under a different CODEX_HOME/OPENCODEX_HOME, so this process may not
 * touch it. Distinct from "stop failed": the manager was never even contacted, which means the
 * installed service is still live and shared state (native Codex config, the Grok fence) must be
 * left alone — tearing it down would strip config out from under a running service.
 */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}

export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}

/**
 * True when no installed service exists, or the installed one belongs to THIS
 * CODEX_HOME/OPENCODEX_HOME. Callers use it to decide whether they may tear down shared state
 * (native Codex config, the Grok fence) that a foreign service would still be relying on.
 */
export function serviceEnvironmentOwnedHere(): boolean {
  try {
    assertServiceEnvironmentMatchesInstall();
    return true;
  } catch (err) {
    if (isServiceOwnershipError(err)) return false;
    return true; // unrelated failure: fall back to the previous behavior rather than wedging
  }
}

export function assertServiceEnvironmentMatchesInstall(): void {
  const state = readServiceInstallState();
  if (!state) return;
  const expected = normalizePathForCompare(state.codexHome);
  const actual = normalizePathForCompare(currentCodexHome());
  if (expected !== actual) {
    throw new ServiceOwnershipError(
      `Service was installed with CODEX_HOME=${state.codexHome}, but current CODEX_HOME=${currentCodexHome()}. ` +
        "Run the service command from the same Codex home so native Codex restore updates the correct config.",
    );
  }
  const expectedOpenCodexHome = normalizePathForCompare(state.opencodexHome);
  const actualOpenCodexHome = normalizePathForCompare(currentOpenCodexHome());
  if (expectedOpenCodexHome !== actualOpenCodexHome) {
    throw new ServiceOwnershipError(
      `Service was installed with OPENCODEX_HOME=${state.opencodexHome}, but current OPENCODEX_HOME=${currentOpenCodexHome()}. ` +
        "Run the service command from the same OpenCodex home so service state and secrets match.",
    );
  }
}

function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function assertServiceAuthEnvironment(): void {
  const config = loadConfig();
  if (isLoopbackHostname(config.hostname)) return;
  if (process.env.OPENCODEX_API_AUTH_TOKEN?.trim()) return;
  const persisted = serviceApiTokenFilePath();
  try {
    // The file is written with owner-only permissions and Windows ACL hardening by
    // writeServiceApiTokenFile. Re-validate that boundary before trusting a token
    // left by an earlier installation when the current shell has no token.
    const hardened = hardenSecretPath(persisted, { required: true });
    if (hardened.ok && loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: persisted })) return;
  } catch {
    // Fall through to the same actionable refusal without exposing token material.
  }
  throw new Error(
    "OPENCODEX_API_AUTH_TOKEN or a validated persisted service token is required before installing a service for non-loopback hostname. " +
      "Set it in the same shell, or repair the persisted service token, then rerun `ocx service install`.",
  );
}

function writeServiceApiTokenFile(): string | null {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (!token) return null;
  const path = serviceApiTokenFilePath();
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
  return path;
}

export function buildPlist(pinnedPort?: number | null): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = process.env.CODEX_HOME?.trim();
  const opencodexHome = process.env.OPENCODEX_HOME?.trim();
  const envLines = [
    `    <key>OCX_SERVICE</key><string>1</string>`,
    `    <key>PATH</key><string>${plistString(path)}</string>`,
    codexHome ? `    <key>CODEX_HOME</key><string>${plistString(codexHome)}</string>` : null,
    opencodexHome ? `    <key>OPENCODEX_HOME</key><string>${plistString(opencodexHome)}</string>` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
  const command = buildServiceShellCommand(bun, cli, pinnedPort);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${plistString(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key><string>${plistString(log)}</string>
  <key>StandardErrorPath</key><string>${plistString(log)}</string>
</dict>
</plist>
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Normal service starts are soft; only update's OCX_BAKE_PORT (or an override) pins. */
export function resolveServiceListenPort(override?: number | null): number | undefined {
  return servicePinnedPort({ pinnedPort: override });
}

function buildServiceShellCommand(bun: string, cli: string, pinnedPort?: number | null): string {
  const tokenFile = serviceApiTokenFilePath();
  const start = serviceStartArgv(cli, { pinnedPort }).map(shellQuote).join(" ");
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${start}`;
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function systemdEnvironmentAssignment(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

function systemdOutputTarget(value: string): string {
  // StandardOutput/StandardError use output specifiers such as append:/path.
  // Quoting the full specifier makes systemd reject it as an invalid output target.
  return value.replace(/%/g, "%%").replace(/\n/g, "\\n");
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runFile(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function windowsSchtasks(): string {
  return resolveTrustedWindowsSchtasksExe();
}

function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
}

export type WindowsSchedulerRuntimeState = "running" | "not-running" | "unknown";

/**
 * Task Scheduler's COM API exposes TASK_STATE as a locale-independent integer:
 * 4 is running; disabled, queued, and ready are installed but not running.
 */
export function parseWindowsSchedulerRuntimeState(raw: string): WindowsSchedulerRuntimeState {
  const state = raw.trim();
  if (state === "4") return "running";
  if (state === "1" || state === "2" || state === "3") return "not-running";
  return "unknown";
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Query the scheduler itself; an unrelated healthy direct proxy is not service evidence. */
function windowsSchedulerRuntimeState(taskName = TASK): WindowsSchedulerRuntimeState {
  if (querySchedulerRuntimeForTests) {
    return parseWindowsSchedulerRuntimeState(querySchedulerRuntimeForTests());
  }
  if (process.platform !== "win32") return "unknown";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$scheduler = New-Object -ComObject 'Schedule.Service'",
    "$scheduler.Connect()",
    `$task = $scheduler.GetFolder('\\').GetTask(${powershellSingleQuoted(taskName)})`,
    "[Console]::Out.Write([int]$task.State)",
  ].join("; ");
  try {
    const raw = runFile(resolveTrustedWindowsPowerShellExe(), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return parseWindowsSchedulerRuntimeState(raw);
  } catch {
    return "unknown";
  }
}

let querySchtasksForTests: ((args: string[]) => string) | null = null;
let querySchedulerRuntimeForTests: (() => string) | null = null;

function querySchtasks(args: string[]): string {
  if (querySchtasksForTests) return querySchtasksForTests(args);
  return runFile(windowsSchtasks(), args);
}

/** Test-only seam for Task Scheduler query used by presence probes. */
export function setQuerySchtasksForTests(next: ((args: string[]) => string) | null): void {
  querySchtasksForTests = next;
}

/** Test-only seam for the locale-independent Task Scheduler COM state query. */
export function setQueryWindowsSchedulerRuntimeForTests(next: (() => string) | null): void {
  querySchedulerRuntimeForTests = next;
}

function schtasks(args: string[]): string {
  try {
    return querySchtasks(args);
  } catch (error) {
    throw toWindowsSchtasksError(error, args);
  }
}

/** Tri-state Task Scheduler presence: never treat a failed query as proven absence. */
export type WindowsSchedulerTaskProbe =
  | { status: "present" }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

function schtasksErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a schtasks CSV listing line refers to the given task name. */
export function windowsSchedulerCsvIncludesTask(csv: string, taskName: string): boolean {
  const needle = taskName.toLowerCase();
  for (const line of csv.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes(needle)) continue;
    // Prefer exact CSV field matches ("\TaskName" / "TaskName") before a substring hit.
    if (
      lower.includes(`"\\${needle}"`)
      || lower.includes(`"${needle}"`)
      || new RegExp(`(^|[,\\\\])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([,"]|$)`).test(lower)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Probe whether the OpenCodex Task Scheduler task exists.
 * Query failures fall back to a CSV listing before concluding absence; if both
 * fail, returns `unknown` so callers can fail closed instead of releasing locks.
 */
export function probeWindowsSchedulerTask(taskName = TASK): WindowsSchedulerTaskProbe {
  if (process.platform !== "win32") return { status: "absent" };

  let queryFailure: string | null = null;
  try {
    const out = querySchtasks(["/query", "/tn", taskName]);
    if (out.includes(taskName)) return { status: "present" };
  } catch (error) {
    queryFailure = schtasksErrorDetail(error);
  }

  try {
    const csv = querySchtasks(["/query", "/fo", "CSV"]);
    if (windowsSchedulerCsvIncludesTask(csv, taskName)) return { status: "present" };
    return { status: "absent" };
  } catch (error) {
    const listDetail = schtasksErrorDetail(error);
    const detail = queryFailure
      ? `Specific query failed (${queryFailure}); CSV listing also failed (${listDetail}).`
      : `Task query did not confirm presence and CSV listing failed (${listDetail}).`;
    return { status: "unknown", detail };
  }
}

/**
 * Backend switches are destructive and must distinguish proven absence from an
 * unavailable scheduler. Returning false is therefore reserved for a successful
 * query that proved the task absent; an indeterminate query aborts the switch.
 */
export function requireKnownWindowsSchedulerTaskState(
  taskName = TASK,
  action = "change the Windows service backend",
): "present" | "absent" {
  const probe = probeWindowsSchedulerTask(taskName);
  if (probe.status === "unknown") {
    throw new Error(`Task Scheduler state is unknown; refusing to ${action}. ${probe.detail}`);
  }
  return probe.status;
}

/** True when the Task Scheduler registration for the default proxy task is proven present. */
export function windowsSchedulerTaskInstalled(taskName = TASK): boolean {
  return probeWindowsSchedulerTask(taskName).status === "present";
}

export type WindowsSchedulerXmlProbe =
  | { status: "present"; xml: string }
  | { status: "absent"; xml: "" }
  | { status: "unknown"; xml: ""; detail: string };

/**
 * Read registration XML without collapsing query/access failures into absence.
 * A secondary presence probe may prove absence, but cannot manufacture XML when
 * the task is known present and the XML query itself failed.
 */
export function probeWindowsSchedulerXml(taskName = TASK): WindowsSchedulerXmlProbe {
  try {
    const xml = querySchtasks(["/query", "/tn", taskName, "/xml"]);
    if (xml.trim()) return { status: "present", xml };
    return { status: "unknown", xml: "", detail: "Task Scheduler returned empty registration XML." };
  } catch (error) {
    const xmlError = schtasksErrorDetail(error);
    const presence = probeWindowsSchedulerTask(taskName);
    if (presence.status === "absent") return { status: "absent", xml: "" };
    if (presence.status === "present") {
      return {
        status: "unknown",
        xml: "",
        detail: `Task exists, but registration XML could not be read (${xmlError}).`,
      };
    }
    return {
      status: "unknown",
      xml: "",
      detail: `${presence.detail} XML query also failed (${xmlError}).`,
    };
  }
}

export interface WindowsSchedulerInstallVerification {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  assetsHealthy: boolean;
  nativeServiceAbsent: boolean;
  /** True when SCM probe failed; not a proven WinSW presence. */
  nativeStatusUnknown: boolean;
  conflict: boolean;
  ok: boolean;
  detail: string;
}

/** Pure postcondition evaluation for an elevated scheduler install. */
export function evaluateWindowsSchedulerInstallVerification(inputs: {
  taskInstalled: boolean;
  xml: string;
  assetsExist: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  wscript?: string;
  launcher?: string;
}): WindowsSchedulerInstallVerification {
  const registrationHealthy = inputs.xml.length > 0
    && windowsTaskRegistrationHealthy(inputs.xml, inputs.wscript, inputs.launcher);
  const assetsHealthy = inputs.assetsExist;
  const nativeServiceAbsent = inputs.nativeStatus === "nonexistent";
  const nativeStatusUnknown = inputs.nativeStatus === "unknown";
  // Only treat proven WinSW presence as a backend conflict — never "unknown".
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const ok = inputs.taskInstalled && registrationHealthy && assetsHealthy && nativeServiceAbsent && !conflict;
  const detail = !inputs.taskInstalled
    ? "Task Scheduler task is not installed."
    : conflict
      ? `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`
      : !assetsHealthy
        ? "Required scheduler service assets are missing."
        : !registrationHealthy
          ? "Task Scheduler registration is present but unhealthy."
          : nativeStatusUnknown
            ? "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent."
            : "ok";
  return {
    taskInstalled: inputs.taskInstalled,
    registrationHealthy,
    assetsHealthy,
    nativeServiceAbsent,
    nativeStatusUnknown,
    conflict,
    ok,
    detail,
  };
}

/** Conflict-free postcondition check for an elevated scheduler install. */
export function verifyWindowsSchedulerInstall(taskName = TASK): WindowsSchedulerInstallVerification {
  const taskInstalled = windowsSchedulerTaskInstalled(taskName);
  const xml = taskInstalled ? (() => {
    try { return querySchtasks(["/query", "/tn", taskName, "/xml"]); } catch { return ""; }
  })() : "";
  return evaluateWindowsSchedulerInstallVerification({
    taskInstalled,
    xml,
    assetsExist: [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()].every(existsSync),
    nativeStatus: statusWinswRaw(),
  });
}

async function elevateSchtasks(args: string[]): Promise<void> {
  const exitCode = await runWindowsElevated(windowsSchtasks(), args);
  if (exitCode !== 0) {
    throw new Error(`Background service install failed with exit code ${exitCode}.`);
  }
}

async function rollbackElevatedSchedulerTask(taskName = TASK): Promise<string | null> {
  try {
    await elevateSchtasks(["/delete", "/tn", taskName, "/f"]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const probe = resolveWindowsSchedulerTaskProbe(taskName);
  if (probe.status === "absent") return null;
  if (probe.status === "unknown") {
    return `Task Scheduler task ${taskName} presence could not be verified after rollback: ${probe.detail}`;
  }
  return `Task Scheduler task ${taskName} is still present after rollback.`;
}

type ElevateCreateAndRunStart = (
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
) => ElevatedSchtasksCreateAndRunExecution;

type FinalizeHooks = {
  startElevateCreateAndRun?: ElevateCreateAndRunStart;
  /** Legacy sync hook used by older tests — wraps a resolved result as an execution. */
  elevateCreateAndRun?: (
    schtasksPath: string,
    createArgs: string[],
    runArgs: string[],
    deleteArgs: string[],
  ) => Promise<ElevatedSchtasksCreateAndRunResult>;
  verify?: () => WindowsSchedulerInstallVerification;
  writeInstallState?: () => void;
  /** Preferred tri-state probe for security-sensitive reconciliation. */
  probeTask?: () => WindowsSchedulerTaskProbe;
  /** Legacy boolean hook; mapped to present/absent when probeTask is unset. */
  taskInstalled?: () => boolean;
  /** Defense-in-depth: late reconciliation must still own this attempt. */
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
};

let finalizeHooks: FinalizeHooks | null = null;

function resolveWindowsSchedulerTaskProbe(taskName = TASK): WindowsSchedulerTaskProbe {
  if (finalizeHooks?.probeTask) return finalizeHooks.probeTask();
  if (finalizeHooks?.taskInstalled) {
    return finalizeHooks.taskInstalled() ? { status: "present" } : { status: "absent" };
  }
  return probeWindowsSchedulerTask(taskName);
}

/** Test-only hooks for elevated create+run finalization. */
export function setFinalizeWindowsSchedulerHooksForTests(hooks: FinalizeHooks | null): void {
  finalizeHooks = hooks;
}

function throwPartialInstall(parts: string[]): never {
  throw new Error(parts.filter(Boolean).join(" "));
}

/**
 * Reconcile an unrecognized elevated exit when we cannot trust the phase code.
 * Never invent a create-vs-run classification; inspect actual task state first.
 * An unverifiable probe must fail closed (partial / blocked), never release.
 */
async function reconcileUnknownElevatedOutcome(exitCode: number): Promise<void> {
  const probe = resolveWindowsSchedulerTaskProbe();
  const parts = [
    "The elevated Task Scheduler operation returned an unknown result.",
    `Exit code: ${exitCode}.`,
    "OpenCodex could not prove whether task creation completed, so installation state was not written.",
  ];
  if (probe.status === "unknown") {
    parts.push(`Task Scheduler presence could not be verified: ${probe.detail}`);
    parts.push("A partial Task Scheduler backend may remain.");
    throwPartialInstall(parts);
  }
  if (probe.status === "absent") {
    parts.push("No OpenCodex Task Scheduler task was found after the elevated operation.");
    throwPartialInstall(parts);
  }
  parts.push("A Task Scheduler task is present; attempting cleanup.");
  const rollbackError = await rollbackElevatedSchedulerTask();
  if (rollbackError) {
    parts.push(`Cleanup also failed: ${rollbackError}`);
    parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if it remains.`);
  } else {
    parts.push("The elevated Task Scheduler task was removed.");
  }
  throwPartialInstall(parts);
}

type ApplyElevatedOptions = {
  attemptId: string;
  writeOnSuccess: boolean;
  stillOwnsAttempt?: (attemptId: string) => boolean;
};

function attemptStillOwned(options: ApplyElevatedOptions): boolean {
  const check = options.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  return !check || check(options.attemptId);
}

async function applyElevatedSchedulerResult(
  result: ElevatedSchtasksCreateAndRunResult,
  options: ApplyElevatedOptions,
): Promise<void> {
  if (!attemptStillOwned(options)) {
    return;
  }
  const outcome: ElevatedSchedulerOutcome = result.outcome;

  if (outcome === "create-failed") {
    throw new Error("Elevated schtasks /create failed. The Task Scheduler task was not registered.");
  }
  if (outcome === "run-failed-rolled-back") {
    throw new Error(
      "Elevated schtasks /run failed after the task was registered. The elevated process rolled the task back. Installation state was not written.",
    );
  }
  if (outcome === "run-failed-rollback-failed") {
    throwPartialInstall([
      "Elevated schtasks /run failed after the task was registered, and elevated rollback also failed.",
      "A partial Task Scheduler backend may remain.",
      `Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if present.`,
      "Installation state was not written.",
    ]);
  }
  if (outcome !== "success") {
    await reconcileUnknownElevatedOutcome(result.exitCode);
  }

  const verification = (finalizeHooks?.verify ?? verifyWindowsSchedulerInstall)();
  if (!verification.ok) {
    // Preserve a healthy elevated task when WinSW absence cannot be proven (unknown SCM status).
    // Unknown is not a confirmed dual-backend conflict; install state is still withheld.
    const preserveElevatedTask = verification.taskInstalled
      && verification.registrationHealthy
      && verification.assetsHealthy
      && !verification.conflict
      && verification.nativeStatusUnknown;
    if (preserveElevatedTask) {
      throwPartialInstall([
        "Elevated Task Scheduler registration did not produce a conflict-free install.",
        verification.detail,
        "The elevated Task Scheduler task was left in place because native WinSW status could not be verified.",
        "Installation state was not written.",
      ]);
    }
    const rollbackError = await rollbackElevatedSchedulerTask();
    const parts = [
      "Elevated Task Scheduler registration did not produce a conflict-free install.",
      verification.detail,
    ];
    if (rollbackError) {
      parts.push(`Rollback also failed: ${rollbackError}`);
      parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' and the native service with 'sc delete ${WINSW_SERVICE_ID}' if present.`);
    } else {
      parts.push("The elevated Task Scheduler task was rolled back.");
    }
    parts.push("Installation state was not written.");
    throwPartialInstall(parts);
  }
  if (options.writeOnSuccess) {
    if (!attemptStillOwned(options)) {
      return;
    }
    (finalizeHooks?.writeInstallState ?? (() => writeServiceInstallState("scheduler")))();
  }
}

/** Outcome of late reconciliation after a request-level elevation timeout. */
export type ElevatedReconciliationOutcome =
  | "released"
  | "blocked-partial";

export type FinalizeWindowsSchedulerResult =
  | { kind: "done" }
  | {
      kind: "indeterminate";
      attemptId: string;
      /** Settles after the elevated transaction finishes and late reconciliation runs. */
      reconciliation: Promise<ElevatedReconciliationOutcome>;
    };

export type FinalizeWindowsSchedulerOptions = {
  attemptId?: string;
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
};

function startElevateExecution(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): ElevatedSchtasksCreateAndRunExecution {
  if (finalizeHooks?.startElevateCreateAndRun) {
    return finalizeHooks.startElevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
  }
  if (finalizeHooks?.elevateCreateAndRun) {
    const completion = finalizeHooks.elevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
    return { completion, launcherPid: null };
  }
  return startElevatedSchtasksCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
}

function isPartialInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /partial Task Scheduler/i.test(error.message)
    || /Cleanup also failed/i.test(error.message)
    || /left in place because native WinSW status could not be verified/i.test(error.message)
    || /Task Scheduler presence could not be verified/i.test(error.message);
}

/**
 * Re-register the scheduler task with elevation after a non-elevated install wrote assets.
 *
 * Request timeout does not kill the elevated launcher. On timeout this returns
 * `indeterminate` and keeps reconciling the eventual protocol result.
 */
export async function finalizeWindowsSchedulerServiceRegistration(
  script = windowsServiceScriptPath(),
  options?: FinalizeWindowsSchedulerOptions,
): Promise<FinalizeWindowsSchedulerResult> {
  if (process.platform !== "win32") {
    throw new Error("Windows scheduler registration is only supported on Windows.");
  }
  const attemptId = options?.attemptId ?? randomUUID();
  const stillOwnsAttempt = options?.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  const createArgs = buildWindowsSchtasksCreateArgs(script);
  const runArgs = ["/run", "/tn", TASK];
  const deleteArgs = ["/delete", "/tn", TASK, "/f"];
  const started = startElevateExecution(windowsSchtasks(), createArgs, runArgs, deleteArgs);
  const timeoutMs = options?.requestTimeoutMs
    ?? finalizeHooks?.requestTimeoutMs
    ?? ELEVATION_REQUEST_TIMEOUT_MS;
  const applyOpts: ApplyElevatedOptions = { attemptId, writeOnSuccess: true, stillOwnsAttempt };

  let raced: { status: "completed"; value: ElevatedSchtasksCreateAndRunResult } | { status: "timed-out" };
  try {
    raced = await raceWithTimeout(started.completion, timeoutMs);
  } catch (error) {
    // Cancellation / launch failure / signal before or instead of a protocol result.
    // Signal after Start-Process may leave an elevated child; reconcile conservatively.
    if (error instanceof WindowsElevationError && error.reason === "terminated") {
      try {
        await reconcileUnknownElevatedOutcome(OCX_ELEVATED_PROTOCOL_FAILED);
      } catch (reconcileError) {
        // Prefer the reconciliation detail (partial install / cleanup guidance) over the
        // generic signal message so callers can block retries when a task remains.
        throw reconcileError;
      }
    }
    throw error;
  }

  if (raced.status === "completed") {
    await applyElevatedSchedulerResult(raced.value, applyOpts);
    return { kind: "done" };
  }

  const reconciliation = (async (): Promise<ElevatedReconciliationOutcome> => {
    try {
      const result = await started.completion;
      await applyElevatedSchedulerResult(result, applyOpts);
      return "released";
    } catch (error) {
      if (error instanceof WindowsElevationError && error.reason === "cancelled") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "launch-failed") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "terminated") {
        try {
          await reconcileUnknownElevatedOutcome(OCX_ELEVATED_PROTOCOL_FAILED);
          return "released";
        } catch (reconcileError) {
          return isPartialInstallError(reconcileError) ? "blocked-partial" : "released";
        }
      }
      // applyElevatedSchedulerResult failures are expected (create/run/conflict); swallow for background.
      if (isPartialInstallError(error)) {
        return "blocked-partial";
      }
      return "released";
    }
  })();

  return { kind: "indeterminate", attemptId, reconciliation };
}

/**
 * Pure post-restart / pre-install advisory check. Does not mutate state.
 * A process-local indeterminate lock cannot survive restart — callers must inspect reality.
 */
export function evaluateSchedulerInstallRestartReconciliation(inputs: {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  assetsHealthy: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  installStateBackend: "scheduler" | "native" | null;
}): {
  status: "healthy" | "orphan-task" | "stale-install-state" | "conflict" | "unhealthy" | "unverified";
  detail: string;
} {
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  if (conflict) {
    return {
      status: "conflict",
      detail: `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`,
    };
  }
  if (inputs.taskInstalled && inputs.nativeStatus === "unknown") {
    return {
      status: "unverified",
      detail: "The Task Scheduler task exists, but native WinSW status could not be verified.",
    };
  }
  if (inputs.taskInstalled && (!inputs.registrationHealthy || !inputs.assetsHealthy)) {
    return {
      status: "unhealthy",
      detail: !inputs.assetsHealthy
        ? "Required scheduler service assets are missing."
        : "Task Scheduler registration is present but unhealthy.",
    };
  }
  if (inputs.taskInstalled && inputs.installStateBackend !== "scheduler") {
    return {
      status: "orphan-task",
      detail: "A Task Scheduler task is present without matching scheduler install state.",
    };
  }
  if (!inputs.taskInstalled && inputs.installStateBackend === "scheduler") {
    return {
      status: "stale-install-state",
      detail: "Scheduler install state is present but the Task Scheduler task is absent.",
    };
  }
  return { status: "healthy", detail: "ok" };
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

type WindowsBatchValueKind = "raw" | "path" | "pathList";

function windowsBatchSet(name: string, value: string | undefined, kind: WindowsBatchValueKind = "raw"): string | null {
  if (!value) return null;
  const rendered =
    kind === "path" ? windowsEnvIndirectBatchValue(value, windowsBatchValue)
    : kind === "pathList" ? windowsEnvIndirectBatchPathList(value, windowsBatchValue)
    : windowsBatchValue(value);
  return `set "${name}=${rendered}"`;
}

function taskXmlString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildWindowsServiceScript(entry = cliEntry(), pinnedPort?: number | null): string {
  const { bun, cli } = entry;
  const bunRuntime = durableBunRuntime();
  const path = process.env.PATH ?? "";
  const port = resolveServiceListenPort(pinnedPort);
  const startArgs = port === undefined ? "start" : `start --port ${port}`;
  const lines = [
    "@echo off",
    "setlocal",
    // The wrapper console is hidden by the wscript launcher (window style 0), so switching
    // it to UTF-8 is safe (no leak into user shells) and lets cmd parse UTF-8 remnants.
    "chcp 65001 >nul",
    windowsBatchSet("OCX_SERVICE", "1"),
    windowsBatchSet("PATH", path, "pathList"),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim(), "path"),
    windowsBatchSet("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim(), "path"),
    windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath(), "path"),
    windowsBatchSet("OCX_SERVICE_LOG", serviceLogPath(), "path"),
    windowsBatchSet("OCX_BUN", bun, "path"),
    windowsBatchSet("OCX_CLI", cli, "path"),
    'if exist "%OCX_API_TOKEN_FILE%" (',
    '  set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"',
    ")",
    ":loop",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] opencodex service wrapper start',
    '>>"%OCX_SERVICE_LOG%" echo bun="%OCX_BUN%"',
    `>>"%OCX_SERVICE_LOG%" echo bun_source="${bunRuntime.source}"`,
    '>>"%OCX_SERVICE_LOG%" echo cli="%OCX_CLI%"',
    '>>"%OCX_SERVICE_LOG%" echo opencodex_home="%OPENCODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo token_file="%OCX_API_TOKEN_FILE%"',
    `"%OCX_BUN%" "%OCX_CLI%" ${startArgs} >>"%OCX_SERVICE_LOG%" 2>&1`,
    "if %ERRORLEVEL% NEQ 0 (",
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s',
    // `timeout` needs console stdin and dies with "Input redirection is not supported"
    // under Task Scheduler, turning the 5s cooldown into a hot restart loop; ping doesn't.
    "  ping -n 6 127.0.0.1 >nul",
    "  goto loop",
    ")",
    "endlocal",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsSchtasksCreateArgs(script = windowsServiceScriptPath()): string[] {
  const xml = script === windowsServiceScriptPath() ? windowsTaskXmlPath() : `${script}.xml`;
  return ["/create", "/tn", TASK, "/xml", xml, "/f"];
}

/**
 * VBS launcher that starts the batch wrapper with a hidden window (style 0).
 * bWaitOnReturn=True keeps wscript.exe resident for the wrapper's lifetime so the
 * scheduled task stays "running": MultipleInstancesPolicy=IgnoreNew keeps preventing
 * duplicates and `schtasks /end` still has a live task instance to stop. Without the
 * launcher, the console batch action shows a closable cmd window in the interactive
 * session (issue #165). VBS string literals escape `"` as `""`.
 */
export function buildWindowsLauncherVbs(script = windowsServiceScriptPath()): string {
  const escaped = script.replace(/"/g, '""');
  const lines = [
    "' OpenCodex service launcher — runs the batch wrapper with a hidden window.",
    "' Generated by `ocx service install`; do not edit.",
    'Set shell = CreateObject("WScript.Shell")',
    // WshShell.Run(command, windowStyle 0 = hidden, bWaitOnReturn True = stay resident).
    `shell.Run """${escaped}""", 0, True`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsTaskXml(script = windowsServiceScriptPath(), launcher = windowsLauncherVbsPath()): string {
  const escapedWscript = taskXmlString(windowsWscript());
  // Escape the launcher path independently for the <Arguments> element; quoting it
  // keeps spaces intact, and /b (batch mode) suppresses script error popups.
  const escapedLauncherArgs = taskXmlString(`/b /nologo "${launcher}"`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OpenCodex proxy service wrapper</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedWscript}</Command>
      <Arguments>${escapedLauncherArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}

/** Drop comments and CDATA so a commented-out decoy cannot satisfy any check. */
function taskXmlWithoutCommentsAndCdata(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
}

/**
 * Count occurrences of an unprefixed tag, including the self-closing form. The
 * element boundary matters: `<EnabledExtra>` must not count as `Enabled`.
 */
function taskXmlElementCount(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*?)?\\s*\\/?>`, "gi"))?.length ?? 0;
}

/**
 * True when a namespace-prefixed form of the tag appears. A prefixed element bound
 * to the task namespace carries a real value, but this module parses by regex and
 * cannot resolve prefixes — so it fails closed instead of reading the element as
 * absent (which would silently apply the schema default).
 */
function taskXmlHasPrefixedTag(xml: string, tag: string): boolean {
  return new RegExp(`<[A-Za-z_][\\w.-]*:${tag}(?:[\\s/>])`, "i").test(xml);
}

/**
 * Decode XML's five predefined entities, exactly once.
 *
 * Task Scheduler re-encodes element text when it exports a task, so a needle we
 * escaped ourselves can never match its output (#608). Compare decoded values
 * instead of encoded ones.
 *
 * The single pass is the point: decoding twice would turn `&amp;quot;` into `"`,
 * letting a doubly-encoded value impersonate the expected launcher path.
 */
function taskXmlDecodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => (
    name === "amp" ? "&"
      : name === "lt" ? "<"
        : name === "gt" ? ">"
          : name === "quot" ? "\""
            : "'"
  ));
}

/**
 * Exactly one unprefixed `<tag>` whose DECODED text equals `expected`.
 *
 * Unlike taskXmlOptionalValueEquals(), an absent element is NOT a pass: these
 * elements name what actually gets executed, so a missing <Command>/<Arguments>
 * must fail the health check rather than inherit a schema default.
 */
function taskXmlDecodedValueEquals(xml: string, tag: string, expected: string): boolean {
  // Same reasoning as the optional helper: `<t:Arguments>` must not read as absent.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  if (taskXmlElementCount(xml, tag) !== 1) return false;
  // `[^<]*` refuses nested markup, so a decoy inside a child element cannot match.
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>([^<]*)<\\/${tag}>`, "i").exec(xml)?.[1];
  if (value === undefined) return false;
  return taskXmlDecodeEntities(value).trim() === expected.trim();
}

/**
 * Decode XML's five predefined entities, exactly once.
 *
 * Task Scheduler re-encodes element text when it exports a task, so a needle we
 * escaped ourselves can never match its output (#608). Compare decoded values
 * instead of encoded ones.
 *
 * The single pass is the point: decoding twice would turn `&amp;quot;` into `"`,
 * letting a doubly-encoded value impersonate the expected launcher path.
 */
/**
 * Exactly one unprefixed `<tag>` whose DECODED text equals `expected`.
 *
 * Unlike taskXmlOptionalValueEquals(), an absent element is NOT a pass: these
 * elements name what actually gets executed, so a missing <Command>/<Arguments>
 * must fail the health check rather than inherit a schema default.
 */
function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean {
  // Check the prefixed form first: treating `<t:Enabled>false</t:Enabled>` as an
  // omission would turn an explicitly disabled task into a healthy one.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  const count = taskXmlElementCount(xml, tag);
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/${tag}>`, "i").exec(xml)?.[1];
  return value?.trim().toLowerCase() === expected.toLowerCase();
}

/** Validate the security/lifecycle-critical fields of the registered scheduler task. */
export function windowsTaskRegistrationHealthy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
): boolean {
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  // taskXmlSection() takes the FIRST match and the schema allows arbitrary XML under
  // Task/Data, so a Data block placed before the real sections could shadow them.
  // We never emit Data, so its presence alone disqualifies the registration. Both
  // forms are rejected because taskXmlElementCount() ignores prefixed tags.
  if (taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data")) return false;
  const triggers = taskXmlSection(scrubbed, "Triggers");
  const trigger = taskXmlSection(triggers, "LogonTrigger");
  const principal = taskXmlSection(scrubbed, "Principal");
  const settings = taskXmlSection(scrubbed, "Settings");
  const action = taskXmlSection(scrubbed, "Exec");
  // A self-closing <LogonTrigger /> leaves an empty section, so look for the element
  // itself — scoped to <Triggers> so a decoy elsewhere cannot satisfy it.
  return taskXmlElementCount(triggers, "LogonTrigger") > 0
    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && taskXmlOptionalValueEquals(principal, "RunLevel", "LeastPrivilege")
    && taskXmlOptionalValueEquals(settings, "Enabled", "true")
    && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
    && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
    // Compare decoded VALUES, not encodings: Task Scheduler canonicalizes the
    // quotes we wrote as `&quot;` back to literal `"` on export, so an escaped
    // needle never matched and a healthy task read as permanently stale (#608).
    && taskXmlDecodedValueEquals(action, "Command", wscript)
    && taskXmlDecodedValueEquals(action, "Arguments", `/b /nologo "${launcher}"`);
}

export interface WindowsSchedulerXmlState {
  installed: boolean;
  enabled: boolean;
  registrationHealthy: boolean;
}

/**
 * Single source of truth for reading a registered task's XML. Both the status
 * diagnostic and its tests go through here, so a partial fix cannot leave one
 * caller on an older, stricter reading of the same document (#432).
 */
export function readWindowsSchedulerXmlState(
  xml: string,
  wscript?: string,
  launcher?: string,
): WindowsSchedulerXmlState {
  const installed = xml.length > 0;
  if (!installed) return { installed: false, enabled: false, registrationHealthy: false };
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  const hasData = taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data");
  const settings = hasData ? "" : taskXmlSection(scrubbed, "Settings");
  return {
    installed: true,
    enabled: !hasData && taskXmlOptionalValueEquals(settings, "Enabled", "true"),
    registrationHealthy: windowsTaskRegistrationHealthy(xml, wscript, launcher),
  };
}

// ── macOS (launchd) ──
function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  const p = plistPath();
  writeFileSync(p, buildPlist(), "utf8");
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  sh(`launchctl load -w "${p}"`);
  writeServiceInstallState();
}
function startLaunchd(): void { sh(`launchctl load -w "${plistPath()}"`); }
function prepareLaunchdStart(): void {
  if (existsSync(plistPath())) writeFileSync(plistPath(), buildPlist(null), "utf8");
}
function stopLaunchd(): void { sh(`launchctl unload "${plistPath()}"`); }
function statusLaunchd(): string { try { return sh(`launchctl list | grep ${LABEL} || true`); } catch { return ""; } }
function launchdRuntimeState(): ServiceManagerRuntimeState {
  try {
    const list = sh("launchctl list");
    return list.split(/\r?\n/).some(line => line.includes(LABEL)) ? "running" : "stopped";
  } catch {
    return "unknown";
  }
}
function uninstallLaunchd(): void {
  const p = plistPath();
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  if (existsSync(p)) unlinkSync(p);
}

// ── Windows (Task Scheduler) ──
/**
 * In-place service-asset write that tolerates the transient EBUSY/EPERM/EACCES Windows
 * throws while the just-ended task's cmd.exe (or an AV scanner) still holds the file.
 */
function writeServiceAssetWithRetry(path: string, content: string, encoding: "utf8" | "utf16le"): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, content, encoding);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw err;
      Bun.sleepSync(150);
    }
  }
}

function installWindows(): void {
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  // Transactional backend switch: installing the scheduler backend removes a native
  // service first — two live managers would both respawn the proxy (conflict).
  if (statusWinswRaw() !== "nonexistent") {
    console.log("🔁 Removing the native (WinSW) service before installing the Task Scheduler backend...");
    try {
      uninstallWinswService();
    } catch (err) {
      throw new Error(`Cannot remove the native service before switching to Task Scheduler: ${err instanceof Error ? err.message : String(err)}. Remove it manually with 'sc delete ${WINSW_SERVICE_ID}' or retry.`);
    }
    if (statusWinswRaw() !== "nonexistent") {
      throw new Error(`Native service registration could not be re-verified after the removal attempt — aborting switch. Check 'sc.exe query ${WINSW_SERVICE_ID}' and remove it manually if present.`);
    }
  }
  // End a running task BEFORE rewriting the assets it is executing — cmd.exe reading the
  // script mid-rewrite runs a torn batch file, and its open handle can fail the write.
  // A failed or unknown stop is a hard refusal: mutating the assets would race a live wrapper.
  const schedulerProbe = probeWindowsSchedulerTask();
  if (schedulerProbe.status === "unknown") {
    throw new Error(`Task Scheduler state is unknown; refusing to rewrite service assets. ${schedulerProbe.detail}`);
  }
  if (schedulerProbe.status === "present") {
    stopManagerWithVerification({
      installed: true,
      label: "Task Scheduler service",
      runtimeState: () => {
        const state = windowsSchedulerRuntimeState();
        return state === "not-running" ? "stopped" : state;
      },
      stop: stopWindows,
    });
  }
  writeWindowsSchedulerAssets();
  schtasks(buildWindowsSchtasksCreateArgs(windowsServiceScriptPath()));
  schtasks(["/run", "/tn", TASK]);
  writeServiceInstallState("scheduler");
}

/** Refresh scheduler-owned assets without re-registering the existing task. */
function writeWindowsSchedulerAssets(): void {
  const script = windowsServiceScriptPath();
  writeServiceAssetWithRetry(script, buildWindowsServiceScript(), "utf8");
  // UTF-16LE + BOM: a BOM-less UTF-8 VBS mis-decodes non-ASCII (e.g. Korean) profile
  // paths on some WSH/codepage combinations — same contract as the task XML below.
  writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le");
  writeServiceAssetWithRetry(windowsTaskXmlPath(), `\uFEFF${buildWindowsTaskXml(script)}`, "utf16le");
}

export interface RepairServiceDeps {
  diagnose?: () => ServiceDiagnostic;
  assertEnv?: () => void;
  assertAuth?: () => void;
  writeSchedulerAssets?: () => void;
  stopScheduler?: () => void;
  schedulerRuntimeState?: () => ServiceManagerRuntimeState;
  startScheduler?: () => void;
  writeSchedulerState?: () => void;
  writeNativeState?: () => void;
  repairNative?: () => void | Promise<void>;
  repairLaunchd?: () => void;
  repairSystemd?: () => void;
  platform?: NodeJS.Platform;
}

/** Refresh an installed backend in place; never call Task Scheduler /create here. */
export async function repairService(deps: RepairServiceDeps = {}): Promise<void> {
  const diagnose = deps.diagnose ?? diagnoseService;
  const platform = deps.platform ?? process.platform;
  const diag = diagnose();
  if (!diag.supported) throw new Error(`Background service is unsupported (${diag.summary}).`);
  if (diag.conflict) {
    throw new Error("Cannot repair while Task Scheduler and native WinSW are both present. Run 'ocx service uninstall' then reinstall one backend with 'ocx service install'.");
  }
  if (!diag.installed) throw new Error("Background service is not installed. Run 'ocx service install' first.");
  (deps.assertEnv ?? assertServiceEnvironmentMatchesInstall)();
  (deps.assertAuth ?? assertServiceAuthEnvironment)();
  if (platform === "win32") {
    if (diag.backend === "native") {
      await (deps.repairNative ?? (() => installWinswService(defaultWinswEntry(import.meta.dir))))();
      (deps.writeNativeState ?? (() => writeServiceInstallState("native")))();
      return;
    }
    const stopScheduler = deps.stopScheduler ?? stopWindows;
    const schedulerRuntimeState = deps.schedulerRuntimeState
      ?? (deps.stopScheduler
        ? (() => "running" as ServiceManagerRuntimeState)
        : () => {
          const state = windowsSchedulerRuntimeState();
          return state === "not-running" ? "stopped" : state;
        });
    stopManagerWithVerification({ installed: true, label: "Task Scheduler service", runtimeState: schedulerRuntimeState, stop: stopScheduler });
    (deps.writeSchedulerAssets ?? writeWindowsSchedulerAssets)();
    (deps.startScheduler ?? startWindows)();
    (deps.writeSchedulerState ?? (() => writeServiceInstallState("scheduler")))();
    return;
  }
  if (platform === "darwin") { (deps.repairLaunchd ?? installLaunchd)(); return; }
  if (platform === "linux") { (deps.repairSystemd ?? installSystemd)(); return; }
  throw new Error(`Background service repair is unsupported on ${platform}.`);
}

/**
 * Opt-in native backend (`ocx service install --native`). Transactional: removes the
 * scheduler backend first; on failure the machine is left with NO service (explicitly
 * reported) — never a silent fallback to the scheduler.
 */
async function installWindowsNative(): Promise<void> {
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  const hadScheduler = requireKnownWindowsSchedulerTaskState(
    TASK,
    "install the native service while scheduler presence is unverified",
  ) === "present";
  if (hadScheduler) {
    console.log("🔁 Removing the Task Scheduler backend before installing the native (WinSW) service...");
    try { stopWindows(); } catch { /* not running */ }
    try {
      uninstallWindows();
    } catch (err) {
      throw new Error(`Cannot remove the Task Scheduler backend before switching to native: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Verify removal — schtasks /delete can silently fail if UAC or policy blocks it,
    // and a failed verification query is not proof that the task disappeared.
    const afterRemoval = requireKnownWindowsSchedulerTaskState(
      TASK,
      "continue the native service install after scheduler removal could not be verified",
    );
    if (afterRemoval === "present") {
      throw new Error("Task Scheduler backend still present after removal — aborting switch.");
    }
  }
  try {
    await installWinswService(defaultWinswEntry(import.meta.dir));
  } catch (err) {
    if (hadScheduler) console.error("⚠️  Native install failed AFTER removing the Task Scheduler backend — no service is installed now. Run `ocx service install` to restore the scheduler backend, or retry `--native`.");
    throw err;
  }
  writeServiceInstallState("native");
}
function startWindows(): void { schtasks(["/run", "/tn", TASK]); }
function prepareWindowsStart(): void {
  const script = windowsServiceScriptPath();
  if (existsSync(script)) writeServiceAssetWithRetry(script, buildWindowsServiceScript(cliEntry(), null), "utf8");
}
function prepareWindowsNativeStart(): void {
  if (existsSync(winswXmlPath())) {
    writeFileSync(winswXmlPath(), buildWinswXml(defaultWinswEntry(import.meta.dir), process.env, null), "utf8");
  }
}
function stopWindows(): void { schtasks(["/end", "/tn", TASK]); }
function statusWindows(): string { try { return schtasks(["/query", "/tn", TASK]); } catch { return ""; } }
export interface SchedulerUninstallDeps {
  probe?: () => WindowsSchedulerTaskProbe;
  removeRegistration?: () => void;
  removeAssets?: () => void;
}

/** Delete a scheduler registration only after the post-delete absence is proven. */
export function uninstallSchedulerSafely(deps: SchedulerUninstallDeps = {}): void {
  const probe = deps.probe ?? (() => probeWindowsSchedulerTask());
  const removeRegistration = deps.removeRegistration ?? (() => { schtasks(["/delete", "/tn", TASK, "/f"]); });
  const removeAssets = deps.removeAssets ?? (() => {
    if (existsSync(windowsServiceScriptPath())) unlinkSync(windowsServiceScriptPath());
    if (existsSync(windowsLauncherVbsPath())) unlinkSync(windowsLauncherVbsPath());
    if (existsSync(windowsTaskXmlPath())) unlinkSync(windowsTaskXmlPath());
  });
  const before = probe();
  if (before.status === "unknown") {
    throw new Error(`Task Scheduler state is unknown; uninstall aborted and service assets were retained. ${before.detail}`);
  }
  if (before.status === "present") {
    try { removeRegistration(); } catch { /* post-probe decides whether it is gone */ }
  }
  const after = probe();
  if (after.status !== "absent") {
    throw new Error(after.status === "unknown"
      ? `Task Scheduler absence could not be verified; uninstall aborted and service assets were retained. ${after.detail}`
      : "Task Scheduler task is still present after uninstall; service assets were retained.");
  }
  removeAssets();
}

function uninstallWindows(): void {
  uninstallSchedulerSafely();
}

/**
 * Warn when the paths baked into installed service assets no longer exist (npm prefix
 * moved, nvm switch, reinstall) — the service manager would restart-loop on a dead path
 * while `schtasks`/`launchctl` still report "installed".
 */
export function bakedServicePathsDiagnostic(): string | null {
  const state = readServiceInstallState();
  if (!state?.bunPath || !state?.cliPath) return null;
  const missing = [state.bunPath, state.cliPath].filter(path => !existsSync(path));
  if (missing.length === 0) return null;
  return `STALE baked paths (missing: ${missing.map(redactUserPath).join(", ")}) — run 'ocx service install' to re-bake`;
}

function serviceDiagnosticsSummary(): string {
  const stale = bakedServicePathsDiagnostic();
  return stale ? `${stale}; logs: ${serviceLogPath()}` : `logs: ${serviceLogPath()}`;
}

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

export function buildUnit(pinnedPort?: number | null): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
  const opencodexHome = systemdEnvironmentAssignment("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("OCX_SERVICE", "1"),
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
    opencodexHome,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote("/bin/sh")} -lc ${systemdQuote(buildServiceShellCommand(bun, cli, pinnedPort))}
Restart=on-failure
RestartSec=5
${envLines}
StandardOutput=${systemdOutputTarget(`append:${log}`)}
StandardError=${systemdOutputTarget(`append:${log}`)}

[Install]
WantedBy=default.target
`;
}

/** The per-user runtime dir systemd creates (holds the user-bus socket), or null. */
function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so
 * `systemctl --user` can't find the user bus even when systemd is running. Point `XDG_RUNTIME_DIR`
 * at the per-user runtime dir when it exists so the `--user` probe and install commands reach the
 * bus. No-op when already set or when no runtime dir exists (e.g. genuinely non-systemd hosts).
 */
function ensureUserBusEnv(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const dir = userRuntimeDir();
  if (dir) process.env.XDG_RUNTIME_DIR = dir;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  ensureUserBusEnv();
  // Prefer the user-bus probe; but an SSH session without a user D-Bus fails it even when systemd
  // is present (F9). Fall back to the per-user runtime dir existing — a strong signal the user
  // systemd instance is available — so a first-time `ocx service install` isn't wrongly refused.
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { /* no user bus in this session */ }
  return userRuntimeDir() !== null;
}

function installSystemd(): void {
  ensureUserBusEnv(); // reach the user bus over a bare SSH session (F9)
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  writeFileSync(unitPath(), buildUnit(), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable ${TASK}`);
  sh(`systemctl --user restart ${TASK}`);
  writeServiceInstallState();
}
function startSystemd(): void {
  ensureUserBusEnv();
  if (!existsSync(unitPath())) {
    console.error(`opencodex service is not installed: ${unitPath()}`);
    console.error("Run `ocx service install` first to create and enable the systemd user unit.");
    process.exit(1);
  }
  sh(`systemctl --user start ${TASK}`);
}
function prepareSystemdStart(): void {
  if (!existsSync(unitPath())) return;
  writeFileSync(unitPath(), buildUnit(null), "utf8");
  sh("systemctl --user daemon-reload");
}
function stopSystemd(): void { sh(`systemctl --user stop ${TASK}`); }
function statusSystemd(): string { try { return sh(`systemctl --user status ${TASK}`); } catch { return ""; } }
function systemdRuntimeState(): ServiceManagerRuntimeState {
  try {
    const state = sh(`systemctl --user show ${TASK} --property=ActiveState --value`).trim();
    if (state === "active" || state === "activating" || state === "reloading" || state === "deactivating") return "running";
    if (state === "inactive" || state === "failed") return "stopped";
    return "unknown";
  } catch {
    return "unknown";
  }
}
function uninstallSystemd(): void {
  try { sh(`systemctl --user disable --now ${TASK}`); } catch { /* absent */ }
  if (existsSync(unitPath())) unlinkSync(unitPath());
  try { sh("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

type ServiceOps = {
  install: () => void | Promise<void>; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
  prepareStart?: () => void;
};

function platformOps(backend: ServiceBackend = "scheduler"): ServiceOps | null {
  if (process.platform === "darwin")
    return { install: installLaunchd, prepareStart: prepareLaunchdStart, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (process.platform === "win32") {
    if (backend === "native")
      return { install: installWindowsNative, prepareStart: prepareWindowsNativeStart, start: startWinswService, stop: stopWinswService, status: winswStatusSummary, uninstall: uninstallWinswService };
    return { install: installWindows, prepareStart: prepareWindowsStart, start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) {
      console.error("Docker detected. Run 'ocx start' directly instead of using the service manager.");
      process.exit(1);
    }
    if (!isSystemd() && !existsSync(unitPath())) {
      console.error("systemd not found. Run 'ocx start' under your process supervisor.");
      if (isWslRuntime()) {
        console.error("WSL detected: enable systemd by adding [boot] systemd=true to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and reopen the distro (WSL 0.67.6+).");
      }
      process.exit(1);
    }
    return { install: installSystemd, prepareStart: prepareSystemdStart, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

export type ServiceManagerRuntimeState = "running" | "stopped" | "unknown";

export class ServiceManagerStopError extends Error {
  readonly code = "service-manager-stop-uncertain" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceManagerStopError";
  }
}

export interface StopManagerWithVerificationOptions {
  label: string;
  installed: boolean;
  runtimeState: () => ServiceManagerRuntimeState;
  stop: () => void;
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => void;
}

/** Stop a manager only from known state and return only after non-running is proven. */
export function stopManagerWithVerification(options: StopManagerWithVerificationOptions): boolean {
  if (!options.installed) return false;
  const before = options.runtimeState();
  if (before === "unknown") {
    throw new ServiceManagerStopError(`${options.label} runtime state is unknown; refusing unsafe teardown.`);
  }
  if (before === "stopped") return true;

  let stopError: unknown;
  try {
    options.stop();
  } catch (error) {
    stopError = error;
  }

  const attempts = Math.max(1, options.attempts ?? 20);
  const intervalMs = Math.max(0, options.intervalMs ?? 100);
  const sleep = options.sleep ?? Bun.sleepSync;
  let after: ServiceManagerRuntimeState = "unknown";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    after = options.runtimeState();
    if (after === "stopped") return true;
    if (attempt + 1 < attempts && intervalMs > 0) sleep(intervalMs);
  }
  const detail = stopError instanceof Error ? ` Stop command failed: ${stopError.message}` : "";
  throw new ServiceManagerStopError(
    `${options.label} did not reach a proven non-running state (last state: ${after}).${detail}`,
    stopError === undefined ? undefined : { cause: stopError },
  );
}

type TrackedProxyCleanupResult = "none" | "stale" | "stopped" | "failed";

async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult> {
  let pid = readPid();
  if (!pid) {
    const live = await findLiveProxy();
    if (!live) return "none";
    if (!live.pid) throw new Error("A live OpenCodex proxy was found, but its PID could not be verified.");
    pid = live.pid;
  }
  if (!isProcessAlive(pid)) {
    removePid(pid);
    removeRuntimePort(pid);
    return "stale";
  }
  await stopProxy(pid);
  removePid(pid);
  removeRuntimePort(pid);
  return "stopped";
}

async function stopTrackedProxyForServiceCommand(): Promise<TrackedProxyCleanupResult> {
  try {
    return await stopTrackedProxyIfRunning();
  } catch (err) {
    console.error(`⚠️  Failed to stop proxy: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

export interface ServiceStopGateOutcome {
  safeToTeardown: boolean;
  phase: "safe" | "manager-unsafe" | "proxy-unsafe";
  error?: unknown;
}

/** Service stop/uninstall may restore shared routing only after both stop gates pass. */
export async function runServiceStopGate(io: {
  stopManager: () => void;
  stopProxy: () => boolean | Promise<boolean>;
}): Promise<ServiceStopGateOutcome> {
  try {
    io.stopManager();
  } catch (error) {
    return { safeToTeardown: false, phase: "manager-unsafe", error };
  }
  try {
    if (!await io.stopProxy()) return { safeToTeardown: false, phase: "proxy-unsafe" };
  } catch (error) {
    return { safeToTeardown: false, phase: "proxy-unsafe", error };
  }
  return { safeToTeardown: true, phase: "safe" };
}

/**
 * If a service is installed, stop it so the process manager doesn't respawn after `ocx stop`.
 * Returns true if a service was found and stopped.
 */
export function stopServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    return stopManagerWithVerification({
      label: "launchd service",
      installed: existsSync(plistPath()),
      runtimeState: launchdRuntimeState,
      stop: stopLaunchd,
    });
  } else if (process.platform === "win32") {
    // Query BOTH backends regardless of state: a failed switch or stale state can leave
    // two managers installed, and either one would respawn the proxy after `ocx stop`.
    const scheduler = probeWindowsSchedulerXml();
    const nativeStatus = statusWinswRaw();
    if (scheduler.status === "unknown") {
      throw new ServiceManagerStopError(`Task Scheduler state is unknown; refusing unsafe teardown. ${scheduler.detail}`);
    }
    if (nativeStatus === "unknown") {
      throw new ServiceManagerStopError("Native WinSW service state is unknown; refusing unsafe teardown.");
    }
    const schedulerInstalled = scheduler.status === "present";
    const schedulerState = schedulerInstalled ? windowsSchedulerRuntimeState() : "not-running";
    if (schedulerInstalled && schedulerState === "unknown") {
      throw new ServiceManagerStopError("Task Scheduler runtime state is unknown; refusing unsafe teardown.");
    }
    let stopped = false;
    stopped = stopManagerWithVerification({
      label: "Task Scheduler service",
      installed: schedulerInstalled,
      runtimeState: () => {
        const state = windowsSchedulerRuntimeState();
        return state === "not-running" ? "stopped" : state;
      },
      stop: stopWindows,
    }) || stopped;
    stopped = stopManagerWithVerification({
      label: "native WinSW service",
      installed: nativeStatus !== "nonexistent",
      runtimeState: () => {
        const status = statusWinswRaw();
        return status === "started" ? "running"
          : status === "stopped" || status === "nonexistent" ? "stopped" : "unknown";
      },
      stop: stopWinswService,
    }) || stopped;
    return stopped;
  } else if (process.platform === "linux" && existsSync(unitPath())) {
    if (!isSystemd()) throw new ServiceManagerStopError("systemd user manager state is unknown; refusing unsafe teardown.");
    return stopManagerWithVerification({
      label: "systemd user service",
      installed: true,
      runtimeState: systemdRuntimeState,
      stop: stopSystemd,
    });
  }
  return false;
}

/** Delete install-state files; stale state would make `ocx update` "reinstall" a service that no longer exists. */
function removeServiceInstallState(): void {
  for (const path of serviceStatePaths()) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
}

/**
 * Best-effort service removal for full uninstall. Unlike `ocx service uninstall`, this is quiet
 * when no service exists and never exits the process just because the platform has no service
 * manager.
 */
export function uninstallServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      uninstallLaunchd();
      removeServiceInstallState();
      return true;
    }
  } else if (process.platform === "win32") {
    let removed = false;
    const scheduler = probeWindowsSchedulerXml();
    if (scheduler.status === "unknown") {
      throw new Error(`Task Scheduler install state is unknown; refusing to report uninstall success. ${scheduler.detail}`);
    }
    if (scheduler.status === "present") {
      uninstallWindows();
      removed = true;
    }
    const nativeStatus = statusWinswRaw();
    if (nativeStatus === "unknown") {
      throw new Error("Native WinSW install state is unknown; refusing to report uninstall success.");
    }
    if (nativeStatus !== "nonexistent") {
      uninstallWinswService();
      removed = true;
    }
    if (removed) { removeServiceInstallState(); return true; }
  } else if (process.platform === "linux" && existsSync(unitPath())) {
    try { uninstallSystemd(); removeServiceInstallState(); return true; } catch {
      try { unlinkSync(unitPath()); removeServiceInstallState(); return true; } catch { return false; }
    }
  }
  return false;
}

/** True if a background service (launchd/systemd/Task Scheduler) is installed. */
export function isServiceInstalled(): boolean {
  return diagnoseService().installed;
}

export interface ServiceDiagnostic {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  viable: boolean;
  startable: boolean;
  stale: boolean;
  conflict: boolean;
  backend: ServiceBackend | "launchd" | "systemd" | null;
  summary: string;
}

/** Windows tray may restart a healthy-but-stopped native service; stale/conflicting installs remain blocked. */
export function serviceStartableFromTray(service: ServiceDiagnostic): boolean {
  return service.startable && !service.stale && !service.conflict;
}

export interface WindowsServiceDiagnosticInputs {
  /**
   * Raw `schtasks /query /xml` output; empty when no task is registered. Passed as
   * XML rather than pre-computed booleans so every caller reads the document through
   * readWindowsSchedulerXmlState() — a second, stricter reading elsewhere would
   * silently reintroduce the stale-status false positive (#432).
   */
  schedulerXml: string;
  /** Query certainty; omitted test fixtures infer present/absent from schedulerXml. */
  schedulerQueryStatus?: "present" | "absent" | "unknown";
  schedulerQueryDetail?: string;
  /** Whether the on-disk service assets exist. A filesystem concern, not an XML one. */
  schedulerAssetsPresent: boolean;
  /** Actual proxy/task evidence; XML Enabled is registration state, not runtime state. */
  schedulerRunning: boolean;
  /** Query certainty for the Task Scheduler instance; omitted fixtures infer from schedulerRunning. */
  schedulerRuntimeStatus?: WindowsSchedulerRuntimeState;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  recordedBackend: ServiceBackend | null;
  staleBakedPaths: boolean;
  nativeRepairAssetsOnly: boolean;
  diagnostics: string;
}

export function deriveWindowsServiceDiagnostic(inputs: WindowsServiceDiagnosticInputs): ServiceDiagnostic {
  const schedulerState = readWindowsSchedulerXmlState(inputs.schedulerXml);
  const schedulerQueryStatus = inputs.schedulerQueryStatus
    ?? (schedulerState.installed ? "present" : "absent");
  const schedulerUnknown = schedulerQueryStatus === "unknown"
    || (schedulerQueryStatus === "present" && !schedulerState.installed);
  const schedulerRuntimeStatus = inputs.schedulerRuntimeStatus
    ?? (inputs.schedulerRunning ? "running" : "not-running");
  const schedulerRuntimeUnknown = schedulerQueryStatus === "present"
    && schedulerRuntimeStatus === "unknown";
  // Unknown presence is treated as possibly installed so callers cannot bypass it.
  const schedulerInstalled = schedulerQueryStatus !== "absent";
  const schedulerEnabled = !schedulerUnknown && schedulerState.enabled;
  const schedulerAssetsHealthy = !schedulerUnknown
    && inputs.schedulerAssetsPresent
    && schedulerState.registrationHealthy;
  const nativeInstalled = inputs.nativeStatus !== "nonexistent";
  const conflict = schedulerInstalled && nativeInstalled;
  const backendStateMismatch = schedulerInstalled
    ? inputs.recordedBackend !== "scheduler"
    : nativeInstalled
      ? inputs.recordedBackend !== "native"
      : inputs.recordedBackend !== null;
  const stale = schedulerUnknown
    || schedulerRuntimeUnknown
    || inputs.staleBakedPaths
    || (schedulerInstalled && !schedulerAssetsHealthy)
    || backendStateMismatch
    || (inputs.nativeStatus === "nonexistent" && inputs.nativeRepairAssetsOnly);
  const backend = schedulerInstalled ? "scheduler" : nativeInstalled ? "native" : null;
  const enabled = schedulerInstalled ? schedulerEnabled : inputs.nativeStatus === "started";
  const running = nativeInstalled
    ? inputs.nativeStatus === "started"
    : schedulerInstalled && schedulerRuntimeStatus === "running";
  const viable = !conflict && !stale
    && (schedulerInstalled
      ? schedulerEnabled && schedulerAssetsHealthy && running
      : inputs.nativeStatus === "started");
  const startable = !conflict && !stale
    && (schedulerInstalled
      ? schedulerEnabled && schedulerAssetsHealthy
      : inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const detail = conflict
    ? "CONFLICT: Task Scheduler and native WinSW are both present — run 'ocx service uninstall' then reinstall one"
    : schedulerUnknown
      ? `Task Scheduler status unknown${inputs.schedulerQueryDetail ? `: ${inputs.schedulerQueryDetail}` : ""}`
    : schedulerRuntimeUnknown
      ? "Task Scheduler runtime status unknown"
    : stale
      ? "stale or missing service assets — run 'ocx service install' to repair"
      : schedulerInstalled
        ? !schedulerEnabled
          ? "Task Scheduler disabled"
          : running
            ? "Task Scheduler enabled and proxy running"
            : "Task Scheduler enabled, proxy not verified running"
        : nativeInstalled
          ? `native (WinSW ${WINSW_VERSION}): ${inputs.nativeStatus}`
          : "not installed";
  const summary = backend ? `installed, ${detail} (${inputs.diagnostics})` : `not installed (${inputs.diagnostics})`;
  return {
    supported: true,
    installed: schedulerInstalled || nativeInstalled,
    enabled,
    running,
    viable,
    startable,
    stale,
    conflict,
    backend,
    summary,
  };
}

/**
 * Fail-closed restart diagnostic. Presence alone is never enough: conflicting
 * managers, stale baked paths, disabled registrations, and unknown/stopped
 * native managers cannot claim that Codex will reconnect after a reboot.
 */
export function diagnoseService(): ServiceDiagnostic {
  const diagnostics = serviceDiagnosticsSummary();
  if (process.platform === "darwin") {
    const installed = existsSync(plistPath());
    const running = installed && Boolean(statusLaunchd());
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (launchd; ${diagnostics})`
        : running ? `installed and loaded (launchd; ${diagnostics})`
          : `installed, not loaded (launchd; ${diagnostics})`;
    return { supported: true, installed, enabled: running, running, viable, startable: installed && !stale, stale, conflict: false, backend: "launchd", summary };
  }
  if (process.platform === "win32") {
    const schedulerProbe = probeWindowsSchedulerXml();
    const schedulerXml = schedulerProbe.xml;
    const schedulerAssetsPresent = [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()]
      .every(existsSync);
    const schedulerRuntimeStatus = schedulerProbe.status === "present"
      ? windowsSchedulerRuntimeState()
      : "not-running";
    const schedulerRunning = schedulerRuntimeStatus === "running";
    const nativeStatus = statusWinswRaw();
    const installState = readServiceInstallState();
    const recordedBackend: ServiceBackend | null = !installState
      ? null
      : installState.backend === "native" ? "native" : "scheduler";
    return deriveWindowsServiceDiagnostic({
      schedulerXml,
      schedulerQueryStatus: schedulerProbe.status,
      schedulerQueryDetail: schedulerProbe.status === "unknown" ? schedulerProbe.detail : undefined,
      schedulerAssetsPresent,
      // Registration XML says whether the task is enabled, not whether its instance is
      // running. Only Task Scheduler's own runtime state can establish this ownership.
      schedulerRunning,
      schedulerRuntimeStatus,
      nativeStatus,
      recordedBackend,
      staleBakedPaths: bakedServicePathsDiagnostic() !== null,
      nativeRepairAssetsOnly: Boolean(winswStatusSummary()),
      diagnostics,
    });
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported in Docker" };
    if (!isSystemd()) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported: systemd not found" };
    const installed = existsSync(unitPath());
    const enabled = installed && (() => { try { return sh(`systemctl --user is-enabled ${TASK}`) === "enabled"; } catch { return false; } })();
    const running = installed && (() => { try { return sh(`systemctl --user is-active ${TASK}`) === "active"; } catch { return false; } })();
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && enabled && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (systemd user; ${diagnostics})`
        : viable ? `installed, enabled and running (systemd user; ${diagnostics})`
          : `installed, but ${!enabled ? "disabled" : "not running"} (systemd user; ${diagnostics})`;
    return { supported: true, installed, enabled, running, viable, startable: installed && !stale, stale, conflict: false, backend: "systemd", summary };
  }
  return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: `unsupported on ${process.platform}` };
}

export function serviceStatusSummary(): string {
  return diagnoseService().summary;
}

export function normalizeServiceSubcommand(sub?: string): string {
  if (sub === "restart") return "repair";
  return sub ?? "install";
}

export const SERVICE_START_HEALTH_TIMEOUT_MS = 35_000;

export type ServiceCorrelatedLiveProxy = LiveProxy & {
  pid: number;
  source: "runtime";
  supervised: true;
};

export function isServiceCorrelatedProxy(
  live: LiveProxy | null,
): live is ServiceCorrelatedLiveProxy {
  return live?.supervised === true
    && live.source === "runtime"
    && typeof live.pid === "number"
    && Number.isSafeInteger(live.pid)
    && live.pid > 0;
}

export function serviceStartPostcondition(
  live: LiveProxy | null,
  manager: Pick<ServiceDiagnostic, "running" | "viable">,
): boolean {
  return isServiceCorrelatedProxy(live) && manager.running && manager.viable;
}

/** Require stable identity health whose PID-matched runtime record says service-owned. */
export async function waitForServiceProxy(
  options: ProxyReadinessOptions = {},
) {
  const findLive = options.findLive ?? findLiveProxy;
  return await waitForProxyIdentity({
    timeoutMs: SERVICE_START_HEALTH_TIMEOUT_MS,
    intervalMs: 200,
    ...options,
    findLive: async () => {
      const live = await findLive();
      return isServiceCorrelatedProxy(live) ? live : null;
    },
  });
}

async function refuseUnsupervisedProxyBeforeServiceStart(): Promise<boolean> {
  const live = await findLiveProxy();
  if (!live || isServiceCorrelatedProxy(live)) return true;
  console.error(
    `❌ A direct OpenCodex proxy is already running on port ${live.port}. `
    + "Stop it before starting or installing the background service.",
  );
  process.exitCode = 1;
  return false;
}

async function confirmServiceStarted(action: "installed" | "started"): Promise<boolean> {
  const live = await waitForServiceProxy();
  const manager = diagnoseService();
  if (!live || !serviceStartPostcondition(live, manager)) {
    console.error(`❌ Service ${action}, but the proxy did not become identity-healthy within ${Math.trunc(SERVICE_START_HEALTH_TIMEOUT_MS / 1000)}s.`);
    if (live && (!manager.running || !manager.viable)) {
      console.error(`   Service manager is not confirmed running and viable: ${manager.summary}`);
    }
    console.error(`   ${serviceDiagnosticsSummary()}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`✅ Proxy identity verified on port ${live.port}${live.pid ? ` (PID ${live.pid})` : ""}.`);
  return true;
}

async function stopServiceCommandSafely(): Promise<boolean> {
  const outcome = await runServiceStopGate({
    stopManager: () => { stopServiceIfInstalled(); },
    stopProxy: async () => await stopTrackedProxyForServiceCommand() !== "failed",
  });
  if (outcome.safeToTeardown) return true;
  if (outcome.phase === "manager-unsafe") {
    console.error(`❌ Service manager stop is not verified: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
  }
  // A still-live proxy continues to depend on injected routing. Never tear it down.
  process.exitCode = 1;
  return false;
}

export interface ParsedServiceArgs {
  sub: string;
  backend: ServiceBackend | null;
  invalid: string[];
}

export type ServiceInstallationState = "installed" | "absent" | "unknown";
export interface ServiceInstallationProbe { state: ServiceInstallationState; detail?: string; }
export interface ServiceInstallationProbeHooks {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  probeWindowsTask?: () => WindowsSchedulerTaskProbe;
  nativeStatus?: () => WinswStatus;
}

/** Probe only enough registration state to choose install versus repair. */
export function probeServiceInstallation(hooks: ServiceInstallationProbeHooks = {}): ServiceInstallationProbe {
  const platform = hooks.platform ?? process.platform;
  const exists = hooks.exists ?? existsSync;
  if (platform === "darwin") return { state: exists(plistPath()) ? "installed" : "absent" };
  if (platform === "linux") return { state: exists(unitPath()) ? "installed" : "absent" };
  if (platform !== "win32") return { state: "absent" };
  let scheduler: WindowsSchedulerTaskProbe;
  try { scheduler = (hooks.probeWindowsTask ?? probeWindowsSchedulerTask)(); }
  catch (cause) { scheduler = { status: "unknown", detail: schtasksErrorDetail(cause) }; }
  let native: WinswStatus;
  try { native = (hooks.nativeStatus ?? statusWinswRaw)(); }
  catch { native = "unknown"; }
  if (scheduler.status === "present" || native === "started" || native === "stopped") return { state: "installed" };
  if (scheduler.status === "unknown" || native === "unknown") {
    const parts = [
      scheduler.status === "unknown" ? `Task Scheduler: ${scheduler.detail}` : null,
      native === "unknown" ? "WinSW status could not be determined" : null,
    ].filter((part): part is string => Boolean(part));
    return { state: "unknown", detail: parts.join("; ") };
  }
  return { state: "absent" };
}

export function selectServiceSubcommand(
  parsed: ParsedServiceArgs,
  options: { hasExplicitSubcommand: boolean; installed: boolean },
): string {
  if (!options.hasExplicitSubcommand && parsed.backend === null && options.installed) return "repair";
  return parsed.sub;
}

export type ServiceCommandPlan =
  | { ok: true; parsed: ParsedServiceArgs; command: string }
  | { ok: false; message: string };

export function planServiceCommand(
  args: string[],
  options: { platform?: NodeJS.Platform; probeInstallation?: () => ServiceInstallationProbe } = {},
): ServiceCommandPlan {
  const parsed = parseServiceArgs(args);
  if (parsed.invalid.length > 0) return { ok: false, message: `Unknown service option: ${parsed.invalid.join(" ")}` };
  if (parsed.backend && parsed.sub !== "install") return { ok: false, message: "--native/--scheduler apply to `ocx service install` only; other subcommands use the installed backend." };
  if (parsed.backend === "native" && (options.platform ?? process.platform) !== "win32") return { ok: false, message: "--native (WinSW) is Windows-only." };
  const hasExplicitSubcommand = args.some(arg => !arg.startsWith("--"));
  let installed = false;
  if (!hasExplicitSubcommand && parsed.backend === null) {
    const probe = (options.probeInstallation ?? probeServiceInstallation)();
    if (probe.state === "unknown") {
      const suffix = probe.detail ? ` (${probe.detail})` : "";
      return { ok: false, message: `Could not safely determine whether the service is installed${suffix}. Run 'ocx service status' and retry; use explicit 'ocx service install' only after confirming it is absent.` };
    }
    installed = probe.state === "installed";
  }
  return { ok: true, parsed, command: selectServiceSubcommand(parsed, { hasExplicitSubcommand, installed }) };
}

/**
 * `ocx service [sub] [--native|--scheduler]`. The first non-flag token is the
 * subcommand; backend flags are only meaningful for `install` (validated by the caller).
 */
export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  let sub: string | undefined;
  let backend: ServiceBackend | null = null;
  const invalid: string[] = [];
  for (const arg of args) {
    if (arg === "--native") {
      if (backend === "scheduler") { invalid.push("--native (conflicts with --scheduler)"); continue; }
      backend = "native";
    }
    else if (arg === "--scheduler") {
      if (backend === "native") { invalid.push("--scheduler (conflicts with --native)"); continue; }
      backend = "scheduler";
    }
    else if (arg.startsWith("--")) invalid.push(arg);
    else if (sub === undefined) sub = arg;
    else invalid.push(arg);
  }
  return { sub: normalizeServiceSubcommand(sub), backend, invalid };
}

export async function serviceCommand(...args: (string | undefined)[]): Promise<boolean | void> {
  const filteredArgs = args.filter((a): a is string => Boolean(a));
  const plan = planServiceCommand(filteredArgs);
  if (!plan.ok) { console.error(plan.message); process.exit(1); }
  const { parsed, command } = plan;
  // Non-install subcommands follow the backend recorded at install time (state v2).
  const backend: ServiceBackend = parsed.backend ?? (process.platform === "win32" ? readServiceBackend() : "scheduler");
  const ops = platformOps(backend);
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (command) {
    case "repair":
      await repairService();
      if (!await confirmServiceStarted("started")) return false;
      console.log("✅ service repaired and restarted.");
      return true;
    case "install":
      assertServiceEnvironmentMatchesInstall();
      assertServiceAuthEnvironment();
      if (!await refuseUnsupervisedProxyBeforeServiceStart()) return false;
      await ops.install();
      if (!await confirmServiceStarted("installed")) return false;
      console.log(backend === "native"
        ? "✅ opencodex native service installed + started (windowless, starts at boot, auto-restarts on crash)."
        : "✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
      if (process.platform === "linux") console.log("   For auto-start on boot: loginctl enable-linger $USER");
      return true;
    case "start":
      assertServiceEnvironmentMatchesInstall();
      if (!await refuseUnsupervisedProxyBeforeServiceStart()) return false;
      // Refresh legacy hard-pinned assets to the normal availability-first policy.
      // Update installation still gets one hard launch through OCX_BAKE_PORT.
      ops.prepareStart?.();
      ops.start();
      if (!await confirmServiceStarted("started")) return false;
      console.log("✅ service started.");
      return true;
    case "stop":
      assertServiceEnvironmentMatchesInstall();
      if (!await stopServiceCommandSafely()) return false;
      {
        const restore = restoreNativeCodex();
        if (restore.success) console.log("✅ service stopped + native Codex restored.");
        else {
          process.exitCode = 1;
          console.error(`⚠️ service stopped, but native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` (or check $CODEX_HOME/config.toml) before using native Codex.`);
        }
        const env = revertSystemEnv();
        if (!env.reverted && env.reason !== "no tracking file" && env.reason !== "not macOS") {
          process.exitCode = 1;
          console.error(`⚠️  System environment restore failed: ${env.reason ?? "unknown error"}`);
        }
        // The Grok fence is the other managed config this command owns. Leaving it behind
        // pointed grok at a dead endpoint while native Codex was already restored.
        const grok = stripGrokConfig();
        if (grok.changed) console.log(`↩️  ${grok.message}`);
        else if (!grok.ok) { process.exitCode = 1; console.error(`⚠️  ${grok.message}`); }
      }
      break;
    case "status": {
      const s = ops.status();
      console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
      console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
      break;
    }
    case "uninstall":
    case "remove":
      assertServiceEnvironmentMatchesInstall();
      if (!await stopServiceCommandSafely()) return false;
      try {
        ops.uninstall();
      } catch (err) {
        console.error(`❌ Service uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("The service may still be installed. Check with 'ocx service status' or remove manually.");
        process.exit(1);
      }
      {
        const restore = restoreNativeCodex();
        if (!restore.success) {
          process.exitCode = 1;
          console.error(`⚠️ native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` before using native Codex.`);
        }
        const env = revertSystemEnv();
        if (!env.reverted && env.reason !== "no tracking file" && env.reason !== "not macOS") {
          process.exitCode = 1;
          console.error(`⚠️  System environment restore failed: ${env.reason ?? "unknown error"}`);
        }
        const grok = stripGrokConfig();
        if (grok.changed) console.log(`↩️  ${grok.message}`);
        else if (!grok.ok) { process.exitCode = 1; console.error(`⚠️  ${grok.message}`); }
      }
      removeServiceInstallState();
      try { if (existsSync(serviceApiTokenFilePath())) unlinkSync(serviceApiTokenFilePath()); } catch { /* best-effort */ }
      console.log("✅ service uninstalled.");
      break;
    default:
      console.error("Usage: ocx service [install|repair|restart|start|stop|status|uninstall|remove] [--native|--scheduler]");
      console.error("       With no subcommand, installs when absent or repairs/restarts an existing service.");
      console.error("       repair/restart: refresh assets and restart an already-installed service (no admin re-prompt).");
      console.error("       --native (Windows only): register a real SCM service via WinSW instead of Task Scheduler.");
      process.exit(1);
  }
}
