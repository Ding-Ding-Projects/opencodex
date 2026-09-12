export { BUN_CRASH_MARKER } from "./bun-start-supervisor.mjs";

/** How long one launch attempt is observed for early death before it is left unobserved. */
export declare const TRAY_HOST_LAUNCH_OBSERVE_MS: number;
/** A panic-qualified tray-host launch gets one, and only one, retry. */
export declare const TRAY_HOST_RETRY_LIMIT: number;

export interface TrayHostLaunchEvidence {
  attempt: number;
  timestampMs: number;
  panic: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface TrayHostLaunchOptions {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof import("node:child_process").spawn;
  heartbeatFresh?: () => boolean;
  observeWindowMs?: number;
  pollIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<unknown>;
  maxRetries?: number;
  onAttempt?: (info: { attempt: number }) => void;
  onEvidence?: (evidence: TrayHostLaunchEvidence) => void;
  nowImpl?: () => number;
}

export interface TrayHostLaunchResult {
  outcome: "healthy" | "running" | "exited";
  attempts: number;
  panic: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  error?: Error;
}

export declare function launchTrayHostWithCrashRetry(options: TrayHostLaunchOptions): Promise<TrayHostLaunchResult>;
