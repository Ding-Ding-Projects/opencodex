/**
 * An independent, unconditional backstop for a promise that is supposed to be
 * bounded by its own cancellation (an `AbortSignal.timeout`, a client-side
 * deadline) but cannot be trusted to actually honor it every time.
 *
 * Reproduced live (2026-08-15, devlog b3-proxyhang): `fetch(url, { signal:
 * AbortSignal.timeout(8000) })` to an external host, called from inside a
 * `Bun.serve()` request handler while the process is also serving several other
 * concurrent inbound HTTP requests and running concurrent first-time dynamic
 * `import()`s, can leave the fetch's promise permanently unsettled — the 8s
 * abort never fires, and nothing else in the process reports an error. Once
 * that happens, `Bun.serve()` (Bun 1.3.14, Windows) stops answering ANY further
 * request on that listener, including totally unrelated synchronous routes
 * (`/healthz`) hit from a separate process outside the browser entirely. A
 * dashboard load that triggers this turns the whole local proxy permanently
 * unresponsive, not just the one panel that made the call.
 *
 * `raceDeadline` does not attempt to cancel or clean up the underlying work —
 * there is nothing here that can do that; the whole point is that the normal
 * cancellation path already failed. It only guarantees that the CALLER gets an
 * answer within `ms`, by racing a second, independent timer against the real
 * promise and taking whichever settles first. The loser is left to resolve (or
 * never resolve) on its own; this only stops it from blocking anything further
 * downstream of the call site.
 *
 * Use this to wrap any single external network call whose own timeout you do
 * not fully trust, immediately around the call — not around a larger block —
 * so exactly one promise races exactly one timer and the semantics stay easy
 * to reason about.
 */
export function raceDeadline<T>(work: Promise<T>, ms: number, onDeadline: () => T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        resolve(Promise.resolve(onDeadline()));
      } catch (err) {
        reject(err);
      }
    }, ms);
    // A deadline this module exists to survive a stuck process must never itself
    // keep that process alive — unref so a hung `work` cannot block shutdown.
    timer.unref?.();
    work.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * `raceDeadline` specialized for a network call that is meant to throw (and be
 * caught by the caller's existing error handling) when it does not finish in
 * time, mirroring what `AbortSignal.timeout` itself would normally throw.
 */
export function rejectOnHardDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return raceDeadline(work, ms, () => {
    throw new DOMException(message, "TimeoutError");
  });
}
