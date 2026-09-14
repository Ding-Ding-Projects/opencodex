/**
 * Regression for a Windows service tri-state diagnostic gap (candidate OPS-02).
 *
 * deriveWindowsServiceDiagnostic() is documented, right above its own
 * declaration in src/service.ts, as a "Fail-closed restart diagnostic ...
 * unknown/stopped native managers cannot claim that Codex will reconnect
 * after a reboot." It honours that for the Task Scheduler backend: an
 * unknown scheduler query status or an unknown scheduler runtime status both
 * force `stale: true` (see tests/service.test.ts, "unknown Task Scheduler
 * query is possibly installed but unstartable").
 *
 * The native WinSW backend has no matching rule for its own "unknown"
 * status. statusWinswRaw() (src/lib/winsw.ts) returns "unknown" whenever the
 * query itself cannot be trusted -- WinSW status failed, or the SCM probe
 * could not be completed -- which is exactly the transient-failure class
 * this repository defends against everywhere else (see
 * src/lib/windows-secret-acl.ts's own extensive ETIMEDOUT handling). But in
 * deriveWindowsServiceDiagnostic's `stale` computation, the only clause that
 * can catch an "unknown" nativeStatus is
 * `inputs.nativeStatus === "nonexistent" && inputs.nativeRepairAssetsOnly`,
 * which never fires for "unknown" (it requires "nonexistent"). So a
 * correctly-recorded native install (recordedBackend === "native", matching
 * -- no backend-mismatch clause to hide behind) whose status query merely
 * failed to answer comes back `stale: false`.
 *
 * `running`/`viable`/`startable` already fail closed for this case through a
 * separate, redundant comparison against `nativeStatus === "started"`
 * directly -- that path is already covered by the existing
 * "a stopped healthy WinSW service remains startable from the tray" test.
 * This regression is about `stale` itself, which startupHealthSummary()
 * (src/codex/autostart-health.ts) consults BEFORE its generic "installed but
 * not viable" fallback -- so a transient WinSW status-query failure never
 * gets the "state could not be determined" treatment its Task Scheduler
 * sibling explicitly earns one branch away.
 */
import { describe, expect, test } from "bun:test";
import { deriveWindowsServiceDiagnostic, type WindowsServiceDiagnosticInputs } from "../src/service";

const base: WindowsServiceDiagnosticInputs = {
  schedulerXml: "",
  schedulerAssetsPresent: true,
  schedulerRunning: false,
  nativeStatus: "nonexistent",
  recordedBackend: null,
  staleBakedPaths: false,
  nativeRepairAssetsOnly: false,
  diagnostics: "logs: test",
};

describe("OPS-02: native WinSW 'unknown' status does not mark the service diagnostic stale", () => {
  test("a correctly-recorded native install whose status query returns unknown must fail closed as stale", () => {
    const result = deriveWindowsServiceDiagnostic({
      ...base,
      nativeStatus: "unknown",
      recordedBackend: "native", // matches: no backend-state mismatch to mask the gap
    });

    expect(result.installed).toBe(true);
    expect(result.running).toBe(false);
    expect(result.viable).toBe(false);
    // This is the gap: every other "state could not be determined" path in this
    // function (schedulerUnknown, schedulerRuntimeUnknown) sets stale: true.
    // The native/WinSW "unknown" path silently does not.
    expect(result.stale).toBe(true);
  });
});
