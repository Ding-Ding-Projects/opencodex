/**
 * `ocx narrator` — the headless counterpart to the dashboard's narrator voice
 * picker.
 *
 * The dashboard can list the voices this machine can speak with, list the
 * Microsoft Edge online catalogue, and speak a line through one of them. Without
 * this command none of that was reachable from a shell, which made the narrator
 * the one management surface with no headless route — and a Cantonese voice you
 * cannot enumerate over SSH is a voice you cannot pick for a machine you are not
 * sitting at.
 *
 * ## It goes through the running proxy, deliberately
 *
 * The Edge work already lives behind `/api/narrator/*`, so this calls those
 * routes rather than importing the client and speaking to Microsoft itself. Two
 * reasons, and the second is the one that matters:
 *
 * - One catalogue cache and one client identity face the undocumented endpoint,
 *   instead of a second caller with its own timing and its own retry habits.
 * - The route is where the bounds, the SSML escaping and the live catalogue
 *   membership check live. A CLI that reimplemented the client would be a second
 *   place for those to drift out of step, which is exactly what the headless
 *   parity contract exists to prevent.
 *
 * What *is* shared as code is the small part both surfaces have to agree on —
 * see `lib/narrator-control.ts` — so this can refuse an over-long line with a
 * sentence rather than shipping it across the network to collect a 413.
 *
 * ## Nothing here contacts Microsoft unless asked
 *
 * `--edge` is required by every path that reaches the network, and the refusal
 * without it *is* the disclosure: it says what would be sent and to whom. The
 * dashboard behaves the same way — its routes are only called once the user has
 * turned the Edge source on. Listing installed platform voices needs no network
 * and no flag.
 */

import { writeFileSync } from "node:fs";

import {
  NARRATOR_MULTIPLIER_MAX,
  NARRATOR_MULTIPLIER_MIN,
  listLocalNarratorVoices,
  matchesNarratorLanguage,
  validateNarratorSpeech,
  type LocalNarratorVoice,
} from "../lib/narrator-control";
import { EDGE_TEXT_MAX } from "../server/management/narrator-tts";
import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeBaseUrl,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx narrator status [--edge] [--json]
  ocx narrator voices [--source <local|edge|all>] [--lang <tag>] [--search <text>]
      [--limit <n>] [--edge] [--json]
  ocx narrator speak <text> --voice <name> --edge [--rate <n>] [--pitch <n>]
      [--out <path>|-] [--json]`;

/**
 * The whole disclosure, printed at the moment a user is about to opt in.
 *
 * Deliberately said in the refusal rather than buried in `--help`: somebody who
 * reaches for `speak` has not necessarily read the help, and this is the one
 * place where "your text leaves this machine" is still an unmade decision.
 */
const EDGE_NETWORK_NOTICE = [
  "  Microsoft Edge online voices are a NETWORK source. Speaking with one sends the",
  "  text you pass to Microsoft, over the internet, every time it speaks. Nothing is",
  "  sent while you do not ask for it, and installed platform voices stay on this",
  "  computer and need no network at all.",
  "  The service is the undocumented one Edge itself uses to read pages aloud.",
  "  Microsoft publishes no contract for it and can change or block it at any time,",
  "  so a sudden refusal is the service refusing this client rather than a fault in",
  "  the text or the voice you chose.",
].join("\n");

/**
 * Where the narrator's actual settings live.
 *
 * They are per-visitor browser state, not server state, so there is nothing here
 * to read and nothing to change. Saying so plainly beats reporting a default
 * that would be a guess about somebody else's profile.
 */
const PREFERENCE_STORE = "the dashboard's own browser profile (local storage key ocx-m3:v1)";
const PREFERENCE_SURFACE = "the dashboard, under Language & voice";
const PREFERENCE_KEYS = [
  "whether the narrator speaks at all",
  "which language it narrates",
  "the voice, rate and pitch chosen for each narrated language",
  "whether the Edge online source is switched on",
];

/**
 * Generous next to the route's own 15s synthesis timeout, on purpose: racing it
 * would replace the server's specific error ("the endpoint refused this client")
 * with this side's vague one, which sends the reader after the wrong problem.
 */
const SPEAK_TIMEOUT_MS = 30_000;
/** A narrator line is a sentence. Anything near this is not one. */
const AUDIO_BYTES_MAX = 8_000_000;

/** `takeIntegerOption`'s sibling: rate and pitch are multipliers, not integers. */
function takeNumberOption(args: string[], flag: string): number | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CliUsageError(`${flag} must be a number`, USAGE);
  if (value < NARRATOR_MULTIPLIER_MIN || value > NARRATOR_MULTIPLIER_MAX) {
    throw new CliUsageError(
      `${flag} must be between ${NARRATOR_MULTIPLIER_MIN} and ${NARRATOR_MULTIPLIER_MAX} (1 = the voice's own normal delivery)`,
      USAGE,
    );
  }
  return value;
}

