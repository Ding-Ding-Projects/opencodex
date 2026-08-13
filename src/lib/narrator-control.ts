/**
 * Shared narrator rules behind `ocx narrator` (CLI) and `/api/narrator/*`
 * (dashboard): one implementation of the bounds and of what counts as a
 * speakable utterance, so the two surfaces cannot disagree about it.
 *
 * The same reasoning as `host-control.ts`. The authority still lives where the
 * work happens — `narrator-tts.ts` owns the Edge client, its pins and its own
 * final clamp — and everything here mirrors those rules *early*, so the CLI can
 * refuse a 900-character line with a sentence a person can act on instead of
 * shipping it across the network to collect a 413. Duplicating the numbers in
 * the CLI would have worked exactly until one of them moved.
 *
 * `EDGE_TEXT_MAX` is imported rather than restated for the same reason: there is
 * one cap, and it is the one the synthesiser actually enforces.
 *
 * ## Local voices are a different set from the dashboard's
 *
 * `listLocalNarratorVoices` enumerates the operating system's SAPI voices. The
 * dashboard's picker reads `speechSynthesis.getVoices()`, which is the browser's
 * view of roughly the same registry — usually the same names, but not a promise
 * of it, and the browser may add or withhold entries this cannot see. Every
 * caller must present this as "the voices this computer reports", never as "what
 * the dashboard will offer you".
 */

import { execFileSync } from "node:child_process";

import { EDGE_TEXT_MAX } from "../server/management/narrator-tts";

/**
 * Rate and pitch bounds, matching the dashboard's own sliders.
 *
 * Below 0.5 or above 2 the delivery stops being a voice and starts being a
 * novelty, so both surfaces clamp rather than reject: a request outside the
 * range is a bug in the caller, not something to make the user re-type.
 */
export const NARRATOR_MULTIPLIER_MIN = 0.5;
export const NARRATOR_MULTIPLIER_MAX = 2;

/** A rate/pitch multiplier (1 = the voice's own normal delivery), bounded. */
export function clampNarratorMultiplier(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.min(NARRATOR_MULTIPLIER_MAX, Math.max(NARRATOR_MULTIPLIER_MIN, n))
    : 1;
}

export interface NarratorSpeechInput {
  text?: unknown;
  voice?: unknown;
  rate?: unknown;
  pitch?: unknown;
}

export interface NarratorSpeechRequest {
  text: string;
  voice: string;
  rate: number;
  pitch: number;
}

/**
 * `reason` exists so the HTTP surface can keep its two distinct statuses (400
 * for an incomplete request, 413 for an oversized one) without this module
 * knowing anything about HTTP, and so the CLI can pick its own exit code from
 * the same distinction.
 */
export type NarratorSpeechCheck =
  | { ok: true; request: NarratorSpeechRequest }
  | { ok: false; reason: "incomplete" | "too-long"; message: string };

/**
 * Is this a request the synthesiser will accept?
 *
 * The voice name is only checked for presence here. Membership is settled
 * against the live catalogue inside `synthesizeEdgeSpeech`, which is the only
 * check that can be trusted — a name that looks plausible is not a name the
 * service carries, and that lookup is also what keeps an arbitrary string out
 * of the generated SSML.
 */
export function validateNarratorSpeech(input: NarratorSpeechInput): NarratorSpeechCheck {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const voice = typeof input.voice === "string" ? input.voice : "";
  if (!text || !voice) {
    return { ok: false, reason: "incomplete", message: "text and voice are required" };
  }
  if (text.length > EDGE_TEXT_MAX) {
    return { ok: false, reason: "too-long", message: `text exceeds ${EDGE_TEXT_MAX} characters` };
  }
  return {
    ok: true,
    request: {
      text,
      voice,
      rate: clampNarratorMultiplier(input.rate),
      pitch: clampNarratorMultiplier(input.pitch),
    },
  };
}

/* ------------------------------------------------- local platform voices -- */

/** One voice the operating system itself can speak with. */
export interface LocalNarratorVoice {
  name: string;
  /** BCP-47 as the platform reports it, e.g. `en-US`. May be empty. */
  lang: string;
  gender: string;
}

export interface LocalNarratorVoiceReport {
  /**
   * False means "this computer could not be asked", which is a different
   * sentence from an empty list and has to be reported as one — a machine with
   * no Cantonese voice and a machine we never managed to query look identical
   * otherwise, and only one of them is worth acting on.
   */
  available: boolean;
  voices: LocalNarratorVoice[];
  /** Why the list is unavailable. Scalar text; never a path or a command line. */
  reason?: string;
}

/** More voices than any real install carries; a runaway response stops here. */
const MAX_LOCAL_VOICES = 500;

/**
 * SAPI enumeration through PowerShell.
 *
 * `System.Speech` is the only route that answers this without a browser, and
 * tab-separated output is deliberate: voice names carry commas, quotes and
 * parentheses far more often than they carry tabs, so parsing this is a string
 * split rather than a JSON round trip that one odd name could break.
 */
const WINDOWS_VOICE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Add-Type -AssemblyName System.Speech",
  "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {",
  "  $info = $_.VoiceInfo",
  '  $name = ($info.Name -replace "`t"," ")',
  '  "{0}`t{1}`t{2}" -f $name, $info.Culture.Name, $info.Gender',
  "}",
].join("\n");

export interface LocalNarratorVoiceIo {
  platform?: NodeJS.Platform;
  /** Seam for tests: returns the raw tab-separated enumeration output. */
  run?: () => string;
}

function runWindowsVoiceQuery(): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_VOICE_SCRIPT],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true },
  );
}

/**
 * The voices this computer can speak with, offline and with no network contact.
 *
 * Windows only for now. On any other platform this reports `available: false`
 * with the reason rather than an empty list, because "no voices" and "we cannot
 * see them from here" must not read the same in a status line.
 */
export function listLocalNarratorVoices(io: LocalNarratorVoiceIo = {}): LocalNarratorVoiceReport {
  const platform = io.platform ?? process.platform;
  const run = io.run ?? (platform === "win32" ? runWindowsVoiceQuery : null);
  if (!run) {
    return {
      available: false,
      voices: [],
      reason: `installed voices cannot be enumerated headlessly on ${platform}; the dashboard reads them through the browser`,
    };
  }

  let output: string;
  try {
    output = run();
  } catch (error) {
    return {
      available: false,
      voices: [],
      reason: error instanceof Error ? error.message.slice(0, 200) : "the speech platform did not answer",
    };
  }

  const voices: LocalNarratorVoice[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (voices.length >= MAX_LOCAL_VOICES) break;
    const parts = line.split("\t");
    const name = (parts[0] ?? "").trim();
    if (!name) continue;
    voices.push({ name, lang: (parts[1] ?? "").trim(), gender: (parts[2] ?? "").trim() });
  }
  return { available: true, voices };
}

/**
 * Does `tag` fall under the `filter` language?
 *
 * A prefix match on the subtag boundary, so `zh` finds `zh-HK` and `zh-CN`
 * while `en` does not accidentally claim `enm`. Case-insensitive because a user
 * types `zh-hk` and the catalogue says `zh-HK`.
 */
export function matchesNarratorLanguage(tag: string, filter: string): boolean {
  const lower = tag.toLowerCase();
  const wanted = filter.toLowerCase();
  return lower === wanted || lower.startsWith(`${wanted}-`);
}
