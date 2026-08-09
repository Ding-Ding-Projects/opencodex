import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { windowsEnvIndirectBatchValue } from "../src/lib/win-paths";
import { assertServiceAuthEnvironment, assertServiceEnvironmentMatchesInstall, bakedServicePathsDiagnostic, buildPlist, buildUnit, buildWindowsLauncherVbs, buildWindowsSchtasksCreateArgs, buildWindowsServiceScript, buildWindowsTaskXml, deriveWindowsServiceDiagnostic, normalizeServiceSubcommand, parseServiceInstallState, parseWindowsSchedulerRuntimeState, readWindowsSchedulerXmlState, resolveServiceListenPort, runServiceStopGate, serviceLogPath, serviceStartPostcondition, serviceStartableFromTray, serviceStatusSummary, stopManagerWithVerification, waitForServiceProxy, windowsTaskRegistrationHealthy } from "../src/service";
import { serviceApiTokenFilePath } from "../src/lib/service-secrets";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

const TEST_DIR = join(import.meta.dir, ".tmp-service-test");
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiAuthToken;
  if (existsSync(TEST_DIR)) removeTempDir(TEST_DIR);
});

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function pathVariants(path: string): string[] {
  const batchPath = windowsEnvIndirectBatchValue(path, windowsBatchValue);
  return [...new Set([
    path,
    path.replace(/\\/g, "\\\\"),
    batchPath,
    batchPath.replace(/\\/g, "\\\\"),
  ])];
}

function expectTextToContainPath(text: string, path: string): void {
  expect(pathVariants(path).some(candidate => text.includes(candidate))).toBe(true);
}

