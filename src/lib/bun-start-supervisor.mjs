import { spawn } from "node:child_process";

/** The diagnostic Bun prints for a runtime panic (keep this exact and narrow). */
export const BUN_CRASH_MARKER = "oh no: Bun has crashed";
/** Maximum retained stderr, in bytes. Crash output is diagnostic, never unbounded state. */
export const BUN_CRASH_STDERR_MAX_BYTES = 64 * 1024;
/** A proxy-establishing direct start gets one, and only one, panic-qualified retry. */
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

/**
 * Bounded stderr tail plus an attempt-local exact crash-marker latch.
 *
 * Shared by every launch route that classifies Bun panics: `tail` keeps at
 * most 64 KiB for diagnostics while `matched` remembers the exact
 * "oh no: Bun has crashed" marker even if later stderr evicts it. Each
 * launch attempt must construct a fresh latch so output from one crash can
 * never classify an ordinary later failure.
 */
export function createBunCrashLatch() {
  const tail = new BoundedStderr();
  const marker = Buffer.from(BUN_CRASH_MARKER);
  let carry = Buffer.alloc(0);
  let matched = false;
  return {
    append(chunk) {
      tail.append(chunk);
      if (matched) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const window = carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
      matched = window.indexOf(marker) !== -1;
      if (!matched) {
        const carryLength = Math.min(marker.length - 1, window.length);
        carry = Buffer.from(window.subarray(window.length - carryLength));
      }
    },
    get matched() {
      return matched;
    },
    toString() {
      return tail.toString();
    },
  };
}

function isAbnormalExit(code, signal) {
  return signal !== null || (code !== null && code !== 0);
}

export function isRetryableBunCommand(argsOrCommand) {
  const command = Array.isArray(argsOrCommand) ? argsOrCommand[0] : argsOrCommand;
  return command === "start" || command === "ensure";
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
    stderrDrainSource = process.stderr,
    maxRetries = BUN_CRASH_RETRY_LIMIT,
    retryCommand,
    signalSource = process,
    platform = process.platform,
    env,
    cwd,
    windowsHide,
  } = options;
  const retryTarget = retryCommand ?? args[0] ?? "command";
  const retries = isRetryableBunCommand(retryTarget)
    ? Math.max(0, Math.min(BUN_CRASH_RETRY_LIMIT, Number(maxRetries) || 0))
    : 0;
  let child = null;
  let retryCount = 0;
  let panicQualifiedAttempts = 0;
  let parentSignal = null;
  let finished = false;
  const forwardedSignals = platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = [];
  const emitDiagnostic = text => {
    try { writeStderr(text); } catch { /* diagnostics must not change launch semantics */ }
  };

  return new Promise(resolve => {
    const removeHandlers = () => {
      for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
      handlers.length = 0;
    };

    const finish = result => {
      if (finished) return;
      finished = true;
      removeHandlers();
      resolve({ ...result, retries: retryCount, stderrTail: result.stderrTail ?? "" });
    };

    const launch = () => {
      if (finished) return;
      let spawnError = null;
      let closed = false;
      const latch = createBunCrashLatch();
      let resumeAfterDrain = null;
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

      const stderrStream = child.stderr;
      const clearDrainListener = () => {
        if (!resumeAfterDrain) return;
        stderrDrainSource?.removeListener?.("drain", resumeAfterDrain);
        resumeAfterDrain = null;
      };

      if (stderrStream && typeof stderrStream.on === "function") {
        stderrStream.on("data", chunk => {
          latch.append(chunk);

          try {
            const forwarded = writeStderr(chunk);
            if (
              forwarded === false
              && resumeAfterDrain === null
              && typeof stderrStream.pause === "function"
              && typeof stderrStream.resume === "function"
              && typeof stderrDrainSource?.once === "function"
            ) {
              stderrStream.pause();
              resumeAfterDrain = () => {
                resumeAfterDrain = null;
                stderrStream.resume();
              };
              stderrDrainSource.once("drain", resumeAfterDrain);
            }
          } catch { /* stderr disappearing must not kill the launcher */ }
        });
      }

      const close = (code, signal) => {
        if (closed || finished) return;
        closed = true;
        clearDrainListener();
        // Spawn errors are never runtime crashes, even if a test double reports
        // both `error` and `close`.
        if (spawnError) {
          finish({ code: code ?? null, signal: signal ?? null, error: spawnError });
          return;
        }
        const effectiveSignal = parentSignal ?? signal ?? null;
        const abnormal = parentSignal === null && isAbnormalExit(code, signal);
        const panic = abnormal && latch.matched;
        if (panic) panicQualifiedAttempts += 1;
        if (panic && retryCount < retries) {
          retryCount += 1;
          emitDiagnostic(`opencodex: Bun crashed during ${retryTarget}; retrying once.\n`);
          launch();
          return;
        }
        if (panic && panicQualifiedAttempts >= 2) {
          emitDiagnostic(
            "opencodex: Bun crashed twice. Try OPENCODEX_BUN_PATH with a tested canary runtime or upgrade Bun.\n",
          );
        }
        finish({
          code: parentSignal ? null : (code ?? null),
          signal: effectiveSignal,
          stderrTail: latch.toString(),
        });
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
      signalSource.on(signal, handler);
      handlers.push([signal, handler]);
    }
    launch();
  });
}