function requireEdgeOptIn(allowed: boolean, action: string): void {
  if (allowed) return;
  throw new CliUsageError(
    `${action} reaches the Microsoft Edge read-aloud service, which is never used unless you ask for it.\n`
    + `${EDGE_NETWORK_NOTICE}\n`
    + "  Re-run with --edge to allow it.",
    USAGE,
  );
}

/**
 * Said before the request, not after — "says so before it does" is the whole
 * point, and stderr keeps `--json` output on stdout parseable.
 */
function announceEdgeContact(kind: "catalogue" | "speech"): void {
  console.error(
    kind === "speech"
      ? "Contacting Microsoft: the text you passed is being sent to the Edge read-aloud service."
      : "Contacting Microsoft: fetching the Edge voice catalogue. No narrated text is sent by this.",
  );
}

/* ----------------------------------------------------------------- voices -- */

/** One Edge voice exactly as `/api/narrator/edge-voices` reports it. */
interface EdgeVoiceRow {
  shortName: string;
  friendlyName: string;
  locale: string;
  localeName: string;
  gender: string;
}

interface EdgeVoicesPayload {
  available?: boolean;
  voices?: EdgeVoiceRow[];
  error?: string;
}

interface EdgeCatalogue {
  available: boolean;
  voices: EdgeVoiceRow[];
  error?: string;
}

/**
 * The route answers 200 with `available: false` when the service is unreachable
 * rather than failing the request, so an outage is a sentence to print, not an
 * error to abort on. Mirrored here so the CLI says which of the two happened.
 */
async function fetchEdgeCatalogue(deps: RuntimeApiDeps): Promise<EdgeCatalogue> {
  const payload = await runtimeRequest<EdgeVoicesPayload>("/api/narrator/edge-voices", {}, deps);
  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  return { available: payload?.available === true, voices, error: payload?.error };
}

interface VoiceFilter {
  lang?: string;
  search?: string;
  limit?: number;
}

function filterEdgeVoices(voices: EdgeVoiceRow[], filter: VoiceFilter): EdgeVoiceRow[] {
  const search = filter.search?.toLowerCase();
  const matched = voices.filter(voice => {
    if (filter.lang && !matchesNarratorLanguage(voice.locale ?? "", filter.lang)) return false;
    if (!search) return true;
    return [voice.shortName, voice.friendlyName, voice.locale, voice.localeName, voice.gender]
      .some(field => (field ?? "").toLowerCase().includes(search));
  });
  return filter.limit === undefined ? matched : matched.slice(0, filter.limit);
}

