/**
 * Speech-synthesis narrator.
 *
 * Off by default and never auto-enables.
 *
 * ## One message at a time, and the newest one wins
 *
 * The narrator holds at most one message in flight and at most one waiting. A
 * new request *supersedes* the waiting one rather than stacking behind it, so a
 * burst of status changes reads the latest state instead of narrating a backlog
 * the user has already moved past. The utterance that is mid-sentence is allowed
 * to finish — cutting a voice off mid-word to say something else is how a
 * narrator becomes unlistenable — but everything the superseded message had left
 * to say is dropped.
 *
 * ## Bilingual mode has two tracks, spoken in order
 *
 * A bilingual message is two strings, not one: English then Cantonese, strictly
 * serialized, each in its own utterance with its own `lang`, its own voice, its
 * own rate and its own pitch. Joining them into a single utterance with a single
 * `lang` — which is what a naive `t()` call produces, since bilingual `t()`
 * returns `English · 廣東話` — makes one voice read the other language's
 * characters, which at best sounds wrong and at worst is silence.
 *
 * Supersession spans the pair. Interrupting after the English half has started
 * cancels the Cantonese half rather than letting a stale second track speak
 * after a newer message has already arrived.
 */

import { edgeShortName, isEdgeUri, speechAvailable } from "./narrator-voices";

/** One narrated language: what to say it in, and how it should sound. */
export interface NarratorTrackConfig {
  /** BCP-47 tag set on the utterance, and what an automatic voice resolves from. */
  lang: string;
  /**
   * The platform's stable voice identity, or absent for "choose automatically".
   *
   * Absent leaves `utterance.voice` unset, which is precisely what letting the
   * platform choose means. A URI that is not installed here behaves the same
   * way — the stored choice is kept, and the platform speaks in the meantime.
   */
  voiceURI?: string;
  rate: number;
  pitch: number;
}

interface Segment {
  text: string;
  track: NarratorTrackConfig;
}

let enabled = false;
let tracks: NarratorTrackConfig[] = [];
/** Where `/api/narrator/edge-speak` lives. Empty means same origin. */
let apiBase = "";
/**
 * Whether the user has opted the network voice source in.
 *
 * Consulted on every utterance rather than trusted from the stored voice id: a
 * stored Edge voice must never cause a network request while the source is off.
 */
let edgeEnabled = false;
/** What is left of the message currently being spoken. Dropped on supersession. */
let remaining: Segment[] = [];
/** The newest request, waiting for the in-flight utterance to finish. */
let pending: Segment[] | null = null;
let speaking = false;

/* -- the network voice's playback state, superseded by exactly the same rules - */

/** Aborts the in-flight synthesis request when an utterance is superseded. */
let edgeRequest: AbortController | null = null;
/** The clip currently coming out of the speakers, so it can be stopped dead. */
let edgeSource: AudioBufferSourceNode | null = null;
let audioContext: AudioContext | null = null;

export function configureNarrator(next: {
  enabled: boolean;
  tracks: NarratorTrackConfig[];
  apiBase?: string;
  edgeEnabled?: boolean;
}): void {
  enabled = next.enabled;
  tracks = next.tracks;
  apiBase = next.apiBase ?? "";
  edgeEnabled = next.edgeEnabled ?? false;
  if (!enabled) cancelNarration();
}

export function narratorAvailable(): boolean {
  return speechAvailable();
}

/**
 * The live voice for a stored URI, resolved at the moment of speaking.
 *
 * Deliberately a fresh read rather than a cached list: voices can be installed,
 * removed or finish arriving between configuring the narrator and using it, and
 * a `SpeechSynthesisVoice` from a stale enumeration is not guaranteed to still
 * be the object the platform will accept.
 */
function voiceFor(uri: string | undefined): SpeechSynthesisVoice | undefined {
  if (!uri || !speechAvailable()) return undefined;
  try {
    // Matched on `voiceURI`, never on `name` — see `narrator-voices.ts`.
    return window.speechSynthesis.getVoices().find(voice => voice.voiceURI === uri);
  } catch {
    return undefined;
  }
}

/**
 * Stop any network clip dead and abandon any request still in flight.
 *
 * Returns whether there was anything to stop, which the caller needs: an
 * aborted request never runs its completion callback, so without this the
 * queue would sit with `speaking` stuck true and never speak again. A local
 * utterance is the opposite — it finishes on its own and reports back — which
 * is exactly why the two paths cannot share one assumption.
 */
function stopEdgePlayback(): boolean {
  const wasActive = edgeRequest !== null || edgeSource !== null;
  edgeRequest?.abort();
  edgeRequest = null;
  if (edgeSource) {
    // `onended` is cleared first: stopping deliberately must not look like the
    // clip finishing, or `drain` would advance the queue twice.
    edgeSource.onended = null;
    try { edgeSource.stop(); } catch { /* never started, or already stopped */ }
    edgeSource = null;
  }
  return wasActive;
}

