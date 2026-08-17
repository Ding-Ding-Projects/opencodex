/**
 * The voices this computer can actually speak with, and how a stored choice
 * resolves against them.
 *
 * Split from `narrator.ts` because the two answer different questions at
 * different times. The narrator resolves a voice at the moment it speaks, from a
 * fresh read, and needs no subscription. The picker has to *render* the list, so
 * it has to survive the one property of `speechSynthesis` that breaks naive
 * pickers: the list arrives late.
 *
 * ## The list arrives late
 *
 * `speechSynthesis.getVoices()` commonly returns an empty array on the first
 * call and fills in a moment later behind the `voiceschanged` event. A picker
 * that reads it once reports "no voices installed" on a machine with forty, and
 * looks broken rather than slow — so `subscribeVoices` re-reads on the event and
 * unsubscribes on teardown, and `loaded` distinguishes "we have not been told
 * yet" from "we asked, we waited, and there are none".
 *
 * ## Identity is the URI, never the name
 *
 * Names are not unique — one machine can carry several voices with the same
 * name from different engines — and platforms localize them, so a profile
 * written on one install silently stops matching on another. Everything that
 * decides *which* voice speaks compares `voiceURI`. `name` is carried only so a
 * status line can say which voice went missing, and is never matched on.
 */

/**
 * Where a voice comes from.
 *
 * `local` is the operating system's own speech synthesis: offline, private,
 * nothing leaves the machine. `edge` is Microsoft's read-aloud service, which
 * means the narrated text is sent to Microsoft — so it is opt-in, never
 * selected automatically, and never used as a silent fallback.
 */
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "./settings-search";

export type VoiceSource = "local" | "edge";

/** The prefix that keeps an Edge identity from colliding with a platform one. */
export const EDGE_URI_PREFIX = "edge:";

export function isEdgeUri(uri: string | undefined): boolean {
  return typeof uri === "string" && uri.startsWith(EDGE_URI_PREFIX);
}

/** `edge:zh-HK-HiuMaanNeural` → `zh-HK-HiuMaanNeural`. */
export function edgeShortName(uri: string): string {
  return uri.slice(EDGE_URI_PREFIX.length);
}

/** One selectable voice, from either source. */
export interface VoiceOption {
  /**
   * The stable identity. This is what gets persisted and matched — a platform
   * `voiceURI` for a local voice, `edge:<ShortName>` for an Edge one.
   */
  uri: string;
  /** Display only. Never compared, never persisted as identity. */
  name: string;
  /** The BCP-47 tag reported for this voice. */
  lang: string;
  /**
   * `false` means the voice is synthesized over the network and goes quiet when
   * this computer is offline — which the picker has to say out loud, because
   * nothing about the name reveals it. Every Edge voice is network-backed.
   */
  localService: boolean;
  source: VoiceSource;
}

/** One Edge voice as `/api/narrator/edge-voices` reports it. */
export interface EdgeVoiceRecord {
  shortName: string;
  friendlyName: string;
  locale: string;
  localeName: string;
  gender: string;
}

/**
 * The Edge catalogue, fetched through this app's own server.
 *
 * The renderer cannot call the speech service directly — the dashboard's CSP is
 * `connect-src 'self'` — so this is a same-origin request that the server
 * proxies. It answers `available: false` with a reason rather than throwing,
 * because "the service is unreachable" is a sentence the picker has to show, not
 * an error that should blank the screen.
 */
