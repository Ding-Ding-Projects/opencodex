import { spawn } from "node:child_process";

/** The diagnostic Bun prints for a runtime panic (keep this exact and narrow). */
export const BUN_CRASH_MARKER = "oh no: Bun has crashed";
/** Maximum retained stderr, in bytes. Crash output is diagnostic, never unbounded state. */
export const BUN_CRASH_STDERR_MAX_BYTES = 64 * 1024;
/** A direct start gets one, and only one, panic-qualified retry. */
export const BUN_CRASH_RETRY_LIMIT = 1;

class BoundedStderr {
  #chunks = [];
  #bytes = 0;

  append(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (chunk.length >= BUN_CRASH_STDERR_MAX_BYTES) {
      // Copy the slice: a subarray would retain a potentially multi-megabyte
      // stderr allocation even though the supervisor promises a 64 KiB tail.
      this.#chunks = [Buffer.from(chunk.subarray(chunk.length - BUN_CRASH_STDERR_MAX_BYTES))];
      this.#bytes = BUN_CRASH_STDERR_MAX_BYTES;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes > BUN_CRASH_STDERR_MAX_BYTES && this.#chunks.length > 0) {
      const first = this.#chunks[0];
      const excess = this.#bytes - BUN_CRASH_STDERR_MAX_BYTES;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = Buffer.from(first.subarray(excess));
        this.#bytes -= excess;
      }
    }
  }

  toString() {
    return Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
  }
}

function isAbnormalExit(code, signal) {
  return signal !== null || (code !== null && code !== 0);
}

function hasErrorCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

/**
 * Start a Bun CLI child and retry only a genuine Bun panic.
 *
 * `spawn` is injected for focused tests. The default is deliberately Node's
 * child-process spawn: this file is imported by the Node npm launcher before
 * Bun has been resolved, so it must not use Bun globals or TypeScript syntax.
 * Stderr is both written live and kept in a bounded tail for crash detection.
 */
export function runBunWithCrashRetry(command, args, options = {}) {
  const {
    spawnImpl = spawn,
    writeStderr = chunk => process.stderr.write(chunk),
    maxRetries = BUN_CRASH_RETRY_LIMIT,
    env,
    cwd,
    windowsHide,
  } = options;
  const retries = Math.max(0, Math.min(BUN_CRASH_RETRY_LIMIT, Number(maxRetries) || 0));
  const stderrTail = new BoundedStderr();
  let child = null;
  let retryCount = 0;
  let parentSignal = null;
  let finished = false;
  const forwardedSignals = process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = [];

  return new Promise(resolve => {
    const removeHandlers = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      handlers.length = 0;
    };

    const finish = result => {
      if (finished) return;
      finished = true;
      removeHandlers();
      resolve({ ...result, retries: retryCount, stderrTail: stderrTail.toString() });
    };

    const launch = () => {
      if (finished) return;
      let spawnError = null;
      let closed = false;
      try {
        child = spawnImpl(command, args, {
          cwd,
          env,
          windowsHide,
          stdio: ["inherit", "inherit", "pipe"],
        });
      } catch (error) {
        finish({ code: null, signal: null, error });
        return;
      }

      if (child.stderr && typeof child.stderr.on === "function") {
        child.stderr.on("data", chunk => {
          stderrTail.append(chunk);
          try { writeStderr(chunk); } catch { /* stderr disappearing must not kill the launcher */ }
        });
      }

      const close = (code, signal) => {
        if (closed || finished) return;
        closed = true;
        // Spawn errors are never runtime crashes, even if a test double reports
        // both `error` and `close`.
        if (spawnError) {
          finish({ code: code ?? null, signal: signal ?? null, error: spawnError });
          return;
        }
        const effectiveSignal = parentSignal ?? signal ?? null;
        const abnormal = parentSignal === null && isAbnormalExit(code, signal);
        const panic = abnormal && stderrTail.toString().includes(BUN_CRASH_MARKER);
        if (panic && retryCount < retries) {
          retryCount += 1;
          launch();
          return;
        }
        finish({ code: parentSignal ? null : (code ?? null), signal: effectiveSignal });
      };

      child.once("error", error => {
        spawnError = error;
        // Node emits `close` after `error`; retaining that ordering lets us
        // report the actual exit fields while still forbidding a retry.
      });
      child.once("close", close);
      // A small test double may only implement `exit`; real Node children emit
      // close after their piped stderr drains, so close remains authoritative.
      child.once("exit", (code, signal) => {
        if (typeof child?.stderr?.on !== "function") close(code, signal);
      });
    };

    for (const signal of forwardedSignals) {
      const handler = () => {
        if (finished || parentSignal) return;
        parentSignal = signal;
        try { child?.kill(signal); } catch { /* child already exited */ }
      };
      process.on(signal, handler);
      handlers.push([signal, handler]);
    }
    launch();
  });
}

export function isBunCrashResult(result) {
  return Boolean(result && result.error === undefined && result.retries > 0);
}