function filterLocalVoices(voices: LocalNarratorVoice[], filter: VoiceFilter): LocalNarratorVoice[] {
  const search = filter.search?.toLowerCase();
  const matched = voices.filter(voice => {
    if (filter.lang && !matchesNarratorLanguage(voice.lang ?? "", filter.lang)) return false;
    if (!search) return true;
    return [voice.name, voice.lang, voice.gender].some(field => (field ?? "").toLowerCase().includes(search));
  });
  return filter.limit === undefined ? matched : matched.slice(0, filter.limit);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function voices(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const allowNetwork = takeFlag(args, "--edge");
  const source = takeOption(args, "--source") ?? "local";
  const lang = takeOption(args, "--lang");
  const search = takeOption(args, "--search");
  const limit = takeIntegerOption(args, "--limit", { min: 1 });
  rejectArgs(args, USAGE);
  if (!["local", "edge", "all"].includes(source)) {
    throw new CliUsageError("--source must be local, edge, or all", USAGE);
  }

  const filter: VoiceFilter = { lang, search, limit };
  const wantsLocal = source === "local" || source === "all";
  const wantsEdge = source === "edge" || source === "all";
  if (wantsEdge) requireEdgeOptIn(allowNetwork, `--source ${source}`);

  const localReport = wantsLocal
    ? listLocalNarratorVoices()
    : { available: false, voices: [] as LocalNarratorVoice[], reason: "not requested" };
  const localMatches = filterLocalVoices(localReport.voices, filter);

  let edge: EdgeCatalogue | null = null;
  if (wantsEdge) {
    announceEdgeContact("catalogue");
    edge = await fetchEdgeCatalogue(deps);
  }
  const edgeMatches = edge ? filterEdgeVoices(edge.voices, filter) : [];

  if (wantsJson) {
    printData(
      {
        source,
        filter: { lang: lang ?? null, search: search ?? null, limit: limit ?? null },
        local: wantsLocal
          ? { available: localReport.available, reason: localReport.reason ?? null, total: localReport.voices.length, matched: localMatches }
          : null,
        edge: edge
          ? { available: edge.available, error: edge.error ?? null, total: edge.voices.length, matched: edgeMatches }
          : null,
      },
      true,
    );
    return;
  }

  if (wantsLocal) {
    if (!localReport.available) {
      console.log(`Installed voices: unavailable — ${localReport.reason ?? "unknown reason"}`);
    } else if (!localMatches.length) {
      console.log(`Installed voices: none matched (${localReport.voices.length} installed)`);
    } else {
      console.log(`Installed voices (${localMatches.length} of ${localReport.voices.length}):`);
      for (const voice of localMatches) {
        console.log(`  ${pad(voice.lang || "-", 8)} ${pad(voice.gender || "-", 8)} ${voice.name}`);
      }
    }
  }

  if (edge) {
    if (wantsLocal) console.log("");
    if (!edge.available) {
      // Not a failure of this command: the service is unreachable and the
      // dashboard would say the same and fall back to an installed voice.
      console.log(`Microsoft Edge online voices: unavailable — ${edge.error ?? "the service did not answer"}`);
    } else if (!edgeMatches.length) {
      console.log(`Microsoft Edge online voices: none matched (${edge.voices.length} published)`);
    } else {
      console.log(`Microsoft Edge online voices (${edgeMatches.length} of ${edge.voices.length}):`);
      for (const voice of edgeMatches) {
        console.log(`  ${pad(voice.locale || "-", 8)} ${pad(voice.gender || "-", 8)} ${pad(voice.shortName, 30)} ${voice.friendlyName}`);
      }
      console.log("\nSpeak with one:  ocx narrator speak \"...\" --voice <name> --edge --out line.mp3");
    }
  }
}

/* ------------------------------------------------------------------ speak -- */

async function speak(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const allowNetwork = takeFlag(args, "--edge");
  const voice = takeOption(args, "--voice");
  const out = takeOption(args, "--out");
  const rate = takeNumberOption(args, "--rate");
  const pitch = takeNumberOption(args, "--pitch");
  // Every option has been spliced out, so whatever survives is the positional.
  const text = args.shift();
  rejectArgs(args, USAGE);

  // Bounds first, before any network contact: an over-long line should cost a
  // sentence here rather than a round trip that ends in a 413.
  const checked = validateNarratorSpeech({ text, voice, rate, pitch });
  if (!checked.ok) throw new CliUsageError(checked.message, USAGE);
  requireEdgeOptIn(allowNetwork, "ocx narrator speak");

  const toStdout = out === "-";
  if (!out) {
    throw new CliUsageError("--out <path> is required (or --out - to write the MP3 to stdout)", USAGE);
  }
  if (toStdout && wantsJson) throw new CliUsageError("--out - writes audio to stdout, which --json also claims", USAGE);
  if (toStdout && process.stdout.isTTY) {
    throw new CliUsageError("--out - writes raw MP3 bytes; redirect it to a file or pipe it", USAGE);
  }

  announceEdgeContact("speech");

  // Its own fetch rather than `runtimeRequest`: the response is MP3, and
  // `runtimeRequest` reads every body as text, which would mangle the audio.
  const baseUrl = await runtimeBaseUrl(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/narrator/edge-speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(checked.request),
      signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RuntimeApiError(
      `Management API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      null,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let message = `synthesis failed (${response.status})`;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
    } catch { /* a non-JSON body adds nothing the status has not already said */ }
    throw new RuntimeApiError(message, response.status, null);
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AUDIO_BYTES_MAX) {
    throw new RuntimeApiError(`synthesis response exceeded its size cap (${declared} bytes)`, 502, null);
  }
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength > AUDIO_BYTES_MAX) {
    throw new RuntimeApiError(`synthesis response exceeded its size cap (${audio.byteLength} bytes)`, 502, null);
  }

  if (toStdout) {
    process.stdout.write(audio);
    return;
  }
  writeFileSync(out, audio);
  const summary = {
    voice: checked.request.voice,
    rate: checked.request.rate,
    pitch: checked.request.pitch,
    characters: checked.request.text.length,
    bytes: audio.byteLength,
    contentType: response.headers.get("content-type") ?? "audio/mpeg",
    path: out,
  };
  printData(summary, wantsJson, [
    `Wrote ${audio.byteLength} bytes of ${summary.contentType} to ${out}`,
    `Voice: ${summary.voice}  rate ${summary.rate}  pitch ${summary.pitch}  (${summary.characters} characters)`,
  ]);
}

/* ----------------------------------------------------------------- status -- */

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const allowNetwork = takeFlag(args, "--edge");
  rejectArgs(args, USAGE);

  const local = listLocalNarratorVoices();
  const languages = [...new Set(local.voices.map(voice => voice.lang).filter(Boolean))].sort();

  let edge: EdgeCatalogue | null = null;
  if (allowNetwork) {
    announceEdgeContact("catalogue");
    edge = await fetchEdgeCatalogue(deps);
  }

  if (wantsJson) {
    printData(
      {
        localVoices: { available: local.available, reason: local.reason ?? null, count: local.voices.length, languages },
        edge: {
          // This invocation only. The CLI stores no narrator state, so nothing
          // here is a setting that survives the command.
          allowedThisRun: allowNetwork,
          probed: edge !== null,
          available: edge?.available ?? null,
          error: edge?.error ?? null,
          voiceCount: edge?.voices.length ?? null,
        },
        bounds: {
          textMaxCharacters: EDGE_TEXT_MAX,
          rateMin: NARRATOR_MULTIPLIER_MIN,
          rateMax: NARRATOR_MULTIPLIER_MAX,
          pitchMin: NARRATOR_MULTIPLIER_MIN,
          pitchMax: NARRATOR_MULTIPLIER_MAX,
        },
        preferences: { readable: false, storedIn: PREFERENCE_STORE, covers: PREFERENCE_KEYS, change: PREFERENCE_SURFACE },
      },
      true,
    );
    return;
  }

  console.log(
    `Installed voices : ${local.available
      ? `${local.voices.length}${languages.length ? ` (${languages.join(", ")})` : ""}`
      : `unavailable — ${local.reason ?? "unknown reason"}`}`,
  );
  console.log(
    `Edge voices      : ${edge === null
      ? "not probed — pass --edge to contact Microsoft"
      : edge.available
        ? `${edge.voices.length} published`
        : `unavailable — ${edge.error ?? "the service did not answer"}`}`,
  );
  console.log(`Text limit       : ${EDGE_TEXT_MAX} characters per utterance`);
  console.log(
    `Rate and pitch   : ${NARRATOR_MULTIPLIER_MIN} to ${NARRATOR_MULTIPLIER_MAX}`
    + " (1 = the voice's own normal delivery)",
  );
  console.log(
    "\nNarrator preferences are not readable from here:\n"
    + `${PREFERENCE_KEYS.map(key => `  - ${key}`).join("\n")}\n`
    + `  are stored per visitor in ${PREFERENCE_STORE},\n`
    + "  not in this machine's server-side configuration.\n"
    + `  Change them in ${PREFERENCE_SURFACE}.`,
  );
  if (local.available && !languages.some(tag => matchesNarratorLanguage(tag, "zh"))) {
    // The gap the Edge source exists to close, named where somebody looking for
    // a Cantonese voice will actually be looking.
    console.log(
      "\nNo Chinese voice is installed on this machine. The Edge online catalogue\n"
      + "  carries neural Cantonese voices:  ocx narrator voices --source edge --lang zh-HK --edge",
    );
  }
}

export async function handleNarratorCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "voices") await voices(rest, deps);
    else if (sub === "speak") await speak(rest, deps);
    else throw new CliUsageError(`unknown narrator command ${sub}`, USAGE);
  });
}

export const NARRATOR_USAGE = USAGE;
