export declare const BUN_CRASH_MARKER: string;
export declare const BUN_CRASH_STDERR_MAX_BYTES: number;
export declare const BUN_CRASH_RETRY_LIMIT: number;

export interface BunStartResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  retries: number;
  stderrTail: string;
}

export interface BunStartOptions {
  spawnImpl?: typeof import("node:child_process").spawn;
  writeStderr?: (chunk: Buffer | string) => unknown;
  maxRetries?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}

export declare function runBunWithCrashRetry(
  command: string,
  args: readonly string[],
  options?: BunStartOptions,
): Promise<BunStartResult>;

export declare function isBunCrashResult(result: BunStartResult): boolean;
