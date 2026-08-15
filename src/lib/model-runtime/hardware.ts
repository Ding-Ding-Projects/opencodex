/**
 * Best-effort local hardware detection for the Ollama fit-verdict engine.
 *
 * Every fact here degrades to `null` rather than a guess when it cannot be
 * detected — a missing fact must widen the verdict toward `unknown`, never
 * get treated as zero (see `fit.ts`). Subprocess probes use `Bun.spawn` with
 * a manual timeout, the same shape `src/lib/windows-secret-acl.ts` documents
 * as necessary on Windows (Node's sync `execFileSync` has hung under this
 * app's GUI/proxy process even with `windowsHide`).
 */

import { totalmem, freemem } from "node:os";
import type { GpuFact, HardwareFacts } from "./types";

const PROBE_TIMEOUT_MS = 3_000;

type CaptureResult = { ok: true; stdout: string } | { ok: false };
type CaptureRunner = (cmd: string[]) => Promise<CaptureResult>;

async function defaultRunCapture(cmd: string[]): Promise<CaptureResult> {
  try {
    // Declared and used inside the same try block (rather than pre-typed via
    // `ReturnType<typeof Bun.spawn>` above it) so TypeScript keeps the literal
    // `stdout: "pipe"` narrowing — widening it loses that and admits `number`
    // into `proc.stdout`'s type, which `new Response()` below cannot accept.
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already exited */ } }, PROBE_TIMEOUT_MS);
    let exitCode: number | null = null;
    let stdout = "";
    try {
      stdout = await new Response(proc.stdout).text().catch(() => "");
      exitCode = await proc.exited;
    } catch {
      exitCode = null;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut || exitCode !== 0) return { ok: false };
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

let runCapture: CaptureRunner = defaultRunCapture;

/** Test seam: replace every subprocess probe this module makes. Pass null to restore the real `Bun.spawn`-backed default. */
export function setHardwareCaptureRunnerForTests(runner: CaptureRunner | null): void {
  runCapture = runner ?? defaultRunCapture;
}

type MemReader = { total: () => number; free: () => number };
let memReader: MemReader = { total: totalmem, free: freemem };

/** Test seam: replace the `os.totalmem`/`os.freemem` readers. Pass null to restore the real ones. */
export function setMemReaderForTests(reader: MemReader | null): void {
  memReader = reader ?? { total: totalmem, free: freemem };
}

let platformOverride: string | null = null;

/** Test seam: force `process.platform`'s read for this module (e.g. to exercise the Windows GPU/disk paths from Linux CI). Pass null to restore the real platform. */
export function setHardwarePlatformForTests(value: string | null): void {
  platformOverride = value;
}

function currentPlatform(): NodeJS.Platform {
  return (platformOverride ?? process.platform) as NodeJS.Platform;
}

/** NVIDIA's own tool — present whenever a supported NVIDIA driver is installed, on Windows and Linux alike. */
async function detectNvidiaGpus(): Promise<GpuFact[] | null> {
  const result = await runCapture(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (!result.ok) return null;
  const gpus: GpuFact[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map(p => p.trim());
    const name = parts[0];
    const memMiB = Number(parts[1]);
    if (!name) continue;
    gpus.push({
      name,
      vramBytes: Number.isFinite(memMiB) && memMiB > 0 ? Math.round(memMiB * 1024 * 1024) : null,
      source: "nvidia-smi",
      caveats: [],
    });
  }
  return gpus.length ? gpus : null;
}

interface WmiVideoController { Name?: unknown; AdapterRAM?: unknown }

/**
 * Fallback for non-NVIDIA or driver-less-nvidia-smi machines. `AdapterRAM` is
 * a documented Windows quirk: it is a 32-bit field, so many drivers report it
 * truncated (a 16-24 GiB card can read back under 4 GiB). The caveat travels
 * with the fact all the way to the UI rather than being silently corrected,
 * because there is no reliable way to tell a truncated value from a real one.
 */
async function detectWindowsGpusViaWmi(): Promise<GpuFact[] | null> {
  if (currentPlatform() !== "win32") return null;
  const script = ",(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM) | ConvertTo-Json -Compress";
  const result = await runCapture(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (!result.ok || !result.stdout.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
  const rows: WmiVideoController[] = Array.isArray(parsed) ? parsed : [parsed];
  const gpus: GpuFact[] = [];
  for (const row of rows) {
    if (typeof row?.Name !== "string" || !row.Name.trim()) continue;
    const ramRaw = typeof row.AdapterRAM === "number" ? row.AdapterRAM : null;
    // A reported value of 0 or a suspicious exact 4 GiB wrap point is common for
    // truncated 32-bit reporting; keep the value but the caveat always applies to
    // every WMI-sourced reading, not only the suspicious ones, since the field is
    // unreliable in general.
    const vramBytes = ramRaw && ramRaw > 0 ? ramRaw : null;
    gpus.push({
      name: row.Name.trim(),
      vramBytes,
      source: "windows-wmi",
      caveats: [
        "video memory as reported by Windows can be inaccurate (a known 32-bit AdapterRAM truncation affects some drivers) — treat this figure as approximate",
      ],
    });
  }
  return gpus.length ? gpus : null;
}

async function detectFreeDiskBytes(targetPath: string): Promise<number | null> {
  if (currentPlatform() === "win32") {
    const drive = targetPath.slice(0, 2).toUpperCase(); // "C:"
    if (!/^[A-Z]:$/.test(drive)) return null;
    const script = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object FreeSpace | ConvertTo-Json -Compress)`;
    const result = await runCapture(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
    if (!result.ok || !result.stdout.trim()) return null;
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { FreeSpace?: unknown };
      return typeof parsed.FreeSpace === "number" && Number.isFinite(parsed.FreeSpace) ? parsed.FreeSpace : null;
    } catch {
      return null;
    }
  }
  const result = await runCapture(["df", "-Pk", targetPath]);
  if (!result.ok) return null;
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const fields = lines[1].trim().split(/\s+/);
  const availableKb = Number(fields[3]);
  return Number.isFinite(availableKb) ? Math.round(availableKb * 1024) : null;
}

/**
 * Runs every probe concurrently and folds failures to `null`/`[]` rather than
 * throwing — a hardware-detection failure must never take down the health or
 * catalogue routes that depend on it.
 */
export async function detectHardwareFacts(): Promise<HardwareFacts> {
  const detectedAt = Date.now();
  const warnings: string[] = [];
  const homeDir = process.env.USERPROFILE || process.env.HOME || process.cwd();

  let totalRamBytes: number | null = null;
  let freeRamBytes: number | null = null;
  try {
    totalRamBytes = memReader.total();
    freeRamBytes = memReader.free();
  } catch {
    warnings.push("system memory could not be read");
  }

  const [nvidiaGpus, freeDiskBytes] = await Promise.all([
    detectNvidiaGpus().catch(() => null),
    detectFreeDiskBytes(homeDir).catch(() => null),
  ]);

  let gpus: GpuFact[] = [];
  if (nvidiaGpus) {
    gpus = nvidiaGpus;
  } else {
    const wmiGpus = await detectWindowsGpusViaWmi().catch(() => null);
    if (wmiGpus) gpus = wmiGpus;
  }
  if (!gpus.length) warnings.push("no GPU was detected; fit verdicts assume CPU-only execution unless a GPU is later found");
  if (freeDiskBytes === null) warnings.push("free disk space could not be determined on this platform");

  return {
    detectedAt,
    platform: currentPlatform(),
    totalRamBytes,
    freeRamBytes,
    gpus,
    freeDiskBytes,
    diskPath: homeDir,
    warnings,
  };
}
