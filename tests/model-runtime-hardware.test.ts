import { afterEach, describe, expect, test } from "bun:test";
import {
  detectHardwareFacts,
  setHardwareCaptureRunnerForTests,
  setHardwarePlatformForTests,
  setMemReaderForTests,
} from "../src/lib/model-runtime/hardware";

afterEach(() => {
  setHardwareCaptureRunnerForTests(null);
  setHardwarePlatformForTests(null);
  setMemReaderForTests(null);
});

describe("detectHardwareFacts — memory", () => {
  test("reads total/free RAM from the injected reader", async () => {
    setMemReaderForTests({ total: () => 32 * 1024 ** 3, free: () => 10 * 1024 ** 3 });
    setHardwareCaptureRunnerForTests(async () => ({ ok: false }));
    const facts = await detectHardwareFacts();
    expect(facts.totalRamBytes).toBe(32 * 1024 ** 3);
    expect(facts.freeRamBytes).toBe(10 * 1024 ** 3);
  });

  test("a throwing memory reader degrades to null with a warning, never throws", async () => {
    setMemReaderForTests({ total: () => { throw new Error("boom"); }, free: () => 0 });
    setHardwareCaptureRunnerForTests(async () => ({ ok: false }));
    const facts = await detectHardwareFacts();
    expect(facts.totalRamBytes).toBeNull();
    expect(facts.warnings.some(w => w.includes("memory"))).toBe(true);
  });
});

describe("detectHardwareFacts — GPU via nvidia-smi", () => {
  test("parses a real nvidia-smi CSV line", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwareCaptureRunnerForTests(async cmd => {
      if (cmd[0] === "nvidia-smi") return { ok: true, stdout: "NVIDIA GeForce RTX 4090, 24564\n" };
      return { ok: false };
    });
    const facts = await detectHardwareFacts();
    expect(facts.gpus).toHaveLength(1);
    expect(facts.gpus[0].name).toBe("NVIDIA GeForce RTX 4090");
    expect(facts.gpus[0].source).toBe("nvidia-smi");
    expect(facts.gpus[0].vramBytes).toBe(Math.round(24564 * 1024 * 1024));
    expect(facts.gpus[0].caveats).toEqual([]);
  });

  test("nvidia-smi absent (probe fails) and not on Windows → no GPU, warning recorded", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwarePlatformForTests("linux");
    setHardwareCaptureRunnerForTests(async () => ({ ok: false }));
    const facts = await detectHardwareFacts();
    expect(facts.gpus).toEqual([]);
    expect(facts.warnings.some(w => w.includes("no GPU"))).toBe(true);
  });
});

describe("detectHardwareFacts — Windows WMI GPU fallback", () => {
  test("falls back to WMI when nvidia-smi fails, and carries the accuracy caveat", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwarePlatformForTests("win32");
    setHardwareCaptureRunnerForTests(async cmd => {
      if (cmd[0] === "nvidia-smi") return { ok: false };
      if (cmd[0] === "powershell.exe" && cmd.join(" ").includes("Win32_VideoController")) {
        return { ok: true, stdout: JSON.stringify({ Name: "Intel(R) UHD Graphics", AdapterRAM: 134217728 }) };
      }
      return { ok: false };
    });
    const facts = await detectHardwareFacts();
    expect(facts.gpus).toHaveLength(1);
    expect(facts.gpus[0].source).toBe("windows-wmi");
    expect(facts.gpus[0].caveats.length).toBeGreaterThan(0);
  });

  test("WMI array response (multiple GPUs) is parsed correctly", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwarePlatformForTests("win32");
    setHardwareCaptureRunnerForTests(async cmd => {
      if (cmd[0] === "nvidia-smi") return { ok: false };
      if (cmd[0] === "powershell.exe" && cmd.join(" ").includes("Win32_VideoController")) {
        return { ok: true, stdout: JSON.stringify([{ Name: "GPU A", AdapterRAM: 1024 }, { Name: "GPU B", AdapterRAM: null }]) };
      }
      return { ok: false };
    });
    const facts = await detectHardwareFacts();
    expect(facts.gpus.map(g => g.name)).toEqual(["GPU A", "GPU B"]);
    expect(facts.gpus[1].vramBytes).toBeNull();
  });

  test("not on Windows → WMI fallback never attempted, gpus stay empty", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwarePlatformForTests("darwin");
    let calledPowershell = false;
    setHardwareCaptureRunnerForTests(async cmd => {
      if (cmd[0] === "powershell.exe") calledPowershell = true;
      return { ok: false };
    });
    const facts = await detectHardwareFacts();
    expect(facts.gpus).toEqual([]);
    expect(calledPowershell).toBe(false);
  });
});

describe("detectHardwareFacts — free disk space", () => {
  test("Windows: parses Win32_LogicalDisk FreeSpace JSON", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwarePlatformForTests("win32");
    setHardwareCaptureRunnerForTests(async cmd => {
      if (cmd[0] === "powershell.exe" && cmd.join(" ").includes("Win32_LogicalDisk")) {
        return { ok: true, stdout: JSON.stringify({ FreeSpace: 123456789 }) };
      }
      return { ok: false };
    });
    const facts = await detectHardwareFacts();
    expect(facts.freeDiskBytes).toBe(123456789);
  });

  test("POSIX: parses df -Pk output", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwarePlatformForTests("linux");
    setHardwareCaptureRunnerForTests(async cmd => {
      if (cmd[0] === "df") return { ok: true, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 100000 40000 60000 40% /\n" };
      return { ok: false };
    });
    const facts = await detectHardwareFacts();
    expect(facts.freeDiskBytes).toBe(60000 * 1024);
  });

  test("every probe failing still returns a complete, non-throwing result with warnings", async () => {
    setMemReaderForTests({ total: () => 1, free: () => 1 });
    setHardwareCaptureRunnerForTests(async () => ({ ok: false }));
    const facts = await detectHardwareFacts();
    expect(facts.freeDiskBytes).toBeNull();
    expect(facts.warnings.some(w => w.includes("disk"))).toBe(true);
  });
});
