/**
 * The narrator's voice selection, and bilingual serialization.
 *
 * Two contracts are being pinned here, and they fail in ways no screenshot
 * reveals.
 *
 * The first is that a *stored* voice is matched on the platform's stable
 * identity rather than on its display name, and that a choice pointing at a
 * voice this machine does not have is kept and reported rather than silently
 * reset. Measured on the machine this was written on, Chromium answered the
 * first synchronous `getVoices()` with **zero** voices and then delivered three
 * after `voiceschanged` fired — so "the list is empty" is a state every picker
 * passes through and must not report as "nothing is installed".
 *
 * The second is that bilingual narration is two utterances, in order, each with
 * its own language, voice, rate and pitch — never one joined string read by one
 * voice — and that superseding a message mid-pair drops the half that had not
 * been spoken yet rather than letting a stale second language arrive after a
 * newer message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import LanguageVoice from "../src/pages/LanguageVoice";
import { TestLanguageProvider } from "./helpers/providers";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";
import { DEFAULT_PREFS, readPrefs, PREFS_KEY } from "../src/theme/prefs-context";
import { resolveVoice, voiceReadsLang, voicesForLang, type VoiceOption } from "../src/shell/narrator-voices";
import { cancelNarration, configureNarrator, narrate } from "../src/shell/narrator";

/* ------------------------------------------------------------ fake platform */

interface FakeVoice { voiceURI: string; name: string; lang: string; localService: boolean }

class FakeUtterance {
  lang = "";
  voice: FakeVoice | null = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

let installed: FakeVoice[] = [];
let spoken: FakeUtterance[] = [];
let inFlight: FakeUtterance[] = [];
let cancelled = 0;

const synth = {
  getVoices: () => installed,
  speak(utterance: FakeUtterance) {
    spoken.push(utterance);
    inFlight.push(utterance);
  },
  cancel() {
    cancelled += 1;
    inFlight = [];
  },
  addEventListener() {},
  removeEventListener() {},
};

/** Let the utterance the platform is "speaking" finish, draining the queue. */
function finishUtterance(): void {
  const current = inFlight.shift();
  current?.onend?.();
}

const globals = ["document", "window", "navigator", "localStorage", "SpeechSynthesisUtterance", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow, "speechSynthesis", { configurable: true, value: synth });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    SpeechSynthesisUtterance: { configurable: true, value: FakeUtterance },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installed = [];
  spoken = [];
  inFlight = [];
  cancelled = 0;
});

