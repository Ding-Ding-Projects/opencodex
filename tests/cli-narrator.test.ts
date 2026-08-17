/**
 * `ocx narrator` — the headless counterpart to the dashboard's voice picker.
 *
 * What these actually protect is the network boundary. Every other property of
 * this command is visible in its output; "nothing reached Microsoft" is not, and
 * a regression that quietly made the Edge source implicit would look identical
 * from the outside. So the opt-in cases assert on the recorded request list
 * being EMPTY rather than on the message alone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleNarratorCommand } from "../src/cli/narrator";
import { removeTempDir } from "./helpers/temp-dir";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

const CATALOGUE = [
  { shortName: "zh-HK-HiuMaanNeural", friendlyName: "Microsoft HiuMaan Online (Natural)", locale: "zh-HK", localeName: "Chinese (Cantonese Traditional)", gender: "Female" },
  { shortName: "zh-CN-XiaoxiaoNeural", friendlyName: "Microsoft Xiaoxiao Online (Natural)", locale: "zh-CN", localeName: "Chinese (Mandarin)", gender: "Female" },
  { shortName: "en-US-AriaNeural", friendlyName: "Microsoft Aria Online (Natural)", locale: "en-US", localeName: "English (United States)", gender: "Female" },
];

/** MP3 bytes are only ever compared for length here; the content is a marker. */
const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]);

function fakeRuntime(options: { catalogueAvailable?: boolean } = {}) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: url.pathname, method: req.method, body });
      if (url.pathname === "/api/narrator/edge-voices") {
        return options.catalogueAvailable === false
          ? Response.json({ available: false, voices: [], error: "voice list refused with HTTP 403" })
          : Response.json({ available: true, voices: CATALOGUE });
      }
      if (url.pathname === "/api/narrator/edge-speak") {
        return new Response(AUDIO, {
          headers: { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO.byteLength) },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

describe("ocx narrator", () => {
  test("listing the Edge catalogue refuses without --edge and contacts nothing", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(["voices", "--source", "edge"], runtime.deps)).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    const text = output.lines.join("\n");
    expect(text).toContain("Microsoft");
    expect(text).toContain("--edge");
  });

  test("speaking refuses without --edge and contacts nothing", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(
        ["speak", "早晨", "--voice", "zh-HK-HiuMaanNeural", "--out", "-"],
        runtime.deps,
      )).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    const refusal = output.lines.join("\n");
    expect(refusal).toContain("NETWORK source");
    expect(refusal).toContain("text you pass to Microsoft, over the internet");
    expect(refusal).toContain("Re-run with --edge to allow it.");
  });

  test("--lang filters the catalogue on the subtag boundary", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(
        ["voices", "--source", "edge", "--edge", "--lang", "zh-HK", "--json"],
        runtime.deps,
      )).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([{ path: "/api/narrator/edge-voices", method: "GET", body: null }]);
    const payload = JSON.parse(output.lines.filter(line => line.startsWith("{")).join("\n")) as {
      edge: { total: number; matched: Array<{ shortName: string }> };
    };
    expect(payload.edge.total).toBe(3);
    expect(payload.edge.matched.map(voice => voice.shortName)).toEqual(["zh-HK-HiuMaanNeural"]);
  });

  test("an unreachable catalogue is reported, not thrown", async () => {
    const runtime = fakeRuntime({ catalogueAvailable: false });
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(["voices", "--source", "edge", "--edge"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(output.lines.join("\n")).toContain("unavailable — voice list refused with HTTP 403");
  });

  test("speak posts the validated request and writes the returned audio", async () => {
    const runtime = fakeRuntime();
    const dir = mkdtempSync(join(tmpdir(), "ocx-narrator-"));
    const out = join(dir, "line.mp3");
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand([
        "speak", "  Good morning  ", "--voice", "en-US-AriaNeural", "--rate", "1.25", "--edge", "--out", out, "--json",
      ], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([{
      path: "/api/narrator/edge-speak",
      method: "POST",
      // Trimmed, and pitch defaulted by the shared validator rather than by this
      // command — the same normalisation the route applies to the dashboard.
      body: { text: "Good morning", voice: "en-US-AriaNeural", rate: 1.25, pitch: 1 },
    }]);
    expect(readFileSync(out).byteLength).toBe(AUDIO.byteLength);
    removeTempDir(dir);
  });

  test("an over-long line is refused before any network contact", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(
        ["speak", "x".repeat(601), "--voice", "en-US-AriaNeural", "--edge", "--out", "-"],
        runtime.deps,
      )).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    expect(output.lines.join("\n")).toContain("text exceeds 600 characters");
  });

  test("an out-of-range rate is refused with the bound named", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(
        ["speak", "hello", "--voice", "en-US-AriaNeural", "--rate", "9", "--edge", "--out", "-"],
        runtime.deps,
      )).toBe(2);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    expect(output.lines.join("\n")).toContain("--rate must be between 0.5 and 2");
  });

  test("status probes nothing without --edge and says where the settings live", async () => {
    const runtime = fakeRuntime();
    const output = captureStdout();
    try {
      expect(await handleNarratorCommand(["status", "--json"], runtime.deps)).toBe(0);
    } finally {
      output.restore();
    }
    expect(runtime.requests).toEqual([]);
    const payload = JSON.parse(output.lines.filter(line => line.startsWith("{")).join("\n")) as {
      edge: { allowedThisRun: boolean; probed: boolean };
      bounds: { textMaxCharacters: number };
      preferences: { readable: boolean; storedIn: string };
    };
    expect(payload.edge).toMatchObject({ allowedThisRun: false, probed: false });
    expect(payload.bounds.textMaxCharacters).toBe(600);
    expect(payload.preferences.readable).toBe(false);
    expect(payload.preferences.storedIn).toContain("ocx-m3:v1");
  });
});
