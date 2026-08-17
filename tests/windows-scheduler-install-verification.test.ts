import { afterEach, describe, expect, test } from "bun:test";
import {
  buildWindowsTaskXml,
  evaluateWindowsSchedulerInstallVerification,
  probeWindowsSchedulerXml,
  probeWindowsSchedulerTask,
  requireKnownWindowsSchedulerTaskState,
  setQuerySchtasksForTests,
  windowsSchedulerCsvIncludesTask,
  windowsSchedulerTaskInstalled,
  windowsTaskRegistrationHealthy,
} from "../src/service";

afterEach(() => {
  setQuerySchtasksForTests(null);
});

describe("windowsSchedulerCsvIncludesTask", () => {
  test("matches quoted Task Scheduler CSV task names", () => {
    const csv = [
      `"TaskName","Next Run Time","Status"`,
      `"\\opencodex-proxy","N/A","Ready"`,
      `"\\Other Task","N/A","Ready"`,
    ].join("\n");
    expect(windowsSchedulerCsvIncludesTask(csv, "opencodex-proxy")).toBe(true);
    expect(windowsSchedulerCsvIncludesTask(csv, "missing-task")).toBe(false);
    expect(windowsSchedulerCsvIncludesTask(csv, "opencodex")).toBe(false);
  });
});

describe("probeWindowsSchedulerTask", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    setQuerySchtasksForTests(null);
  });

  test("returns present when the specific /tn query includes the task", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args[0] === "/query" && args[1] === "/tn") return "Folder: \\\nTaskName: opencodex-proxy";
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("opencodex-proxy")).toEqual({ status: "present" });
    expect(windowsSchedulerTaskInstalled("opencodex-proxy")).toBe(true);
  });

  test("falls back to CSV listing when the specific query fails", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) {
        return `"TaskName"\n"\\opencodex-proxy"\n`;
      }
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("opencodex-proxy")).toEqual({ status: "present" });
  });

  test("returns absent when specific query fails and CSV succeeds without the task", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("ERROR: The system cannot find the file specified.");
      if (args.includes("CSV")) return `"TaskName"\n"\\other-task"\n`;
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("opencodex-proxy")).toEqual({ status: "absent" });
    expect(windowsSchedulerTaskInstalled("opencodex-proxy")).toBe(false);
  });

  test("returns unknown with both details when specific query and CSV listing fail", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) throw new Error("RPC server is unavailable.");
      throw new Error("unexpected query");
    });
    const probe = probeWindowsSchedulerTask("opencodex-proxy");
    expect(probe.status).toBe("unknown");
    if (probe.status !== "unknown") throw new Error("expected unknown");
    expect(probe.detail).toContain("Access is denied.");
    expect(probe.detail).toContain("RPC server is unavailable.");
    expect(windowsSchedulerTaskInstalled("opencodex-proxy")).toBe(false);
  });

  test("native backend switching accepts only a proven scheduler state", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests(() => { throw new Error("RPC server is unavailable."); });
    expect(() => requireKnownWindowsSchedulerTaskState(
      "opencodex-proxy",
      "install the native service",
    )).toThrow("Task Scheduler state is unknown");

    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("task not found");
      if (args.includes("CSV")) return `"TaskName"\n"\\other-task"\n`;
      throw new Error("unexpected query");
    });
    expect(requireKnownWindowsSchedulerTaskState("opencodex-proxy")).toBe("absent");

    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) return "TaskName: opencodex-proxy";
      throw new Error("unexpected query");
    });
    expect(requireKnownWindowsSchedulerTaskState("opencodex-proxy")).toBe("present");

    const source = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();
    const nativeInstall = source.slice(
      source.indexOf("async function installWindowsNative"),
      source.indexOf("function startWindows"),
    );
    expect(nativeInstall.match(/requireKnownWindowsSchedulerTaskState/g)).toHaveLength(2);
    expect(nativeInstall).not.toContain("query failure = task absent");
  });
});

describe("probeWindowsSchedulerXml", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    setQuerySchtasksForTests(null);
  });

  test("distinguishes absent registration from an unknown scheduler query", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/xml")) throw new Error("registration not found");
      if (args.includes("/tn")) throw new Error("task not found");
      if (args.includes("CSV")) return `"TaskName"\n"\\other-task"\n`;
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerXml("opencodex-proxy")).toEqual({ status: "absent", xml: "" });

    setQuerySchtasksForTests(() => { throw new Error("RPC unavailable"); });
    const unknown = probeWindowsSchedulerXml("opencodex-proxy");
    expect(unknown.status).toBe("unknown");
    if (unknown.status !== "unknown") throw new Error("expected unknown");
    expect(unknown.detail).toContain("RPC unavailable");
  });

  test("returns present only with readable registration XML", () => {
    const xml = buildWindowsTaskXml();
    setQuerySchtasksForTests((args) => {
      if (args.includes("/xml")) return xml;
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerXml("opencodex-proxy")).toEqual({ status: "present", xml });
  });
});

describe("evaluateWindowsSchedulerInstallVerification", () => {
  const wscript = "C:\\Windows\\System32\\wscript.exe";
  const launcher = "C:\\Users\\Test\\.opencodex\\opencodex-service-launcher.vbs";
  const healthyXml = buildWindowsTaskXml("ignored.cmd", launcher)
    .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

  test("succeeds when task, registration, assets, and absent WinSW all hold", () => {
    expect(windowsTaskRegistrationHealthy(healthyXml, wscript, launcher)).toBe(true);
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result).toMatchObject({
      ok: true,
      conflict: false,
      nativeServiceAbsent: true,
      registrationHealthy: true,
      assetsHealthy: true,
      detail: "ok",
    });
  });

  test("fails with conflict when WinSW remains installed", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "stopped",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.nativeServiceAbsent).toBe(false);
    expect(result.detail).toContain("CONFLICT");
  });

  test("fails when both scheduler and WinSW report present", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "started",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  test("treats unknown WinSW status as unverified, not as a conflict", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "unknown",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(false);
    expect(result.nativeStatusUnknown).toBe(true);
    expect(result.nativeServiceAbsent).toBe(false);
    expect(result.detail).toContain("could not verify");
    expect(result.detail).not.toContain("CONFLICT");
  });

  test("fails when registration health is invalid", () => {
    const badXml = healthyXml.replace("<LogonTrigger>", "<BootTrigger>");
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: badXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.registrationHealthy).toBe(false);
    expect(result.detail).toContain("unhealthy");
  });

  test("fails when required assets are missing", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: false,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.assetsHealthy).toBe(false);
    expect(result.detail).toContain("assets are missing");
  });

  test("fails when scheduler task is absent", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: false,
      xml: "",
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.taskInstalled).toBe(false);
    expect(result.detail).toContain("not installed");
  });
});