afterEach(() => {
  cancelNarration();
  configureNarrator({ enabled: false, tracks: [] });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const option = (uri: string, name: string, lang: string, localService = true): VoiceOption =>
  ({ uri, name, lang, localService });

/* ------------------------------------------------------ language matching -- */

describe("which voices can read which track", () => {
  test("a bare request matches every region of that language", () => {
    expect(voiceReadsLang("en-US", "en")).toBe(true);
    expect(voiceReadsLang("en-GB", "en")).toBe(true);
    expect(voiceReadsLang("de-DE", "en")).toBe(false);
  });

  // The app's Cantonese track is `zh-HK`, and a real Cantonese voice may report
  // either tag. Missing `yue-HK` would empty the picker on a machine that has a
  // perfectly good Cantonese voice installed.
  test("yue and zh-HK name the same narrated language", () => {
    expect(voiceReadsLang("yue-HK", "zh-HK")).toBe(true);
    expect(voiceReadsLang("yue", "zh-HK")).toBe(true);
    expect(voiceReadsLang("zh-HK", "yue")).toBe(true);
  });

  // A Mandarin voice reads the same characters with the wrong pronunciation.
  // That is not "a voice that can read Cantonese", so it stays out of the list
  // rather than being offered as if it would do.
  test("a different region of the same language is not a match", () => {
    expect(voiceReadsLang("zh-CN", "zh-HK")).toBe(false);
    expect(voiceReadsLang("zh-HK", "zh-CN")).toBe(false);
  });

  test("a voice that reports no region answers a regional request", () => {
    expect(voiceReadsLang("zh", "zh-HK")).toBe(true);
  });

  test("candidates come back name-sorted so the list does not reshuffle", () => {
    const voices = [option("c", "Zira", "en-US"), option("a", "David", "en-US"), option("b", "Mark", "en-GB")];
    expect(voicesForLang(voices, "en").map(v => v.name)).toEqual(["David", "Mark", "Zira"]);
  });
});

/* ------------------------------------------------------------- resolution -- */

describe("what the status line beneath a picker has to say", () => {
  const voices = [option("uri:david", "David", "en-US"), option("uri:cloud", "Aria Online", "en-US", false)];

  // The trap this whole feature turns on: an empty list before the platform has
  // answered is not the same fact as an empty list after it has.
  test("an empty list before the platform answers is loading, not none", () => {
    expect(resolveVoice([], "en", undefined, false).kind).toBe("loading");
    expect(resolveVoice([], "en", undefined, true).kind).toBe("none");
  });

  test("no stored choice hands the decision to the platform", () => {
    const resolved = resolveVoice(voices, "en", undefined, true);
    expect(resolved.kind).toBe("platform");
    // Deliberately no voice: naming one would claim to know a decision the app
    // did not make.
    expect(resolved.voice).toBeUndefined();
    expect(resolved.candidates).toHaveLength(2);
  });

  test("a stored choice resolves by URI, not by display name", () => {
    const resolved = resolveVoice(voices, "en", "uri:david", true);
    expect(resolved.kind).toBe("chosen");
    expect(resolved.voice?.name).toBe("David");

    // Same display name, different engine and different identity: matching on
    // the name would have picked this one.
    const collision = [option("uri:other-engine", "David", "en-US")];
    expect(resolveVoice(collision, "en", "uri:david", true).kind).toBe("missing");
  });

  test("a voice that is not installed here is reported, and the choice is kept", () => {
    const resolved = resolveVoice(voices, "en", "uri:not-on-this-machine", true);
    expect(resolved.kind).toBe("missing");
    expect(resolved.voice).toBeUndefined();
    // The candidates are still offered, so the user can pick a stand-in without
    // losing the preference that will come back when the voice does.
    expect(resolved.candidates).toHaveLength(2);
  });

  test("a network-backed voice is flagged, because nothing in its name says so", () => {
    expect(resolveVoice(voices, "en", "uri:cloud", true).network).toBe(true);
    expect(resolveVoice(voices, "en", "uri:david", true).network).toBe(false);
  });
});

/* -------------------------------------------------------------- narration -- */

describe("bilingual narration is serialized, one track at a time", () => {
  const bilingual = [
    { lang: "en", voiceURI: "uri:david", rate: 1.2, pitch: 0.8 },
    { lang: "zh-HK", voiceURI: "uri:sinji", rate: 0.9, pitch: 1.4 },
  ];

  beforeEach(() => {
    installed = [
      { voiceURI: "uri:david", name: "David", lang: "en-US", localService: true },
      { voiceURI: "uri:sinji", name: "Sinji", lang: "zh-HK", localService: true },
    ];
  });

  test("English speaks first, and Cantonese only after it ends", () => {
    configureNarrator({ enabled: true, tracks: bilingual });
    narrate("Ready.", "準備好喇。");

    // One utterance at a time: the second must not be queued alongside the first.
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe("Ready.");
    expect(spoken[0]!.lang).toBe("en");

    finishUtterance();

    expect(spoken).toHaveLength(2);
    expect(spoken[1]!.text).toBe("準備好喇。");
    expect(spoken[1]!.lang).toBe("zh-HK");
  });

  test("each track carries its own voice, rate and pitch", () => {
    configureNarrator({ enabled: true, tracks: bilingual });
    narrate("Ready.", "準備好喇。");
    finishUtterance();

    expect(spoken[0]!.voice?.voiceURI).toBe("uri:david");
    expect(spoken[0]!.rate).toBe(1.2);
    expect(spoken[0]!.pitch).toBe(0.8);

    expect(spoken[1]!.voice?.voiceURI).toBe("uri:sinji");
    expect(spoken[1]!.rate).toBe(0.9);
    expect(spoken[1]!.pitch).toBe(1.4);
  });

  // The rule the old single-track narrator could not express: a newer message
  // must not have a stale second language arrive on top of it.
  test("superseding mid-pair drops the half that had not been spoken", () => {
    configureNarrator({ enabled: true, tracks: bilingual });
    narrate("First.", "第一。");
    expect(spoken.map(u => u.text)).toEqual(["First."]);

    narrate("Second.", "第二。");
    // The in-flight utterance is allowed to finish rather than being cut off
    // mid-word — but "第一。" is now gone for good.
    expect(spoken.map(u => u.text)).toEqual(["First."]);

    finishUtterance();
    expect(spoken.map(u => u.text)).toEqual(["First.", "Second."]);

    finishUtterance();
    expect(spoken.map(u => u.text)).toEqual(["First.", "Second.", "第二。"]);
    expect(spoken.some(u => u.text === "第一。")).toBe(false);
  });

  test("a superseded message never stacks: only the newest pending one survives", () => {
    configureNarrator({ enabled: true, tracks: [bilingual[0]!] });
    narrate("One.");
    narrate("Two.");
    narrate("Three.");
    expect(spoken.map(u => u.text)).toEqual(["One."]);

    finishUtterance();
    expect(spoken.map(u => u.text)).toEqual(["One.", "Three."]);

    finishUtterance();
    expect(spoken.map(u => u.text)).toEqual(["One.", "Three."]);
  });

  // `bilingualParts` returns an empty secondary when the two tracks agree, so a
  // key with no Cantonese translation must not be read out twice.
  test("an absent second half is not spoken twice", () => {
    configureNarrator({ enabled: true, tracks: bilingual });
    narrate("Only English.");
    finishUtterance();
    expect(spoken.map(u => u.text)).toEqual(["Only English."]);
  });

  test("the narrator stays silent until it is turned on", () => {
    configureNarrator({ enabled: false, tracks: bilingual });
    narrate("Ready.", "準備好喇。");
    expect(spoken).toHaveLength(0);
  });

  test("turning it off cancels the pair in flight", () => {
    configureNarrator({ enabled: true, tracks: bilingual });
    narrate("Ready.", "準備好喇。");
    configureNarrator({ enabled: false, tracks: bilingual });
    expect(cancelled).toBeGreaterThan(0);

    configureNarrator({ enabled: true, tracks: bilingual });
    // Nothing left over from the cancelled pair.
    expect(spoken).toHaveLength(1);
  });

  // Automatic is the shipped default, and it means the platform decides — which
  // is `utterance.voice` left unset, not the app quietly picking the first one.
  test("choose-automatically leaves the voice unset and lets lang decide", () => {
    configureNarrator({ enabled: true, tracks: [{ lang: "en", rate: 1, pitch: 1 }] });
    narrate("Ready.");
    expect(spoken[0]!.voice).toBeNull();
    expect(spoken[0]!.lang).toBe("en");
  });

  test("a stored voice that is not installed falls back without going silent", () => {
    configureNarrator({ enabled: true, tracks: [{ lang: "en", voiceURI: "uri:gone", rate: 1, pitch: 1 }] });
    narrate("Ready.");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.voice).toBeNull();
    expect(spoken[0]!.lang).toBe("en");
  });
});

/* ---------------------------------------------------------------- storage -- */

describe("stored voice settings", () => {
  test("nothing ships with a named voice selected", () => {
    // The app cannot know what is installed until it asks the platform, so a
    // named default would be a preference for a voice most machines lack.
    expect(DEFAULT_PREFS.narratorVoices).toEqual({});
  });

  test("rate and pitch are clamped, and junk keys are dropped", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      narratorVoices: {
        "en": { rate: 99, pitch: -5, voiceURI: "uri:david", voiceLabel: "David" },
        "zh-HK": { rate: "nonsense", pitch: 1.4 },
        "not a tag!": { rate: 1, pitch: 1 },
        "de": "not an object",
      },
    }));
    const prefs = readPrefs();

    expect(prefs.narratorVoices["en"]).toEqual({ rate: 2, pitch: 0.5, voiceURI: "uri:david", voiceLabel: "David" });
    expect(prefs.narratorVoices["zh-HK"]).toEqual({ rate: 1, pitch: 1.4 });
    expect(prefs.narratorVoices["not a tag!"]).toBeUndefined();
    expect(prefs.narratorVoices["de"]).toBeUndefined();
  });

  // A profile carried between machines must come back intact when the voice
  // does, so an unresolvable URI is kept rather than pruned on read.
  test("a voice URI that is not installed here survives a read", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      narratorVoices: { "zh-HK": { rate: 1, pitch: 1, voiceURI: "uri:from-the-other-laptop" } },
    }));
    expect(readPrefs().narratorVoices["zh-HK"]?.voiceURI).toBe("uri:from-the-other-laptop");
  });

  test("a label with no URI is dropped, since it can never be matched on", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      narratorVoices: { "en": { rate: 1, pitch: 1, voiceLabel: "David" } },
    }));
    expect(readPrefs().narratorVoices["en"]).toEqual({ rate: 1, pitch: 1 });
  });
});

