/**
 * Microsoft Edge read-aloud voices, for the narrator.
 *
 * Windows ships essentially nothing usable for `zh-HK` — the machine this was
 * written on reports three `en-US` SAPI voices and no Cantonese one at all — so
 * a Cantonese narrator built on local voices alone is barely a feature. Edge's
 * read-aloud service carries three neural Cantonese voices (`HiuMaan`, `HiuGaai`,
 * `WanLung`) among 322 in total, which is the gap this closes.
 *
 * ## This endpoint is undocumented and unsupported
 *
 * It is the service Edge's own "read aloud" uses. Microsoft publishes no
 * contract for it, owes nobody compatibility, and can change or block it without
 * notice — and has tightened it before. Nothing here may present it as a
 * supported API, and every caller must degrade to a local platform voice when it
 * fails rather than going quiet. The user-facing copy says the same thing.
 *
 * ## The handshake validates the version and the User-Agent *together*
 *
 * Worth writing down, because the failure is silent and misleading: the upgrade
 * answers `403 Forbidden` when `Sec-MS-GEC-Version` and the `User-Agent`'s Edge
 * major version disagree, and answers `403` again for a stale version even when
 * they match each other. Measured directly against the endpoint:
 *
 * | `Sec-MS-GEC-Version` | `User-Agent` | result                      |
 * |----------------------|--------------|-----------------------------|
 * | `1-143.0.3650.96`    | `Edg/143`    | **101 Switching Protocols** |
 * | `1-143.0.3650.96`    | `Edg/130`    | 403 Forbidden               |
 * | `1-130.0.2849.68`    | `Edg/130`    | 403 Forbidden               |
 *
 * A WebSocket client only ever reports "expected 101 status code", which hides
 * all of that — the two constants below must therefore be bumped *as a pair*,
 * and a sudden 403 across the board means the pin has aged out rather than that
 * the protocol changed. A nonsense path on the same host answers `400`, so a
 * `403` is the service refusing this client rather than the host being blocked.
 *
 * ## No credential is involved
 *
 * `TRUSTED_CLIENT_TOKEN` is a public constant compiled into Edge itself. It is
 * not a secret, is never requested from the user, and must never be treated as
 * one or placed in the credential store.
 */

import { createHash, randomUUID } from "node:crypto";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/**
 * Bumped as a pair, always — see the table above. `GEC_VERSION` is the value the
 * service checks and `EDGE_UA` must carry the same major version.
 */
const GEC_VERSION = "1-143.0.3650.96";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
/** The read-aloud extension's own origin; the service checks it. */
const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

const VOICES_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const SYNTH_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

/** Bounds. A narrator line is a sentence, not a document. */
export const EDGE_TEXT_MAX = 600;
const LIST_TIMEOUT_MS = 10_000;
const SYNTH_TIMEOUT_MS = 15_000;
/** Refuse an implausible audio response rather than buffering it. */
const AUDIO_BYTES_MAX = 5_000_000;
/** How long a fetched catalogue is reused. One request per session, not per keystroke. */
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;

/** One Edge voice, reduced to what the picker needs. */
export interface EdgeVoice {
  /** e.g. `zh-HK-HiuMaanNeural`. Stable, and what synthesis is asked for. */
  shortName: string;
  /** e.g. `Microsoft HiuMaan Online (Natural) - Chinese (Cantonese Traditional)`. */
  friendlyName: string;
  /** BCP-47, e.g. `zh-HK`. */
  locale: string;
  localeName: string;
  gender: string;
}

/**
 * `Sec-MS-GEC`: SHA-256 of the Windows file-time ticks for the current 5-minute
 * window concatenated with the public token, uppercase hex.
 *
 * `BigInt` for the multiply on purpose. The tick count lands near 1.7e17, past
 * `Number.MAX_SAFE_INTEGER`, and while the values happen to be exactly
 * representable today (every one is a multiple of 3e9, which is a multiple of
 * the float spacing at that magnitude) that is an accident of the 300-second
 * rounding rather than something to rely on.
 */
function secMsGec(now = Date.now()): string {
  const seconds = Math.floor(now / 1000) + 11644473600;
  const ticks = BigInt(seconds - (seconds % 300)) * 10_000_000n;
  return createHash("sha256").update(`${ticks}${TRUSTED_CLIENT_TOKEN}`).digest("hex").toUpperCase();
}

function withAuthParams(base: string): URL {
  const url = new URL(base);
  url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
  url.searchParams.set("Sec-MS-GEC", secMsGec());
  url.searchParams.set("Sec-MS-GEC-Version", GEC_VERSION);
  return url;
}

/* ------------------------------------------------------------- catalogue -- */

let cached: { at: number; voices: EdgeVoice[] } | null = null;

interface RawEdgeVoice {
  ShortName?: unknown;
  FriendlyName?: unknown;
  Locale?: unknown;
  LocaleName?: unknown;
  Gender?: unknown;
}

/** A voice name safe to interpolate into SSML. Membership is checked separately. */
const SHORT_NAME = /^[A-Za-z0-9-]{3,64}$/;

function readVoice(raw: RawEdgeVoice): EdgeVoice | null {
  const shortName = typeof raw.ShortName === "string" ? raw.ShortName : "";
  if (!SHORT_NAME.test(shortName)) return null;
  return {
    shortName,
    friendlyName: typeof raw.FriendlyName === "string" ? raw.FriendlyName.slice(0, 160) : shortName,
    locale: typeof raw.Locale === "string" ? raw.Locale.slice(0, 35) : "",
    localeName: typeof raw.LocaleName === "string" ? raw.LocaleName.slice(0, 80) : "",
    gender: typeof raw.Gender === "string" ? raw.Gender.slice(0, 16) : "",
  };
}