export async function fetchEdgeVoices(
  apiBase: string,
  signal?: AbortSignal,
): Promise<{ available: boolean; voices: VoiceOption[]; error?: string }> {
  try {
    const response = await fetch(`${apiBase}/api/narrator/edge-voices`, { signal });
    if (!response.ok) return { available: false, voices: [], error: `HTTP ${response.status}` };
    const payload = await response.json() as { available?: boolean; voices?: EdgeVoiceRecord[]; error?: string };
    if (!payload.available || !Array.isArray(payload.voices)) {
      return { available: false, voices: [], error: payload.error ?? "unavailable" };
    }
    return {
      available: true,
      voices: payload.voices.map(voice => ({
        uri: `${EDGE_URI_PREFIX}${voice.shortName}`,
        name: voice.friendlyName || voice.shortName,
        lang: voice.locale,
        // Always: every Edge voice needs the network, and the status line says so.
        localService: false,
        source: "edge" as const,
      })),
    };
  } catch (error) {
    return { available: false, voices: [], error: error instanceof Error ? error.message : "unavailable" };
  }
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** A fresh read of the platform's list. Cheap; call it rather than caching. */
export function readVoices(): VoiceOption[] {
  if (!speechAvailable()) return [];
  try {
    return window.speechSynthesis.getVoices().map(voice => ({
      uri: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      localService: voice.localService,
      source: "local" as const,
    }));
  } catch {
    // A platform that refuses mid-enumeration is indistinguishable from one with
    // no voices, and the picker's "none installed" copy is the honest reading.
    return [];
  }
}

/**
 * Re-read on every `voiceschanged` until the returned function is called.
 *
 * The listener fires immediately with whatever is available *now*, so a caller
 * that subscribes after the list has already settled is not left waiting for an
 * event that has already been and gone.
 */
export function subscribeVoices(listener: (voices: VoiceOption[]) => void): () => void {
  if (!speechAvailable()) {
    listener([]);
    return () => {};
  }
  const onChange = () => listener(readVoices());
  window.speechSynthesis.addEventListener("voiceschanged", onChange);
  listener(readVoices());
  return () => window.speechSynthesis.removeEventListener("voiceschanged", onChange);
}

/**
 * A language tag reduced to the two things that decide whether a voice can read
 * a track: its primary subtag and its region.
 *
 * `yue` and `zh-HK` name the same narrated language here — the app's Cantonese
 * track is `zh-HK`, and a genuine Cantonese voice may report either — so `yue`
 * is folded onto `zh-HK` rather than left to miss.
 */
function langParts(tag: string): { primary: string; region: string } {
  const [primary = "", region = ""] = String(tag).trim().toLowerCase().replace(/_/g, "-").split("-");
  if (primary === "yue") return { primary: "zh", region: region || "hk" };
  return { primary, region };
}

/**
 * Whether `voiceLang` can read a track narrated in `wantLang`.
 *
 * The rule is one sentence: primary subtags must agree, and when the *request*
 * names a region the voice must not name a different one. That is what keeps a
 * `zh-CN` voice out of the Cantonese picker — it reads the same characters with
 * the wrong pronunciation, which is not "a voice that can read Cantonese" — while
 * still letting every `en-GB`/`en-US` voice answer a bare `en` request, and
 * letting a voice that reports a bare `zh` answer `zh-HK` rather than being
 * dropped for saying too little.
 */
export function voiceReadsLang(voiceLang: string, wantLang: string): boolean {
  const voice = langParts(voiceLang);
  const want = langParts(wantLang);
  if (!voice.primary || !want.primary || voice.primary !== want.primary) return false;
  if (!want.region || !voice.region) return true;
  return voice.region === want.region;
}

/**
 * Every voice that can read the track: local ones first, then Edge, each group
 * name-sorted so the list does not reshuffle between renders.
 *
 * Local first is the ordering the defaults imply — offline and private is the
 * ordinary case, and the network source is the deliberate one.
 */
export function voicesForLang(voices: readonly VoiceOption[], wantLang: string): VoiceOption[] {
  return voices
    .filter(voice => voiceReadsLang(voice.lang, wantLang))
    .sort((a, b) =>
      (a.source === b.source ? 0 : a.source === "local" ? -1 : 1) || a.name.localeCompare(b.name));
}

/**
 * Narrow a voice list by a free-text query or a regular expression.
 *
 * The Edge catalogue is 322 voices, which is past the size where scrolling is a
 * reasonable ask — so the picker gets the same search treatment every other list
 * in the app has. Plain text is the default; an invalid pattern matches
 * everything rather than blanking the list, and the error is reported beside the
 * field instead of discarding what was typed.
 *
 * `flags` are the ones the builder anchored beside that field composed, and they
 * default to the `"i"` this function used to hard-code so an older caller keeps
 * its behaviour. Hard-coding them is what made the builder's flag chips
 * decorative from the picker's point of view: they changed the preview in the
 * panel and nothing in the list behind it, and a pattern deliberately built as
 * case-sensitive arrived case-insensitive. The shared matcher underneath also
 * bounds the pattern at the same 400 characters and drops `g`/`y`, whose
 * `lastIndex` survives between calls — a sticky pattern tested down 322 voices
 * would keep every other one, in whatever order they happened to be tested.
 *
 * The invalid case deliberately parts company with `settingsMatcher`, which
 * matches nothing on a compile failure: a half-typed pattern must not blank a
 * list of 322 voices while the user is still typing it.
 */
export function filterVoices(
  voices: readonly VoiceOption[],
  query: string,
  useRegex: boolean,
  flags: string = DEFAULT_SEARCH_FLAGS,
): VoiceOption[] {
  if (!query.trim()) return [...voices];
  const haystack = (voice: VoiceOption) => `${voice.name} ${voice.lang}`;
  const matcher = settingsMatcher(query, useRegex, flags);
  if (matcher.error) return [...voices];
  return voices.filter(voice => matcher.test(haystack(voice)));
}

/**
 * What the picker has to say beneath itself, and what the narrator has to do.
 *
 * - `loading` — the platform has not answered yet. Not the same as "none".
 * - `none` — it answered, and nothing installed can read this language.
 * - `platform` — set to choose automatically; the platform picks from the tag.
 * - `chosen` — the stored voice is installed and is what will speak.
 * - `missing` — the stored voice is not installed here. The narrator falls back
 *   to the platform's own pick and the *choice is kept*, so plugging the machine
 *   back in — or reinstalling the voice — restores it rather than silently
 *   resetting the user's preference to whatever happened to be present.
 * - `edgeOff` — an Edge voice is stored but the Edge source is switched off.
 *   The narrator uses a local voice and says so; it never quietly turns a
 *   network source back on to honour a stored preference.
 * - `edgeUnavailable` — the Edge source is on but the service did not answer
 *   (offline, blocked, or the undocumented endpoint changed). Same honest
 *   degradation: a local voice speaks, and the surface says why.
 */
export type VoiceResolutionKind =
  | "loading" | "none" | "platform" | "chosen" | "missing" | "edgeOff" | "edgeUnavailable";

export interface VoiceResolution {
  kind: VoiceResolutionKind;
  /** The voice that will actually speak, when the app is the one choosing it. */
  voice?: VoiceOption;
  /** Installed voices that can read this track. */
  candidates: VoiceOption[];
  /** True when the voice that will speak is network-backed and dies offline. */
  network: boolean;
}

/**
 * Resolve a stored choice against the live list.
 *
 * "Choose automatically" deliberately resolves to *no* voice rather than to the
 * first candidate: leaving `utterance.voice` unset and `utterance.lang` set is
 * exactly what "let the platform choose" means, and naming a specific voice in
 * the status line would be the app guessing at a decision it did not make.
 */
export function resolveVoice(
  voices: readonly VoiceOption[],
  wantLang: string,
  storedUri: string | undefined,
  loaded: boolean,
  edge?: { enabled: boolean; available: boolean },
): VoiceResolution {
  const candidates = voicesForLang(voices, wantLang);
  if (!loaded) return { kind: "loading", candidates, network: false };

  // A stored Edge voice is reported before anything else, because both of these
  // states end in a *local* voice speaking and the user has to be told that
  // rather than left believing the neural voice they picked is what they hear.
  // Neither one silently enables the network source or drops the preference.
  if (isEdgeUri(storedUri) && edge && !edge.enabled) {
    return { kind: "edgeOff", candidates, network: false };
  }
  if (isEdgeUri(storedUri) && edge && !edge.available) {
    return { kind: "edgeUnavailable", candidates, network: false };
  }

  // Matched on the URI, never the name: a machine can carry two voices called
  // "Microsoft Zira" from different engines, and a name match would pick either.
  const chosen = storedUri ? candidates.find(voice => voice.uri === storedUri) : undefined;
  if (chosen) return { kind: "chosen", voice: chosen, candidates, network: !chosen.localService };
  if (storedUri) return { kind: "missing", candidates, network: false };
  if (!candidates.length) return { kind: "none", candidates, network: false };
  return { kind: "platform", candidates, network: false };
}