/* ----------------------------------------------------------------- screen -- */

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <TestLanguageProvider>
          <NotificationsProvider>
            <LanguageVoice />
          </NotificationsProvider>
        </TestLanguageProvider>
      </PrefsProvider>,
    );
  });
  return { container, root };
}

describe("the Language & voice screen", () => {
  beforeEach(() => {
    installed = [
      { voiceURI: "uri:david", name: "David", lang: "en-US", localService: true },
      { voiceURI: "uri:zira", name: "Zira", lang: "en-US", localService: true },
    ];
  });

  test("ships one voice picker per narrated language, not one shared picker", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ narrator: true, narratorLang: "both" }));
    const { container, root } = await mount();

    const selects = [...container.querySelectorAll("select")] as unknown as HTMLSelectElement[];
    expect(selects.map(s => s.id)).toEqual(["ocx-narrator-voice-en", "ocx-narrator-voice-zh-HK"]);

    // Each carries its own rate and pitch too — English and Cantonese do not
    // share one answer.
    const sliderIds = [...container.querySelectorAll('input[type="range"]')].map(n => n.id);
    expect(sliderIds).toContain("ocx-narrator-rate-en");
    expect(sliderIds).toContain("ocx-narrator-pitch-en");
    expect(sliderIds).toContain("ocx-narrator-rate-zh-HK");
    expect(sliderIds).toContain("ocx-narrator-pitch-zh-HK");

    await act(async () => { root.unmount(); });
  });

  test("choose automatically is first and is what a fresh profile has selected", async () => {
    const { container, root } = await mount();

    const select = container.querySelector("#ocx-narrator-voice-en") as unknown as HTMLSelectElement;
    const options = [...select.options].map(o => [o.value, o.text]);
    expect(options[0]).toEqual(["", "Choose automatically"]);
    expect(select.value).toBe("");
    // The installed voices are listed from the platform, not from a shipped list.
    expect(options.slice(1).map(o => o[1])).toEqual(["David", "Zira"]);

    await act(async () => { root.unmount(); });
  });

  test("a kept-but-missing choice stays visible in the control and is explained", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      narrator: true,
      narratorVoices: { en: { rate: 1, pitch: 1, voiceURI: "uri:from-the-other-laptop", voiceLabel: "Hong Kong Sinji" } },
    }));
    const { container, root } = await mount();

    const select = container.querySelector("#ocx-narrator-voice-en") as unknown as HTMLSelectElement;
    // Not silently reset to "automatic": the preference is still what it was.
    expect(select.value).toBe("uri:from-the-other-laptop");
    expect([...select.options].map(o => o.text)).toContain("Hong Kong Sinji");

    const status = container.querySelector("#ocx-narrator-status-en");
    expect(status?.textContent).toContain("Hong Kong Sinji");
    expect(status?.textContent).toContain("not installed on this computer");
    // The control points at its own explanation rather than leaving a screen
    // reader to stumble onto it.
    expect(select.getAttribute("aria-describedby")).toBe("ocx-narrator-status-en");

    await act(async () => { root.unmount(); });
  });

  // The machine this was written on has three en-US voices and no Cantonese one
  // at all, which is exactly the state that must be said out loud rather than
  // left as an empty dropdown.
  test("a language with no installed voice says so instead of showing an empty list", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ narrator: true, narratorLang: "zh-HK" }));
    const { container, root } = await mount();

    const select = container.querySelector("#ocx-narrator-voice-zh-HK") as unknown as HTMLSelectElement;
    expect([...select.options]).toHaveLength(1);
    expect(container.querySelector("#ocx-narrator-status-zh-HK")?.textContent)
      .toContain("No voice installed on this computer reports");

    await act(async () => { root.unmount(); });
  });

  // Before this, the bilingual chip stored the same value as the English chip,
  // so picking it lit both and narrated in English only.
  test("the bilingual chip selects serialized narration on its own", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ narrator: true, narratorLang: "en" }));
    const { container, root } = await mount();

    // Scoped to the narrator card on purpose: the interface-language card
    // renders an "English" chip of its own, and a document-wide lookup finds
    // that one first and asserts against the wrong control entirely.
    const card = [...container.querySelectorAll(".m3-card")]
      .find(c => c.querySelector(".m3-card-title")?.textContent === "Narrator")!;
    const chips = [...card.querySelectorAll(".m3-chip")] as unknown as HTMLButtonElement[];
    const both = chips.find(c => c.textContent === "Both (serialized)");
    const english = chips.find(c => c.textContent === "English");
    expect(both).toBeTruthy();
    expect(both!.getAttribute("aria-pressed")).toBe("false");
    expect(english!.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      both!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
    });

    expect(both!.getAttribute("aria-pressed")).toBe("true");
    expect(english!.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("#ocx-narrator-voice-zh-HK")).toBeTruthy();

    await act(async () => { root.unmount(); });
  });
});