/**
 * Speak one segment through Microsoft's read-aloud service.
 *
 * Fetched from this app's own server — the page's CSP is `connect-src 'self'`,
 * so it could not reach the speech service directly even if that were a good
 * idea — and decoded through the Web Audio API rather than an `Audio` element,
 * which keeps the clip off `media-src` and so avoids widening the CSP to allow a
 * `blob:` URL for the sake of one feature.
 *
 * Any failure hands the segment back to the platform voice rather than going
 * quiet. Offline, blocked, a changed endpoint and a refused request are all the
 * same promise to the listener: something is spoken, and the surface says the
 * chosen voice is not the one they are hearing.
 */
async function speakThroughEdge(segment: Segment, done: () => void): Promise<void> {
  const controller = new AbortController();
  edgeRequest = controller;
  try {
    const response = await fetch(`${apiBase}/api/narrator/edge-speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: segment.text,
        voice: edgeShortName(segment.track.voiceURI!),
        rate: segment.track.rate,
        pitch: segment.track.pitch,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const encoded = await response.arrayBuffer();
    if (controller.signal.aborted) return;

    audioContext ??= new AudioContext();
    const buffer = await audioContext.decodeAudioData(encoded);
    // Re-checked after decoding: a supersede can land while the decoder runs,
    // and starting here would play a clip the user has already moved past.
    if (controller.signal.aborted) return;

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      if (edgeSource === source) edgeSource = null;
      done();
    };
    edgeSource = source;
    source.start();
  } catch (error) {
    if (controller.signal.aborted || (error as Error)?.name === "AbortError") return;
    // Degrade to the platform voice rather than dropping the line.
    speakLocally({ ...segment, track: { ...segment.track, voiceURI: undefined } }, done);
  } finally {
    if (edgeRequest === controller) edgeRequest = null;
  }
}

/** Speak one segment through the operating system's own speech synthesis. */
function speakLocally(segment: Segment, done: () => void): void {
  const utterance = new SpeechSynthesisUtterance(segment.text);
  utterance.lang = segment.track.lang;
  const voice = voiceFor(segment.track.voiceURI);
  // Only assigned when the chosen voice is genuinely present. Leaving it unset
  // is how "choose automatically" and "your choice is not installed here" both
  // hand the decision back to the platform, which resolves it from `lang`.
  if (voice) utterance.voice = voice;
  utterance.rate = segment.track.rate;
  utterance.pitch = segment.track.pitch;
  utterance.onend = utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
}

function drain(): void {
  if (speaking || !narratorAvailable()) return;
  if (pending) {
    // Assignment, never concatenation. This one line is what makes supersession
    // span a whole pair: whatever the superseded message had left to say is
    // dropped here rather than being spoken after the newer one. Appending
    // instead would let a stale Cantonese half arrive on top of a newer
    // message, which is the exact failure the pairing introduced.
    remaining = pending;
    pending = null;
  }
  const next = remaining.shift();
  if (!next) return;

  speaking = true;
  // Guarded so one segment can only ever advance the queue once, whichever
  // source spoke it — a network clip that both errors and ends would otherwise
  // pull two segments off and speak them over each other.
  let advanced = false;
  const done = () => {
    if (advanced) return;
    advanced = true;
    speaking = false;
    drain();
  };

  // The stored voice alone never reaches the network: `edgeEnabled` is the
  // user's explicit opt-in and is checked on every single utterance, so an Edge
  // voice left in a profile speaks locally until the source is switched on.
  if (edgeEnabled && isEdgeUri(next.track.voiceURI)) {
    void speakThroughEdge(next, done);
    return;
  }
  speakLocally(next, done);
}

/**
 * Speak one message, superseding whatever was waiting.
 *
 * `secondary` is the Cantonese half of a bilingual message and is spoken by the
 * second configured track. It is omitted when the two tracks would say the same
 * thing — `bilingualParts` already returns an empty secondary in that case — so
 * a single-language message never gets read out twice.
 */
export function narrate(primary: string, secondary?: string): void {
  if (!enabled || !narratorAvailable()) return;

  const segments: Segment[] = [];
  const first = tracks[0];
  if (first && primary) segments.push({ text: primary, track: first });
  const second = tracks[1];
  if (second && secondary) segments.push({ text: secondary, track: second });
  if (!segments.length) return;

  // Staging `pending` is all this does; `drain` is where a superseded pair's
  // unspoken half is dropped, because it *assigns* `remaining` rather than
  // appending to it. Resetting `remaining` here as well would read as the line
  // enforcing the rule while actually being dead — `remaining` is only ever
  // non-empty while an utterance is in flight, and that path always goes back
  // through the promotion in `drain`.
  pending = segments;
  // A network clip is *not* allowed to finish the way a local utterance is.
  // Aborting the request and stopping the buffer is the only thing that keeps
  // supersede-not-stack true across the two sources: audio already downloaded
  // would otherwise keep playing over the top of the message that replaced it,
  // which is the one failure a queue like this exists to prevent.
  //
  // Clearing `speaking` here is what an abort costs: the stopped segment will
  // never call back to say it is done, so the queue has to be released on its
  // behalf or nothing is ever spoken again.
  if (stopEdgePlayback()) speaking = false;
  drain();
}

export function cancelNarration(): void {
  remaining = [];
  pending = null;
  speaking = false;
  stopEdgePlayback();
  if (narratorAvailable()) window.speechSynthesis.cancel();
}