describe("service listen-port policy", () => {
  test("resolveServiceListenPort uses only an explicit/update pin, never config.port", () => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    saveConfig({ port: 10100, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig);
    expect(resolveServiceListenPort(18765)).toBe(18765);
    const prev = process.env.OCX_BAKE_PORT;
    try {
      process.env.OCX_BAKE_PORT = "15555";
      expect(resolveServiceListenPort()).toBe(15555);
      delete process.env.OCX_BAKE_PORT;
      expect(resolveServiceListenPort()).toBeUndefined();
      saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig);
      expect(resolveServiceListenPort()).toBeUndefined();
      process.env.OCX_BAKE_PORT = "15555";
      expect(resolveServiceListenPort(null)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prev;
    }
  });

  test("normal service assets are soft while update-generated assets bake OCX_BAKE_PORT", () => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    saveConfig({ port: 13337, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig);
    const prev = process.env.OCX_BAKE_PORT;
    try {
      delete process.env.OCX_BAKE_PORT;
      const script = buildWindowsServiceScript({ bun: "C:\\OpenCodex\\bun.exe", cli: "C:\\OpenCodex\\cli.ts" });
      expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start >>');
      expect(script).not.toContain("start --port");
      expect(buildPlist()).not.toContain("start --port");
      expect(buildUnit()).not.toContain("start --port");

      process.env.OCX_BAKE_PORT = "14444";
      expect(buildWindowsServiceScript()).toContain("start --port 14444");
      expect(buildPlist()).toContain("--port");
      expect(buildPlist()).toContain("14444");
      expect(buildUnit()).toContain("--port");
      expect(buildUnit()).toContain("14444");
    } finally {
      if (prev === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prev;
    }
  });

  test("service readiness waits for identity health and returns the fallback runtime port", async () => {
    let now = 0;
    let probes = 0;
    const live = await waitForServiceProxy({
      timeoutMs: 100,
      intervalMs: 10,
      now: () => now,
      sleep: async ms => { now += ms; },
      findLive: async () => (++probes < 3 ? null : {
        pid: 222,
        port: 49152,
        hostname: "127.0.0.1",
        source: "runtime",
        supervised: true,
      }),
    });
    expect(live).toMatchObject({ pid: 222, port: 49152 });
  });

  test("service readiness refuses an unrelated direct proxy", async () => {
    let now = 0;
    const live = await waitForServiceProxy({
      timeoutMs: 30,
      intervalMs: 10,
      stabilityMs: 0,
      now: () => now,
      sleep: async ms => { now += ms; },
      findLive: async () => ({
        pid: 333,
        port: 49153,
        hostname: "127.0.0.1",
        source: "runtime",
        supervised: false,
      }),
    });
    expect(live).toBeNull();
    expect(serviceStartPostcondition(
      { pid: 333, port: 49153, hostname: "127.0.0.1", source: "runtime", supervised: false },
      { running: true, viable: true },
    )).toBe(false);
    expect(serviceStartPostcondition(
      { pid: 444, port: 49154, hostname: "127.0.0.1", source: "runtime", supervised: true },
      { running: false, viable: true },
    )).toBe(false);
    expect(serviceStartPostcondition(
      { pid: null, port: 49155, hostname: "127.0.0.1", source: "runtime", supervised: true },
      { running: true, viable: true },
    )).toBe(false);
    expect(serviceStartPostcondition(
      { pid: 555, port: 49156, hostname: "127.0.0.1", source: "config", supervised: true },
      { running: true, viable: true },
    )).toBe(false);
  });

  test("service install/start report success only after identity readiness", async () => {
    const source = await readText("src/service.ts");
    const command = source.slice(source.indexOf("export async function serviceCommand"));
    const install = command.slice(command.indexOf('case "install"'), command.indexOf('case "start"'));
    const start = command.slice(command.indexOf('case "start"'), command.indexOf('case "stop"'));

    expect(install.indexOf('confirmServiceStarted("installed")')).toBeLessThan(install.indexOf("installed + started"));
    expect(start.indexOf('confirmServiceStarted("started")')).toBeLessThan(start.indexOf("✅ service started"));
    expect(start).toContain("ops.prepareStart?.()");
    expect(start).toContain("return false");
  });

  test("service stop gate never permits config teardown after an unsafe stop", async () => {
    const calls: string[] = [];
    const managerFailure = await runServiceStopGate({
      stopManager: () => { calls.push("manager"); throw new Error("unknown manager state"); },
      stopProxy: () => { calls.push("proxy"); return true; },
    });
    if (managerFailure.safeToTeardown) calls.push("teardown");
    expect(managerFailure.phase).toBe("manager-unsafe");
    expect(calls).toEqual(["manager"]);

    calls.length = 0;
    const proxyFailure = await runServiceStopGate({
      stopManager: () => { calls.push("manager"); },
      stopProxy: () => { calls.push("proxy"); return false; },
    });
    if (proxyFailure.safeToTeardown) calls.push("teardown");
    expect(proxyFailure.phase).toBe("proxy-unsafe");
    expect(calls).toEqual(["manager", "proxy"]);
  });
});

describe("systemd service unit", () => {
  test("bare service command defaults to the install/update/start path", async () => {
    expect(normalizeServiceSubcommand()).toBe("install");
    expect(normalizeServiceSubcommand("start")).toBe("start");
    expect(normalizeServiceSubcommand("nope")).toBe("nope");

    const service = await readText("src/service.ts");
    const serviceCommand = service.slice(service.indexOf("export async function serviceCommand"));
    // Args flow through parseServiceArgs (which applies the install default) into the switch.
    expect(serviceCommand).toContain("const parsed = parseServiceArgs(");
    expect(serviceCommand).toContain("const command = parsed.sub;");
    expect(serviceCommand).toContain("switch (command)");
  });

  test("uses unquoted append targets for service logs", () => {
    const unit = buildUnit();

    expect(unit).toContain("StandardOutput=append:");
    expect(unit).toContain("StandardError=append:");
    expect(unit).not.toContain('StandardOutput="append:');
    expect(unit).not.toContain('StandardError="append:');
  });

  test("preserves custom Codex and OpenCodex homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.OPENCODEX_HOME = "/tmp/opencodex-home";
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const unit = buildUnit();
      expect(unit).toContain('Environment="CODEX_HOME=/tmp/codex-home"');
      expect(unit).toContain('Environment="OPENCODEX_HOME=/tmp/opencodex-home"');
      expectTextToContainPath(unit, serviceApiTokenFilePath());
      expect(unit).not.toContain("local-secret");
      expect(unit).not.toContain("Environment=\"OPENCODEX_API_AUTH_TOKEN=");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  test("service start checks for the systemd user unit before shelling out", async () => {
    const service = await readText("src/service.ts");
    const installSystemd = service.slice(service.indexOf("function installSystemd()"), service.indexOf("function startSystemd()"));
    const startSystemd = service.slice(service.indexOf("function startSystemd()"), service.indexOf("function stopSystemd()"));

    const unitCheckAt = startSystemd.indexOf("existsSync(unitPath())");
    const startAt = startSystemd.indexOf("systemctl --user start");
    expect(unitCheckAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(unitCheckAt).toBeLessThan(startAt);
    expect(startSystemd).toContain("ocx service install");
    expect(startSystemd).toContain("process.exit(1)");

    const writeAt = installSystemd.indexOf('writeFileSync(unitPath(), buildUnit(), "utf8")');
    const reloadAt = installSystemd.indexOf("systemctl --user daemon-reload");
    const enableAt = installSystemd.indexOf("systemctl --user enable");
    const restartAt = installSystemd.indexOf("systemctl --user restart");
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(reloadAt);
    expect(reloadAt).toBeLessThan(enableAt);
    expect(enableAt).toBeLessThan(restartAt);
    expect(installSystemd).not.toContain("ocx service install");
    expect(installSystemd).not.toContain("process.exit(1)");
  });
});

describe("service install auth preflight", () => {
  test("rejects non-loopback service install without a persisted API token", () => {
    if (existsSync(TEST_DIR)) removeTempDir(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({
      port: 10100,
      hostname: "0.0.0.0",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
      defaultProvider: "openai",
    } as OcxConfig);

    expect(() => assertServiceAuthEnvironment()).toThrow("OPENCODEX_API_AUTH_TOKEN");
  });

  test("allows non-loopback service install when the API token is in the service environment", () => {
    if (existsSync(TEST_DIR)) removeTempDir(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      port: 10100,
      hostname: "0.0.0.0",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
      defaultProvider: "openai",
    } as OcxConfig);

    expect(() => assertServiceAuthEnvironment()).not.toThrow();
  });

  test("rejects restore operations from a different CODEX_HOME than service install", () => {
    if (existsSync(TEST_DIR)) removeTempDir(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = "/tmp/current-codex-home";
    writeFileSync(join(TEST_DIR, "service-state.json"), JSON.stringify({
      version: 1,
      codexHome: "/tmp/installed-codex-home",
      opencodexHome: TEST_DIR,
    }) + "\n");

    expect(() => assertServiceEnvironmentMatchesInstall()).toThrow("Service was installed with CODEX_HOME");
  });
});

describe("Windows service task", () => {
  test("builds schtasks create args from XML instead of runtime flags", () => {
    const script = "C:\\Users\\a&b\\.opencodex\\opencodex-service.cmd";
    const args = buildWindowsSchtasksCreateArgs(script);

    expect(args).toContain("/create");
    expect(args).toContain("/xml");
    expect(args[args.indexOf("/xml") + 1]).toBe(`${script}.xml`);
    expect(args).not.toContain("/tr");
    expect(args).not.toContain("/sc");
    expect(args).not.toContain("/du");
    expect(args).not.toContain("/rl");
    expect(args).not.toContain("highest");
    expect(args.join(" ")).toContain("a&b");
  });

  test("builds service-like Task Scheduler XML settings", () => {
    const script = "C:\\Users\\a&b\\.opencodex\\opencodex-service.cmd";
    const launcher = "C:\\Users\\a&b\\.opencodex\\opencodex-service-launcher.vbs";
    const xml = buildWindowsTaskXml(script, launcher);

    expect(xml).toContain('<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>3</Count>");
    // The action is wscript running the hidden VBS launcher, never the console batch directly.
    expect(xml).toMatch(/<Command>.*wscript\.exe<\/Command>/);
    expect(xml).toContain('<Arguments>/b /nologo &quot;C:\\Users\\a&amp;b\\.opencodex\\opencodex-service-launcher.vbs&quot;</Arguments>');
    expect(xml).not.toContain("<Command>C:\\Users\\a&amp;b\\.opencodex\\opencodex-service.cmd</Command>");
  });

  test("validates the registered scheduler action, trigger, principal, and settings", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher).replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
    for (const mutated of [
      xml.replace("<LogonTrigger>", "<BootTrigger>"),
      xml.replace("InteractiveToken", "Password"),
      xml.replace("LeastPrivilege", "HighestAvailable"),
      xml.replace("IgnoreNew", "Parallel"),
      xml.replace(wscript, "C:\\Windows\\System32\\cmd.exe"),
      xml.replace(launcher, "C:\\Temp\\foreign.vbs"),
    ]) expect(windowsTaskRegistrationHealthy(mutated, wscript, launcher)).toBe(false);
  });

  // --- #432: Task Scheduler omits schema defaults when exporting ---------------

  test("accepts canonicalized scheduler XML with omitted defaults", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // Windows drops elements equal to their schema default when it exports a task:
    // Trigger/Settings Enabled default to true and RunLevel defaults to LeastPrivilege.
    const canonical = xml
      .replace("<LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>", "<LogonTrigger />")
      .replace("    <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Hidden>");
    expect(canonical).toContain("<LogonTrigger />");
    expect(canonical).not.toContain("RunLevel");

    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
    expect(readWindowsSchedulerXmlState(canonical, wscript, launcher)).toMatchObject({
      installed: true,
      enabled: true,
      registrationHealthy: true,
    });
  });

  // --- #608: Task Scheduler canonicalizes escaped text when exporting ---------

  test("accepts an export whose Arguments quotes were canonicalized", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // We write `&quot;`; Task Scheduler hands the same value back with literal
    // quotes. Comparing encodings made a healthy task read as stale forever.
    const canonical = xml.replace(
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
      `<Arguments>/b /nologo "${launcher}"</Arguments>`,
    );
    expect(canonical).toContain(`<Arguments>/b /nologo "${launcher}"</Arguments>`);
    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
    // The escaped form we emit must keep working too.
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
  });

  test("accepts a canonicalized export whose launcher path contains an ampersand", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\a&b\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // `&` stays `&amp;` (it must, or the XML is malformed); only the quotes flip.
    const canonical = xml.replace(
      "<Arguments>/b /nologo &quot;C:\\Users\\a&amp;b\\.opencodex\\service-launcher.vbs&quot;</Arguments>",
      "<Arguments>/b /nologo \"C:\\Users\\a&amp;b\\.opencodex\\service-launcher.vbs\"</Arguments>",
    );
    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
  });

  test("the canonicalization tolerance does not weaken the launcher check", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const canonicalArgs = `<Arguments>/b /nologo "${launcher}"</Arguments>`;
    const canonical = xml.replace(
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
      canonicalArgs,
    );

    for (const [reason, mutated] of [
      // A foreign launcher must still be refused in the canonical shape.
      ["foreign launcher", canonical.replace(launcher, "C:\\Temp\\foreign.vbs")],
      // A foreign interpreter, likewise.
      ["foreign command", canonical.replace(wscript, "C:\\Windows\\System32\\cmd.exe")],
      // Decoding twice would accept this; we decode once.
      ["double-encoded quotes", xml.replace(
        `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
        `<Arguments>/b /nologo &amp;quot;${launcher}&amp;quot;</Arguments>`,
      )],
      // Absence is not a schema default here — it means nothing runs.
      ["missing Arguments", canonical.replace(canonicalArgs, "")],
      // Two elements make "which one runs?" ambiguous.
      ["duplicate Arguments", canonical.replace(canonicalArgs, `${canonicalArgs}${canonicalArgs}`)],
      // A namespace-prefixed element must not read as absent.
      ["prefixed Arguments", canonical.replace("<Arguments>", "<t:Arguments>").replace("</Arguments>", "</t:Arguments>")],
    ] as const) {
      expect(windowsTaskRegistrationHealthy(mutated, wscript, launcher), reason).toBe(false);
    }
  });

  test("rejects explicit unsafe values even though defaults may be omitted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // Trigger disabled explicitly.
    expect(windowsTaskRegistrationHealthy(
      xml.replace("<LogonTrigger>\n      <Enabled>true</Enabled>", "<LogonTrigger>\n      <Enabled>false</Enabled>"),
      wscript,
      launcher,
    )).toBe(false);
    // Settings disabled explicitly.
    const settingsDisabled = xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>");
    expect(windowsTaskRegistrationHealthy(settingsDisabled, wscript, launcher)).toBe(false);
    expect(readWindowsSchedulerXmlState(settingsDisabled, wscript, launcher).enabled).toBe(false);
  });

  test("a decoy trigger outside Triggers does not satisfy the logon requirement", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const bootOnly = xml.replace("<LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>", "<BootTrigger />");

    // The schema allows arbitrary XML under Task/Data, and comments could smuggle a
    // decoy too — neither may stand in for a real logon trigger.
    for (const decoyed of [
      bootOnly.replace("<Triggers>", "<Data><LogonTrigger /></Data>\n  <Triggers>"),
      bootOnly.replace("<Triggers>", "<!-- <LogonTrigger /> -->\n  <Triggers>"),
    ]) expect(windowsTaskRegistrationHealthy(decoyed, wscript, launcher)).toBe(false);
  });

  test("namespace-prefixed values are not mistaken for omissions", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // A prefixed element carries a real value; reading it as "absent, use the
    // default" would turn an explicitly disabled or elevated task into a healthy one.
    for (const prefixed of [
      xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <t:Enabled>false</t:Enabled>\n    <Hidden>"),
      xml.replace("<RunLevel>LeastPrivilege</RunLevel>", "<t:RunLevel>HighestAvailable</t:RunLevel>"),
    ]) expect(windowsTaskRegistrationHealthy(prefixed, wscript, launcher)).toBe(false);
  });

  test("a Data block disqualifies the registration", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // taskXmlSection() takes the first match, so a Data block placed ahead of the
    // real sections could shadow them. We never emit Data, prefixed or not.
    const shadowedSettings = xml
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")
      .replace("<Triggers>", "<Data><Settings><Enabled>true</Enabled></Settings></Data>\n  <Triggers>");
    const shadowedPrincipal = xml
      .replace("LeastPrivilege", "HighestAvailable")
      .replace("<Triggers>", "<Data><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Data>\n  <Triggers>");
    const prefixedData = xml
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")
      .replace("<Triggers>", "<t:Data><Settings><Enabled>true</Enabled></Settings></t:Data>\n  <Triggers>");

    for (const shadowed of [shadowedSettings, shadowedPrincipal, prefixedData]) {
      expect(windowsTaskRegistrationHealthy(shadowed, wscript, launcher)).toBe(false);
      expect(readWindowsSchedulerXmlState(shadowed, wscript, launcher).enabled).toBe(false);
    }
  });

  test("duplicate elements are not trusted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const duplicated = xml.replace(
      "    <Enabled>true</Enabled>\n    <Hidden>",
      "    <Enabled>true</Enabled>\n    <Enabled>false</Enabled>\n    <Hidden>",
    );
    expect(windowsTaskRegistrationHealthy(duplicated, wscript, launcher)).toBe(false);
  });

  test("hidden launcher VBS stays resident and escapes quotes in the wrapper path", () => {
    const vbs = buildWindowsLauncherVbs('C:\\Users\\quo"te\\.opencodex\\opencodex-service.cmd');

    // windowStyle 0 (hidden) + bWaitOnReturn True (resident, so IgnoreNew and /end keep working).
    expect(vbs).toContain(", 0, True");
    expect(vbs).toContain('shell.Run """C:\\Users\\quo""te\\.opencodex\\opencodex-service.cmd""", 0, True');
    expect(vbs).toContain('CreateObject("WScript.Shell")');
  });

  test("hidden launcher VBS carries non-ASCII profile paths verbatim", () => {
    const vbs = buildWindowsLauncherVbs("C:\\Users\\한글사용자\\.opencodex\\opencodex-service.cmd");

    expect(vbs).toContain("C:\\Users\\한글사용자\\.opencodex\\opencodex-service.cmd");
  });

  test("writes the launcher VBS with a UTF-16 BOM so non-ASCII paths survive WSH decoding", async () => {
    const service = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();

    expect(service).toContain('writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le")');
    // Uninstall must clean the launcher asset alongside the script and task XML.
    expect(service).toContain("if (existsSync(windowsLauncherVbsPath())) unlinkSync(windowsLauncherVbsPath());");
  });

  test("writes Task Scheduler XML with a UTF-16 BOM for schtasks", async () => {
    const service = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();

    expect(service).toContain('writeServiceAssetWithRetry(windowsTaskXmlPath(), `\\uFEFF${buildWindowsTaskXml(script)}`, "utf16le")');
  });

  test("escapes environment values that would break out of set quotes", () => {
    const oldPath = process.env.PATH;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.PATH = 'C:\\safe" & echo PWNED & rem "';
      process.env.OPENCODEX_HOME = 'C:\\ocx" & del C:\\important & rem "';
      process.env.OPENCODEX_API_AUTH_TOKEN = 'token" & echo LEAK & rem "';
      const script = buildWindowsServiceScript();
      expect(script).toContain('set "PATH=C:\\safe & echo PWNED & rem "');
      expect(script).toContain('set "OPENCODEX_HOME=C:\\ocx & del C:\\important & rem "');
      expect(script).toContain('set "OCX_API_TOKEN_FILE=');
      expect(script).toContain('set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"');
      expect(script).not.toContain('set "PATH=C:\\safe" & echo PWNED');
      expect(script).not.toContain('set "OPENCODEX_HOME=C:\\ocx" & del');
      expect(script).not.toContain("token & echo LEAK");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  test("escapes service executable paths through variables", () => {
    const script = buildWindowsServiceScript({
      bun: "C:\\Bun&Dir\\100%bun^\\bun.exe",
      cli: "C:\\OpenCodex&Dir\\cli.ts",
    });

    expect(script).toContain('set "OCX_BUN=C:\\Bun&Dir\\100%%bun^^\\bun.exe"');
    expect(script).toContain('set "OCX_CLI=C:\\OpenCodex&Dir\\cli.ts"');
    expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start >>');
    expect(script).not.toContain('"%OCX_BUN%" "%OCX_CLI%" start --port');
    expect(script).not.toContain('"C:\\Bun&Dir\\100%bun^\\bun.exe"');
  });

  test("switches the wrapper console to UTF-8 and sleeps via ping (timeout dies without console stdin)", () => {
    const script = buildWindowsServiceScript({ bun: "C:\\OpenCodex\\bun.exe", cli: "C:\\OpenCodex\\cli.ts" });

    expect(script).toContain("chcp 65001 >nul");
    expect(script.indexOf("chcp 65001 >nul")).toBeLessThan(script.indexOf('set "OCX_SERVICE=1"'));
    expect(script).toContain("ping -n 6 127.0.0.1 >nul");
    expect(script).not.toContain("timeout /t");
  });

  test("rewrites profile-relative paths to env indirection so non-ASCII usernames survive OEM-codepage batch parsing", () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldAppData = process.env.APPDATA;
    try {
      process.env.USERPROFILE = "C:\\Users\\한글사용자";
      process.env.APPDATA = "C:\\Users\\한글사용자\\AppData\\Roaming";
      const script = buildWindowsServiceScript({
        bun: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
        cli: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\opencodex\\src\\cli.ts",
      });

      expect(script).toContain('set "OCX_BUN=%APPDATA%\\npm\\node_modules\\bun\\bin\\bun.exe"');
      expect(script).toContain('set "OCX_CLI=%APPDATA%\\npm\\node_modules\\opencodex\\src\\cli.ts"');
      expect(script).not.toContain('set "OCX_BUN=C:\\Users\\한글사용자');
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
    }
  });

  test("writes token-safe startup identity and child output to the service log", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "C:\\codex-home";
      process.env.OPENCODEX_HOME = TEST_DIR;
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const script = buildWindowsServiceScript({
        bun: "C:\\OpenCodex\\bun.exe",
        cli: "C:\\OpenCodex\\cli.ts",
      });

      expectTextToContainPath(script, serviceLogPath());
      expect(script).toContain('set "OCX_SERVICE_LOG=');
      expect(script).toContain("opencodex service wrapper start");
      expect(script).toContain('echo bun="%OCX_BUN%"');
      expect(script).toContain('echo bun_source="');
      expect(script).toContain('echo cli="%OCX_CLI%"');
      expect(script).toContain('echo opencodex_home="%OPENCODEX_HOME%"');
      expect(script).toContain('echo codex_home="%CODEX_HOME%"');
      expect(script).toContain('echo token_file="%OCX_API_TOKEN_FILE%"');
      expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start >>"%OCX_SERVICE_LOG%" 2>&1');
      expect(script).toContain("child exited with code %ERRORLEVEL%");
      expect(script).not.toContain("local-secret");
      expect(script).not.toContain('set "OPENCODEX_API_AUTH_TOKEN=');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("launchd service plist", () => {
  test("preserves custom Codex and OpenCodex homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.OPENCODEX_HOME = "/tmp/opencodex-home";
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const plist = buildPlist();
      expect(plist).toContain("<key>CODEX_HOME</key><string>/tmp/codex-home</string>");
      expect(plist).toContain("<key>OPENCODEX_HOME</key><string>/tmp/opencodex-home</string>");
      expectTextToContainPath(plist, serviceApiTokenFilePath());
      expect(plist).not.toContain("local-secret");
      expect(plist).not.toContain("<key>OPENCODEX_API_AUTH_TOKEN</key>");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("service lifecycle cleanup ordering", () => {
  test("direct service stop kills the tracked proxy before restoring native Codex", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));
    const safeStop = service.slice(
      service.indexOf("async function stopServiceCommandSafely"),
      service.indexOf("export interface ParsedServiceArgs"),
    );

    expect(stopCase).toContain("await stopServiceCommandSafely()");
    expect(safeStop).toContain("stopServiceIfInstalled()");
    expect(safeStop).toContain("await stopTrackedProxyForServiceCommand()");
    expect(stopCase).toContain("restoreNativeCodex();");
    expect(safeStop.indexOf("stopServiceIfInstalled()")).toBeLessThan(safeStop.indexOf("stopTrackedProxyForServiceCommand()"));
    expect(stopCase.indexOf("stopServiceCommandSafely()")).toBeLessThan(stopCase.indexOf("restoreNativeCodex();"));
  });

  test("direct service uninstall kills the tracked proxy before deleting service assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallCase = service.slice(service.indexOf('case "uninstall":'), service.indexOf("default:"));

    expect(uninstallCase).toContain("await stopServiceCommandSafely()");
    expect(uninstallCase).toContain("ops.uninstall();");
    expect(uninstallCase).toContain("restoreNativeCodex();");
    expect(uninstallCase.indexOf("stopServiceCommandSafely()")).toBeLessThan(uninstallCase.indexOf("ops.uninstall();"));
    expect(uninstallCase.indexOf("ops.uninstall();")).toBeLessThan(uninstallCase.indexOf("restoreNativeCodex();"));
  });

  test("Windows service install ends the running task before rewriting its assets, with write retry", async () => {
    const service = await readText("src/service.ts");
    const installWindows = service.slice(service.indexOf("function installWindows()"), service.indexOf("function startWindows()"));

    const stopAt = installWindows.indexOf("stopWindows();");
    const scriptWriteAt = installWindows.indexOf("writeServiceAssetWithRetry(script");
    const xmlWriteAt = installWindows.indexOf("writeServiceAssetWithRetry(windowsTaskXmlPath()");
    expect(stopAt).toBeGreaterThan(-1);
    expect(scriptWriteAt).toBeGreaterThan(-1);
    expect(xmlWriteAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(scriptWriteAt);
    expect(scriptWriteAt).toBeLessThan(xmlWriteAt);
    expect(installWindows).not.toContain("writeFileSync(script");
    // Retry helper tolerates transient Windows file locks from the just-ended task.
    expect(service).toContain('code !== "EBUSY" && code !== "EPERM" && code !== "EACCES"');
  });

  test("Windows service uninstall removes generated task XML", async () => {
    const service = await readText("src/service.ts");
    const uninstallWindows = service.slice(service.indexOf("function uninstallWindows()"), service.indexOf("function serviceDiagnosticsSummary()"));

    expect(uninstallWindows).toContain("windowsServiceScriptPath()");
    expect(uninstallWindows).toContain("windowsTaskXmlPath()");
    expect(uninstallWindows).toContain("unlinkSync(windowsTaskXmlPath())");
  });

  test("service cleanup stops gracefully first via the shared stopper and clears the pid file", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain('import { expandUserPath, getConfigDir, readPid, removePid, removeRuntimePort } from "./config";');
    expect(service).toContain("removeRuntimePort(pid);");
    expect(service).toContain('import { isProcessAlive, stopProxy } from "./lib/process-control";');
    expect(service).toContain('type TrackedProxyCleanupResult = "none" | "stale" | "stopped" | "failed";');
    expect(service).toContain("async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult>");
    expect(service).toContain("const live = await findLiveProxy()");
    expect(service).toContain("if (!live) return \"none\"");
    expect(service).toContain("if (!isProcessAlive(pid))");
    expect(service).toContain('return "stale";');
    expect(service).toContain("await stopProxy(pid);");
    expect(service).toContain("removePid(pid);");
    expect(service).toContain('return "stopped";');
  });

  test("service command cleanup blocks restore/delete after a proxy-stop failure", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("async function stopTrackedProxyForServiceCommand(): Promise<TrackedProxyCleanupResult>");
    expect(service).toContain("catch (err)");
    expect(service).toContain("Failed to stop proxy");
    expect(service).toContain('return "failed";');
    const safeStop = service.slice(
      service.indexOf("async function stopServiceCommandSafely"),
      service.indexOf("export interface ParsedServiceArgs"),
    );
    expect(safeStop).toContain('!== "failed"');
    expect(safeStop).toContain("return false");
  });
});

describe("service diagnostics", () => {
  // deriveWindowsServiceDiagnostic now reads the registration XML itself, so these
  // helpers express the old boolean fixtures as the documents that produce them.
  // buildWindowsTaskXml() emits exactly the Command/Arguments the validator expects
  // when both use the same defaults, so the fixture leaves the launcher default alone.
  const healthyTaskXml = () => buildWindowsTaskXml();
  /** Registered but reporting an explicitly disabled task. */
  const disabledTaskXml = () => healthyTaskXml()
    .replace("<Enabled>true</Enabled>\n    <Hidden>", "<Enabled>false</Enabled>\n    <Hidden>");

  const base = {
    schedulerXml: "",
    schedulerAssetsPresent: true,
    schedulerRunning: false,
    nativeStatus: "nonexistent" as const,
    recordedBackend: null,
    staleBakedPaths: false,
    nativeRepairAssetsOnly: false,
    diagnostics: "logs: test",
  };
  const installedEnabled = { schedulerXml: healthyTaskXml() };
  const installedDisabled = { schedulerXml: disabledTaskXml() };

  test("manager stop requires known non-running state before teardown", () => {
    let stopCalls = 0;
    expect(() => stopManagerWithVerification({
      label: "test manager",
      installed: true,
      runtimeState: () => "unknown",
      stop: () => { stopCalls += 1; },
      attempts: 1,
      intervalMs: 0,
    })).toThrow("runtime state is unknown");
    expect(stopCalls).toBe(0);

    let runtimeCalls = 0;
    expect(() => stopManagerWithVerification({
      label: "test manager",
      installed: true,
      runtimeState: () => (++runtimeCalls === 1 ? "running" : "running"),
      stop: () => { throw new Error("manager command failed"); },
      attempts: 1,
      intervalMs: 0,
    })).toThrow("did not reach a proven non-running state");

    runtimeCalls = 0;
    expect(stopManagerWithVerification({
      label: "test manager",
      installed: true,
      runtimeState: () => (++runtimeCalls === 1 ? "running" : "stopped"),
      stop: () => { throw new Error("manager command raced with shutdown"); },
      attempts: 1,
      intervalMs: 0,
    })).toBe(true);
  });

  test("unknown Task Scheduler query is possibly installed but unstartable", () => {
    expect(deriveWindowsServiceDiagnostic({
      ...base,
      schedulerQueryStatus: "unknown",
      schedulerQueryDetail: "RPC unavailable",
      recordedBackend: "scheduler",
    })).toMatchObject({
      installed: true,
      enabled: false,
      running: false,
      viable: false,
      startable: false,
      stale: true,
      backend: "scheduler",
      summary: expect.stringContaining("status unknown"),
    });

    expect(deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      schedulerRuntimeStatus: "unknown",
      recordedBackend: "scheduler",
    })).toMatchObject({
      installed: true,
      running: false,
      viable: false,
      startable: false,
      stale: true,
      summary: expect.stringContaining("runtime status unknown"),
    });
  });

  test("fails closed for disabled, stale, conflicting, stopped, and ghost Windows services", () => {
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, recordedBackend: "scheduler" })).toMatchObject({
      enabled: true,
      running: false,
      viable: false,
      startable: true,
      backend: "scheduler",
    });
    expect(deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      schedulerRunning: true,
      recordedBackend: "scheduler",
    })).toMatchObject({ enabled: true, running: true, viable: true, startable: true, backend: "scheduler" });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedDisabled })).toMatchObject({ viable: false, enabled: false });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, staleBakedPaths: true })).toMatchObject({ viable: false, stale: true });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, nativeStatus: "started" })).toMatchObject({ viable: false, conflict: true });
    expect(deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "stopped" })).toMatchObject({ installed: true, viable: false, startable: false, stale: true, running: false });
    expect(deriveWindowsServiceDiagnostic({ ...base, nativeRepairAssetsOnly: true })).toMatchObject({ installed: false, viable: false, stale: true });
  });

  test("an enabled scheduler with an unrelated direct proxy is startable but not running", async () => {
    // COM state 3 is READY: the task is enabled but has no running task instance.
    // A separate direct proxy may be healthy, but it is deliberately not service evidence.
    const directProxy = { pid: 4242, identityHealthy: true };
    expect(directProxy.identityHealthy).toBe(true);
    expect(parseWindowsSchedulerRuntimeState("3")).toBe("not-running");
    const scheduler = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      schedulerRunning: parseWindowsSchedulerRuntimeState("3") === "running",
      recordedBackend: "scheduler",
    });
    expect(scheduler).toMatchObject({ enabled: true, running: false, viable: false, startable: true });

    const source = await readText("src/service.ts");
    const windowsBranch = source.slice(
      source.indexOf('if (process.platform === "win32")', source.indexOf("export function diagnoseService")),
      source.indexOf('if (process.platform === "linux")', source.indexOf("export function diagnoseService")),
    );
    expect(windowsBranch).toContain("const schedulerRuntimeStatus =");
    expect(windowsBranch).toContain("? windowsSchedulerRuntimeState()");
    expect(windowsBranch).toContain('schedulerRuntimeStatus === "running"');
    expect(windowsBranch).not.toContain("schedulerRunning: readPid()");
  });

  test("parses locale-independent Task Scheduler COM states conservatively", () => {
    expect(parseWindowsSchedulerRuntimeState("4\r\n")).toBe("running");
    for (const state of ["1", "2", "3"]) {
      expect(parseWindowsSchedulerRuntimeState(state)).toBe("not-running");
    }
    expect(parseWindowsSchedulerRuntimeState("0")).toBe("unknown");
    expect(parseWindowsSchedulerRuntimeState("Running")).toBe("unknown");
    expect(parseWindowsSchedulerRuntimeState("")).toBe("unknown");
  });

  test("a stopped healthy WinSW service remains startable from the tray", () => {
    const stoppedNative = deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "stopped", recordedBackend: "native" });
    expect(serviceStartableFromTray(stoppedNative)).toBe(true);
    expect(serviceStartableFromTray({ ...stoppedNative, stale: true })).toBe(false);
    expect(serviceStartableFromTray({ ...stoppedNative, conflict: true })).toBe(false);
    expect(serviceStartableFromTray(deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "unknown" }))).toBe(false);
    const disabledScheduler = deriveWindowsServiceDiagnostic({ ...base, ...installedDisabled });
    expect(serviceStartableFromTray(disabledScheduler)).toBe(false);
    const mismatchedScheduler = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      recordedBackend: "native",
    });
    expect(mismatchedScheduler).toMatchObject({ backend: "scheduler", stale: true, viable: false, startable: false });
  });

  test("rejects malformed service backend state instead of defaulting it to scheduler", () => {
    const valid = {
      version: 2,
      codexHome: "C:\\codex",
      opencodexHome: "C:\\opencodex",
      backend: "scheduler",
    };
    expect(parseServiceInstallState(valid)?.backend).toBe("scheduler");
    expect(parseServiceInstallState({ ...valid, backend: "garbage" })).toBeNull();
    expect(parseServiceInstallState({ ...valid, backend: undefined })).toBeNull();
    expect(parseServiceInstallState({ ...valid, version: 1, backend: "scheduler" })).toBeNull();
    expect(parseServiceInstallState({ ...valid, version: 1, backend: undefined })?.version).toBe(1);
  });

  test("status summary exposes the service log path", () => {
    const summary = serviceStatusSummary();

    expectTextToContainPath(summary, serviceLogPath());
  });

  test("flags stale baked service paths recorded at install time", () => {
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const stateDir = join(TEST_DIR, "baked-paths-home");
    try {
      process.env.OPENCODEX_HOME = stateDir;
      mkdirSync(stateDir, { recursive: true });
      const statePath = join(stateDir, "service-state.json");

      const missing = join(stateDir, "gone", "bun");
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        codexHome: stateDir,
        opencodexHome: stateDir,
        bunPath: missing,
        cliPath: join(import.meta.dir, "service.test.ts"),
      }), "utf8");
      const diagnostic = bakedServicePathsDiagnostic();
      expect(diagnostic).toContain("STALE baked paths");
      expect(diagnostic).toContain(missing);

      writeFileSync(statePath, JSON.stringify({
        version: 1,
        codexHome: stateDir,
        opencodexHome: stateDir,
        bunPath: join(import.meta.dir, "service.test.ts"),
        cliPath: join(import.meta.dir, "service.test.ts"),
      }), "utf8");
      expect(bakedServicePathsDiagnostic()).toBeNull();

      // Pre-loop-3 state files without baked paths stay silent.
      writeFileSync(statePath, JSON.stringify({ version: 1, codexHome: stateDir, opencodexHome: stateDir }), "utf8");
      expect(bakedServicePathsDiagnostic()).toBeNull();
    } finally {
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
    }
  });

  test("direct service status prints the diagnostics line", async () => {
    const service = await readText("src/service.ts");
    const statusCase = service.slice(service.indexOf('case "status":'), service.indexOf('case "uninstall":'));

    expect(statusCase).toContain("Diagnostics:");
    expect(statusCase).toContain("serviceDiagnosticsSummary()");
  });
});
