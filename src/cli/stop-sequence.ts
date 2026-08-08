export type StopSequencePhase =
  | "complete"
  | "teardown-warning"
  | "manager-unsafe"
  | "proxy-unsafe";

export interface StopSequenceOutcome {
  phase: StopSequencePhase;
  serviceStopped: boolean;
  proxyStopped: boolean;
  /** Restart is safe once both stop gates succeeded, even if teardown only warned. */
  safeToRestart: boolean;
  error?: unknown;
}

export interface StopSequenceIo {
  stopManager: () => boolean | Promise<boolean>;
  stopProxy: () => boolean | Promise<boolean>;
  teardown: () => boolean | Promise<boolean>;
}

/**
 * Safety ordering for every explicit CLI stop/restart.
 *
 * Manager uncertainty leaves the child and shared config untouched. Proxy-stop
 * uncertainty leaves native/Grok/environment routing untouched. Teardown failures
 * are warnings after the process is safely down, so an explicit restart may proceed.
 */
export async function runStopSequence(io: StopSequenceIo): Promise<StopSequenceOutcome> {
  let serviceStopped = false;
  try {
    serviceStopped = await io.stopManager();
  } catch (error) {
    return { phase: "manager-unsafe", serviceStopped: false, proxyStopped: false, safeToRestart: false, error };
  }

  let proxyStopped = false;
  try {
    proxyStopped = await io.stopProxy();
  } catch (error) {
    return { phase: "proxy-unsafe", serviceStopped, proxyStopped: false, safeToRestart: false, error };
  }

  try {
    const clean = await io.teardown();
    return {
      phase: clean ? "complete" : "teardown-warning",
      serviceStopped,
      proxyStopped,
      safeToRestart: true,
    };
  } catch (error) {
    return { phase: "teardown-warning", serviceStopped, proxyStopped, safeToRestart: true, error };
  }
}