/**
 * The published voice catalogue, cached for `CATALOGUE_TTL_MS`.
 *
 * Throws on failure rather than returning an empty list: "the service is
 * unreachable" and "the service has no voices" are different sentences and the
 * surface has to say the right one.
 */
export async function listEdgeVoices(): Promise<EdgeVoice[]> {
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.voices;

  const response = await fetch(withAuthParams(VOICES_URL), {
    headers: { "User-Agent": EDGE_UA, Origin: EDGE_ORIGIN },
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`voice list refused with HTTP ${response.status}`);

  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("voice list was not an array");
  const voices = payload.map(readVoice).filter((v): v is EdgeVoice => v !== null);
  if (!voices.length) throw new Error("voice list was empty");

  cached = { at: Date.now(), voices };
  return voices;
}

/* ------------------------------------------------------------- synthesis -- */

/** XML-escape, so narrated text cannot break out of the SSML it is placed in. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A multiplier the picker uses (1 = normal) as the percentage SSML wants. */
function percent(multiplier: number): string {
  const clamped = Math.min(2, Math.max(0.5, Number.isFinite(multiplier) ? multiplier : 1));
  const value = Math.round((clamped - 1) * 100);
  return `${value >= 0 ? "+" : ""}${value}%`;
}

export interface EdgeSpeechRequest {
  text: string;
  /** An Edge `ShortName`, validated against the live catalogue before use. */
  voice: string;
  rate?: number;
  pitch?: number;
  /** Aborting closes the socket, so a superseded utterance stops transferring. */
  signal?: AbortSignal;
}

/**
 * Synthesize one utterance and resolve with the MP3 bytes.
 *
 * Deliberately buffered rather than streamed. The renderer decodes the whole
 * clip through the Web Audio API — which needs a complete buffer anyway — and
 * that keeps the audio off the CSP's `media-src`, which would otherwise have to
 * be widened to allow a `blob:` URL. A narrator line is a sentence; the size cap
 * above is what keeps buffering honest.
 *
 * No retry. A failed request degrades to a local voice at the call site, and a
 * retry storm against an undocumented endpoint is how a client gets blocked.
 */
export async function synthesizeEdgeSpeech(request: EdgeSpeechRequest): Promise<Uint8Array> {
  const text = request.text.trim().slice(0, EDGE_TEXT_MAX);
  if (!text) throw new Error("nothing to speak");

  // Checked against the live catalogue, not just a pattern: it is the only thing
  // standing between a stored preference and an arbitrary name reaching the SSML.
  const voices = await listEdgeVoices();
  const voice = voices.find(v => v.shortName === request.voice);
  if (!voice) throw new Error(`unknown Edge voice: ${String(request.voice).slice(0, 64)}`);

  const url = withAuthParams(SYNTH_URL);
  url.searchParams.set("ConnectionId", randomUUID().replace(/-/g, ""));

  const socket = new WebSocket(url.toString(), {
    headers: { "User-Agent": EDGE_UA, Origin: EDGE_ORIGIN },
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("synthesis timed out")), SYNTH_TIMEOUT_MS);
      const settle = (fn: () => void) => { clearTimeout(timer); fn(); };

      const onAbort = () => settle(() => reject(new Error("cancelled")));
      request.signal?.addEventListener("abort", onAbort, { once: true });

      socket.addEventListener("open", () => {
        const stamp = new Date().toISOString();
        socket.send(
          `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                },
              },
            },
          }),
        );
        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapeXml(voice.locale || "en-US")}'>` +
          `<voice name='${voice.shortName}'>` +
          `<prosody rate='${percent(request.rate ?? 1)}' pitch='${percent(request.pitch ?? 1)}'>` +
          `${escapeXml(text)}</prosody></voice></speak>`;
        socket.send(
          `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
          `Content-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`,
        );
      });

      socket.addEventListener("message", event => {
        if (typeof event.data === "string") {
          // `turn.end` is the service saying the utterance is complete. Closing
          // on anything earlier truncates the audio mid-word.
          if (/Path:turn\.end/i.test(event.data)) {
            settle(() => {
              const audio = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
              resolve(audio);
            });
          }
          return;
        }
        // Binary frame: two big-endian bytes of header length, the header, then
        // the MP3 payload.
        const buffer = event.data as ArrayBuffer;
        const headerLength = new DataView(buffer).getUint16(0);
        const chunk = new Uint8Array(buffer, 2 + headerLength);
        total += chunk.length;
        if (total > AUDIO_BYTES_MAX) {
          settle(() => reject(new Error("synthesis response exceeded its size cap")));
          return;
        }
        chunks.push(chunk);
      });

      socket.addEventListener("error", () => settle(() => reject(
        // The client API never surfaces the HTTP status, so say what a refusal
        // most likely means rather than repeating "expected 101".
        new Error("Edge speech service refused the connection (the endpoint is undocumented and may have changed)"),
      )));
      socket.addEventListener("close", event => {
        if (event.code !== 1000 && event.code !== 1005) {
          settle(() => reject(new Error(`Edge speech socket closed unexpectedly (${event.code})`)));
        }
      });
    });
  } finally {
    try { socket.close(); } catch { /* already closing */ }
  }
}
