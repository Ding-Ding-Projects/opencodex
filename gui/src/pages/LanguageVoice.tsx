/**
 * Language & voice — interface language, the per-language funny level, the
 * speech-synthesis narrator, and the dim sum surprise.
 *
 * Order and anatomy follow the prototype's "Language and voice" section: a
 * body-large page lead, the language-mode card, the two funny-level sliders with
 * a live sample plus the five-level ladder, the narrator card, then the dim sum
 * card with its "show one now" control.
 *
 * The narrator is off by default, speaks one utterance at a time, and a new
 * message supersedes a pending one rather than queueing behind it.
 *
 * The dim sum switch lives here rather than under Appearance because it is a
 * voice-and-delight setting, not a theming one — and because the surprise it
 * governs is bilingual copy, so it belongs beside the language controls.
 *
 * The personal-vocabulary card closes the screen. It is the settings-page half
 * of the universal "local personal-vocabulary JSON upload" contract — the
 * other half is `src/i18n/personal-vocabulary.ts`, which this card is a thin
 * shell around, and `resolve.ts`'s `translate()`, which is where an uploaded
 * vocabulary actually takes effect. This card only ever shows a term count and
 * a rejection reason, never the terms themselves, so nothing about a user's
 * private glossary is legible from a screenshot of this screen.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from "react";
import { Button, Card, Chip, Field, Slider, TextInput, Toggle } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { IconSearch, IconSparkle, IconVolume } from "../icons";
import { LOCALES, useI18n, useT, type Locale, type TFn, type TKey, type Vars } from "../i18n/shared";
import { voiceCoverage, voiceFor, type FunnyLevel, type VoiceLang } from "../i18n/voice";
import { resolveTrack } from "../i18n/resolve";
import { decorateMessage, type MessageMarkKind } from "../shell/message-emoji";
import {
  clearVocabulary,
  getVocabularySnapshot,
  loadVocabularyFile,
  subscribeVocabulary,
  VOCAB_MAX_ENTRIES,
  VOCAB_MAX_FILE_BYTES,
  VOCAB_MAX_KEY_LENGTH,
  VOCAB_MAX_VALUE_LENGTH,
  type VocabParseResult,
  type VocabRejectReason,
  type VocabState,
} from "../i18n/personal-vocabulary";
import {
  DEFAULT_NARRATOR_VOICE,
  NARRATOR_BOTH,
  NARRATOR_PITCH,
  NARRATOR_RATE,
  usePrefs,
  type NarratorVoicePrefs,
} from "../theme/prefs-context";
import { cancelNarration, configureNarrator, narrate, narratorAvailable } from "../shell/narrator";
import {
  fetchEdgeVoices,
  filterVoices,
  resolveVoice,
  subscribeVoices,
  type VoiceOption,
} from "../shell/narrator-voices";
import { useNotifications } from "../shell/notifications-context";
import { DISHES, type DimSumDish } from "../shell/dimsum";
import { DishArt } from "../shell/DimSumCard";

const MONO = { fontFamily: "var(--mono)" } as const;

/** Funny levels run 1 (fully serious) → 5 (maximum playfulness), per language. */
const FUNNY_MIN = 1;
const FUNNY_MAX = 5;
const FUNNY_LEVELS = [1, 2, 3, 4, 5];

/** The "show one now" preview clears itself on the same timer as the launch card. */
const PREVIEW_MS = 12_000;

/**
 * The four live preview rows on the emoji card, one per snackbar tone. These are
 * the exact tones `SnackbarHost` reads `prefs.showEmojis` for, so what this card
 * shows is what a real notification will show — not a mocked-up sample of a
 * different decoration. Confirmation dialogs draw from two further marks
 * ("danger" and "question", see `shell/message-emoji.tsx`) that are not
 * previewed here separately: they style the same on/off switch, and a card
 * with six sample rows for one toggle is more clutter than confirmation.
 */
const EMOJI_PREVIEW_TONES: { kind: MessageMarkKind; tkey: TKey }[] = [
  { kind: "info", tkey: "emoji.previewInfo" },
  { kind: "success", tkey: "emoji.previewSuccess" },
  { kind: "warn", tkey: "emoji.previewWarn" },
  { kind: "error", tkey: "emoji.previewError" },
];

/**
 * Plain text is the default on every search bar; `.*` is an explicit opt-in.
 * An invalid pattern matches everything rather than blanking the screen, and the
 * error is reported beside the field instead of discarding what was typed.
 *
 * The shared matcher rather than a `new RegExp(query, "i")` of its own, so the
 * flags the anchored builder applied are the flags this screen is filtered by.
 * Compiling `i` regardless is what made the builder's own flag chips decorative
 * here, and made a pattern deliberately built as case-sensitive arrive
 * case-insensitive. It also drops `g`/`y`, whose `lastIndex` survives between
 * calls and would otherwise make one matcher reused down the sections keep every
 * other one.
 *
 * The one place this deliberately parts company with the shared result is the
 * invalid case. `settingsMatcher` matches *nothing* on a compile failure, which
 * is right for a settings list where an empty screen and a visible error read
 * together. This screen decided the other way — a half-typed pattern must not
 * blank a page the user is reading — so the error is surfaced and the list is
 * left alone.
 */
function useMatcher(query: string, useRegex: boolean, flags: string): { test: (s: string) => boolean; error: string } {
  return useMemo(() => {
    const matcher = settingsMatcher(query, useRegex, flags);
    if (matcher.error) return { test: () => true, error: matcher.error };
    return { test: matcher.test, error: "" };
  }, [query, useRegex, flags]);
}

/**
 * The disclosure the funny level owes the user: it restyles every message,
 * errors and destructive confirmations included, and never changes the facts.
 *
 * The ladder proves it rather than claiming it. It renders the *same* key at
 * all five levels, so the reader can see the voice change while the facts —
 * which sessions, that it is permanent, that there is no undo — stay put. Until
 * the voice overlay existed, every rung printed an identical sentence, which
 * demonstrated the opposite of what it was there to demonstrate.
 */
function FunnyLadder({ t, level, lang }: { t: TFn; level: number; lang: VoiceLang }) {
  const neutral = t("storage.cleanup.permanentWarn");
  return (
    <div style={{ marginTop: "var(--sp-3)" }}>
      <div className="m3-field-label">{t("lang.funnyLadder")}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {FUNNY_LEVELS.map(n => (
          <div
            key={n}
            style={{
              padding: "10px 12px",
              borderRadius: "var(--r-m)",
              background: n === level ? "var(--m3-secondary-container)" : "var(--m3-surface-container-highest)",
              color: n === level ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface-variant)",
            }}
          >
            <div style={{ fontSize: "var(--t-label-s)", fontWeight: 700, letterSpacing: "0.4px", textTransform: "uppercase", opacity: 0.7 }}>
              {t("lang.funnyLevel", { n })}
            </div>
            <div style={{ marginTop: 2, fontSize: "var(--t-body-s)" }} lang={lang === "yue" ? "zh-HK" : "en"}>
              {voiceFor(lang, "storage.cleanup.permanentWarn", n as FunnyLevel) ?? neutral}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * How long to wait for the platform's voice list before calling it settled.
 *
 * `speechSynthesis.getVoices()` commonly answers with an empty array and fills
 * in a moment later behind `voiceschanged` — measured on a Windows machine here
 * as 0 voices synchronously, then 3 after the event fired. A machine with
 * genuinely none installed may never fire the event at all, so without this the
 * picker would sit on "reading the voices…" for ever. We ask, we wait, and then
 * we report what there is.
 */
const VOICE_SETTLE_MS = 1500;

/** The narrated tracks, in speaking order, for a stored narrator language. */
function tracksFor(narratorLang: string): string[] {
  return narratorLang === NARRATOR_BOTH ? ["en", "zh-HK"] : [narratorLang];
}

/**
 * The voices this computer has, kept current as they arrive.
 *
 * The subscription is the whole point: a picker that reads `getVoices()` once
 * reports "no voices installed" on a machine with forty and looks broken rather
 * than slow. It unsubscribes on teardown, and `loaded` keeps "we have not been
 * told yet" distinct from "we asked, and there are none" — which are different
 * sentences the user needs to be able to tell apart.
 *
 * Lives here rather than in `narrator-voices.ts` so that module stays free of
 * React: `narrator.ts` imports it and has no business pulling in a renderer.
 */
function useInstalledVoices(): { voices: VoiceOption[]; loaded: boolean } {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const stop = subscribeVoices(next => {
      setVoices(next);
      if (next.length) setLoaded(true);
    });
    const settle = setTimeout(() => setLoaded(true), VOICE_SETTLE_MS);
    return () => {
      stop();
      clearTimeout(settle);
    };
  }, []);

  return { voices, loaded };
}

/**
 * The Microsoft Edge online voice catalogue, fetched only once opted in.
 *
 * Gated on `enabled` rather than fetched eagerly and hidden: an app that
 * contacts a third party before the user has agreed to it has already done the
 * thing the disclosure was asking permission for.
 */
function useEdgeVoices(enabled: boolean, apiBase: string): {
  voices: VoiceOption[];
  loading: boolean;
  available: boolean;
  error: string;
} {
  const [state, setState] = useState<{ voices: VoiceOption[]; loading: boolean; available: boolean; error: string }>(
    { voices: [], loading: false, available: false, error: "" },
  );

  useEffect(() => {
    if (!enabled) {
      setState({ voices: [], loading: false, available: false, error: "" });
      return;
    }
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: "" }));
    void fetchEdgeVoices(apiBase, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setState({
        voices: result.voices,
        loading: false,
        available: result.available,
        error: result.error ?? "",
      });
    });
    return () => controller.abort();
  }, [enabled, apiBase]);

  return state;
}

/**
 * One narrated language's voice, speed and pitch.
 *
 * Rendered once per track, so bilingual narration gets two of everything. That
 * is not duplication for its own sake: choosing an English voice says nothing
 * about which Cantonese voice should read the other half of the same line, and a
 * single shared picker would force one answer onto both.
 */
function VoiceTrack({ t, tag, label, settings, disabled, voices, loaded, edge, onChange }: {
  t: TFn;
  tag: string;
  label: string;
  settings: NarratorVoicePrefs;
  disabled: boolean;
  voices: VoiceOption[];
  loaded: boolean;
  edge: { enabled: boolean; available: boolean };
  onChange: (patch: Partial<NarratorVoicePrefs>) => void;
}) {
  // Each track owns its own query, mode and flags. One shared search would filter
  // the Cantonese list while the user was typing into the English one, and one
  // shared flag set would recompile the other track's pattern from here.
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  const resolution = resolveVoice(voices, tag, settings.voiceURI, loaded, edge);
  const statusId = `ocx-narrator-status-${tag}`;
  const selectId = `ocx-narrator-voice-${tag}`;
  const flagsId = `ocx-narrator-flags-${tag}`;

  const matched = filterVoices(resolution.candidates, query, useRegex, flags);
  const local = matched.filter(voice => voice.source === "local");
  const online = matched.filter(voice => voice.source === "edge");

  // A choice whose voice is not reachable right now still shows in the control,
  // so the kept preference is visible rather than silently reading as
  // "automatic" — the select would otherwise fall back to its first option and
  // quietly misreport what the user asked for.
  const keptElsewhere = ["missing", "edgeOff", "edgeUnavailable"].includes(resolution.kind)
    && settings.voiceURI
    && !matched.some(voice => voice.uri === settings.voiceURI);

  const status: string[] = [];
  if (resolution.kind === "loading") status.push(t("narrator.voiceLoading"));
  else if (resolution.kind === "none") status.push(t("narrator.voiceNone", { lang: label }));
  else if (resolution.kind === "platform") status.push(t("narrator.voicePlatform", { lang: label, n: resolution.candidates.length }));
  else if (resolution.kind === "chosen") status.push(t("narrator.voiceChosen", { name: resolution.voice!.name, lang: label }));
  else if (resolution.kind === "edgeOff") status.push(t("narrator.edgeOff", { name: settings.voiceLabel ?? settings.voiceURI ?? "", lang: label }));
  else if (resolution.kind === "edgeUnavailable") status.push(t("narrator.edgeUnavailable", { lang: label }));
  else status.push(t("narrator.voiceMissing", { name: settings.voiceLabel ?? settings.voiceURI ?? "", lang: label }));
  // Network-backed voices die when the machine goes offline, and nothing about
  // the name says so.
  if (resolution.network && resolution.voice) status.push(t("narrator.voiceNetwork", { name: resolution.voice.name }));
  if (edge.enabled && edge.available && online.length) status.push(t("narrator.edgeCount", { n: online.length, lang: label }));

  const voiceLabel = t("narrator.voiceFor", { lang: label });
  const searchLabel = `${t("narrator.voiceSearch")} — ${label}`;

  return (
    <div style={{ marginTop: "var(--sp-3)" }}>
      {/* The Edge catalogue runs to several hundred voices, so the list carries
          the same search-plus-anchored-builder every other list in the app has.
          Plain text stays the default; `.*` is an explicit opt-in. */}
      <div className="m3-row" role="search" style={{ marginBottom: 8 }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("narrator.voiceSearch")}
          aria-label={searchLabel}
          aria-describedby={useRegex ? flagsId : undefined}
          disabled={disabled}
          style={{ flex: "1 1 180px", width: "auto", minWidth: 0 }}
        />
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")} aria-label={t("regex.regexMode")}>
          <code style={MONO}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          // Both halves of what the builder composed, and this track's own flags
          // rather than the other track's — the two bars are independent, exactly
          // as their queries are.
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          sample={resolution.candidates.map(voice => `${voice.name} ${voice.lang}`).join("\n")}
          label={searchLabel}
        />
      </div>

      <SearchFlagsRow
        regex={useRegex}
        flags={flags}
        onFlagsChange={setFlags}
        id={flagsId}
      />

      <Field label={voiceLabel} id={selectId}>
        {/* Grouped rather than one flat list: which voices leave the machine and
            which do not is the most important thing about this control, so it
            is structure rather than a suffix on a name. */}
        <select
          id={selectId}
          className="m3-select"
          aria-label={voiceLabel}
          aria-describedby={statusId}
          disabled={disabled}
          value={settings.voiceURI ?? ""}
          onChange={event => {
            const uri = event.target.value;
            onChange({
              voiceURI: uri || undefined,
              // Stored beside the identity so a status line can name the voice
              // that went missing. It is display copy and is never matched on.
              voiceLabel: uri ? resolution.candidates.find(v => v.uri === uri)?.name : undefined,
            });
          }}
        >
          {/* Always first, and always the shipped default. Nothing ships with a
              named voice selected: the app cannot know what is installed until
              it asks, so naming one would be a preference for a voice most
              machines do not have. */}
          <option value="">{t("narrator.voiceAuto")}</option>
          {keptElsewhere && (
            <option value={settings.voiceURI}>{settings.voiceLabel ?? settings.voiceURI}</option>
          )}
          {local.length > 0 && (
            <optgroup label={t("narrator.edgeGroupLocal")}>
              {local.map(voice => <option key={voice.uri} value={voice.uri}>{voice.name}</option>)}
            </optgroup>
          )}
          {online.length > 0 && (
            <optgroup label={t("narrator.edgeGroupOnline")}>
              {online.map(voice => <option key={voice.uri} value={voice.uri}>{voice.name}</option>)}
            </optgroup>
          )}
        </select>
      </Field>
      {query.trim() && !matched.length && (
        <p style={{ margin: "4px 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
          {t("narrator.voiceNoMatch")}
        </p>
      )}
      <p
        id={statusId}
        style={{ margin: "4px 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}
      >
        {status.join(" ")}
      </p>

      <Slider
        id={`ocx-narrator-rate-${tag}`}
        value={settings.rate}
        min={NARRATOR_RATE.min}
        max={NARRATOR_RATE.max}
        step={NARRATOR_RATE.step}
        onChange={rate => onChange({ rate })}
        label={t("narrator.rate", { lang: label })}
        valueLabel={`${settings.rate.toFixed(1)}×`}
      />
      <Slider
        id={`ocx-narrator-pitch-${tag}`}
        value={settings.pitch}
        min={NARRATOR_PITCH.min}
        max={NARRATOR_PITCH.max}
        step={NARRATOR_PITCH.step}
        onChange={pitch => onChange({ pitch })}
        label={t("narrator.pitch", { lang: label })}
        valueLabel={settings.pitch.toFixed(1)}
      />
    </div>
  );
}

function FunnySample({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 8,
      padding: 12,
      borderRadius: "var(--r-m)",
      background: "var(--m3-surface-container-highest)",
      fontSize: "var(--t-body-s)",
    }}>
      {text}
    </div>
  );
}

/**
 * A thin React binding over the module-level vocabulary store. Lives here
 * rather than in `personal-vocabulary.ts` for the same reason
 * `useInstalledVoices` above lives here rather than in `narrator-voices.ts`:
 * that module stays free of React so `translate()` can import it with no
 * renderer in its dependency graph at all.
 */
function useVocabulary(): VocabState & {
  load: (file: File) => Promise<VocabParseResult>;
  clear: () => void;
} {
  const snapshot = useSyncExternalStore(subscribeVocabulary, getVocabularySnapshot, getVocabularySnapshot);
  return { ...snapshot, load: loadVocabularyFile, clear: clearVocabulary };
}

/** Every {@link VocabRejectReason} to the key that explains it in words a user
 *  can act on. Exhaustive by construction — a `VocabRejectReason` added to the
 *  schema without a row here is a compile error, not a silent "invalid". */
const VOCAB_REASON_KEY: Record<VocabRejectReason, TKey> = {
  "empty-file": "vocab.reason.emptyFile",
  "too-large": "vocab.reason.tooLarge",
  "malformed-json": "vocab.reason.malformedJson",
  "too-deep": "vocab.reason.tooDeep",
  "not-an-object": "vocab.reason.notAnObject",
  "unexpected-field": "vocab.reason.unexpectedField",
  "missing-field": "vocab.reason.missingField",
  "unknown-version": "vocab.reason.unknownVersion",
  "entries-not-object": "vocab.reason.entriesNotObject",
  "duplicate-key": "vocab.reason.duplicateKey",
  "unsafe-key": "vocab.reason.unsafeKey",
  "empty-key": "vocab.reason.emptyKey",
  "key-too-long": "vocab.reason.keyTooLong",
  "non-string-value": "vocab.reason.nonStringValue",
  "value-too-long": "vocab.reason.valueTooLong",
  "too-many-entries": "vocab.reason.tooManyEntries",
};

/** The `{limit}` a rejection's copy interpolates, in whichever unit the
 *  schema itself is bounded in — kilobytes for the file-size ceiling,
 *  characters or a count everywhere else. A reason that names no number
 *  resolves to no vars at all, which `t()` simply ignores. */
function vocabReasonVars(reason: VocabRejectReason): Vars | undefined {
  switch (reason) {
    case "too-large": return { limit: Math.round(VOCAB_MAX_FILE_BYTES / 1024) };
    case "key-too-long": return { limit: VOCAB_MAX_KEY_LENGTH };
    case "value-too-long": return { limit: VOCAB_MAX_VALUE_LENGTH };
    case "too-many-entries": return { limit: VOCAB_MAX_ENTRIES };
    default: return undefined;
  }
}

function describeVocabRejection(t: TFn, reason: VocabRejectReason): string {
  return t(VOCAB_REASON_KEY[reason], vocabReasonVars(reason));
}

/**
 * The personal-vocabulary card: a semantic file picker with no-file, loaded,
 * invalid, replace and clear states — per the universal contract, present on
 * every settings surface even before a file has ever been chosen.
 *
 * What it deliberately never renders is the vocabulary itself. The status
 * line says how many terms are active and, on a rejection, which documented
 * bound the file failed — never a term, a replacement, or the source file's
 * name. That is what keeps this card safe to screenshot: the evidence a
 * capture harness collects for this screen can never leak a user's private
 * glossary, because the glossary was never text this component put on screen.
 */
function VocabularyCard({ t }: { t: TFn }) {
  const vocab = useVocabulary();
  const { notify } = useNotifications();
  const fileRef = useRef<HTMLInputElement>(null);
  const count = vocab.doc ? Object.keys(vocab.doc.entries).length : 0;

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately, and unconditionally: without this, picking the exact
    // same filename twice in a row (to retry after fixing it, say) would not
    // fire a second `change` event at all.
    event.target.value = "";
    if (!file) return;
    const result = await vocab.load(file);
    if (result.ok) {
      notify({
        tone: "success",
        title: t("vocab.loadedNotice"),
        body: t("vocab.loadedNoticeBody", { count: Object.keys(result.doc.entries).length }),
      });
    } else {
      notify({ tone: "error", title: t("vocab.invalidNotice"), body: describeVocabRejection(t, result.reason) });
    }
  };

  const onClear = () => {
    vocab.clear();
    notify({ tone: "info", title: t("vocab.clearedNotice"), body: t("vocab.clearedNoticeBody") });
  };

  return (
    <Card key="vocab" title={t("vocab.title")} subtitle={t("vocab.sub")}>
      <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
        {t("vocab.privacyHint")}
      </p>
      <p style={{ margin: "0 0 var(--sp-3)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
        {t("vocab.limitsHint", {
          maxKb: Math.round(VOCAB_MAX_FILE_BYTES / 1024),
          maxEntries: VOCAB_MAX_ENTRIES,
          maxKeyLen: VOCAB_MAX_KEY_LENGTH,
          maxValueLen: VOCAB_MAX_VALUE_LENGTH,
        })}
      </p>

      {/* Hidden and triggered from the Button below — same shape as the
          profile importer on the Claude Desktop screen. A hidden input takes
          no place in the tab order, so the accessible control is the button. */}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={event => void onPick(event)}
      />

      <div className="m3-row" style={{ gap: 8 }}>
        <Button variant="outlined" onClick={() => fileRef.current?.click()}>
          {vocab.doc ? t("vocab.replaceLabel") : t("vocab.uploadLabel")}
        </Button>
        {vocab.doc && (
          <Button variant="outlined" onClick={onClear}>
            {t("vocab.clearLabel")}
          </Button>
        )}
      </div>

      <p
        role="status"
        style={{ margin: "var(--sp-2) 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}
      >
        {vocab.lastRejection
          ? t("vocab.stateInvalid", { reason: describeVocabRejection(t, vocab.lastRejection.reason) })
          : vocab.doc
            ? t("vocab.stateLoaded", { count })
            : t("vocab.stateNone")}
      </p>
    </Card>
  );
}

export default function LanguageVoice() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const { notify } = useNotifications();
  const [available] = useState(narratorAvailable);
  // The provider owns these: `t()` consults them on every lookup, so a copy
  // held here would restyle this screen and nothing else.
  const { funny, setFunny } = useI18n();
  const [preview, setPreview] = useState<DimSumDish | null>(null);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  /**
   * The flags this field compiles with. State rather than the `"i"` this search
   * used to hard-code: the builder beside the field composes a pattern *and* its
   * flags, and a field that pinned `i` showed a panel where turning on `m` or `s`
   * changed the preview and then changed nothing about which sections stayed.
   */
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  const apiBase = import.meta.env.VITE_API_BASE || "";
  const { voices: localVoices, loaded: voicesLoaded } = useInstalledVoices();
  const edge = useEdgeVoices(prefs.narratorEdge, apiBase);

  // One list behind one picker. The `source` field on each entry is what keeps
  // "this one leaves the machine" answerable after the merge.
  const voices = useMemo(() => [...localVoices, ...edge.voices], [localVoices, edge.voices]);

  const trackTags = useMemo(() => tracksFor(prefs.narratorLang), [prefs.narratorLang]);
  const narratorTracks = useMemo(
    () => trackTags.map(tag => {
      const settings = prefs.narratorVoices[tag] ?? DEFAULT_NARRATOR_VOICE;
      return { lang: tag, voiceURI: settings.voiceURI, rate: settings.rate, pitch: settings.pitch };
    }),
    [trackTags, prefs.narratorVoices],
  );

  useEffect(() => {
    configureNarrator({
      enabled: prefs.narrator,
      tracks: narratorTracks,
      apiBase,
      edgeEnabled: prefs.narratorEdge,
    });
    return () => cancelNarration();
  }, [prefs.narrator, narratorTracks, apiBase, prefs.narratorEdge]);

  // Non-blocking by contract: the preview never gates anything and clears itself.
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [preview]);

  const htmlLangFor = (code: string) => LOCALES.find(l => l.code === code)?.htmlLang ?? "en";

  /**
   * What a narrator-language chip stores.
   *
   * The bilingual locale maps to the serialized both-tracks mode rather than to
   * its html tag. Before this it stored `"en"` — the same value the English chip
   * stores, because `bi` renders as English — so picking "English + 廣東話" lit
   * *both* chips and narrated in English only. Bilingual narration is two
   * utterances, one per language, which needs a value of its own.
   */
  const narratorValueFor = (code: string) => (code === "bi" ? NARRATOR_BOTH : htmlLangFor(code));

  /** The display name of a narrated track, for the per-track labels and status. */
  const trackLabel = (tag: string) =>
    LOCALES.find(l => l.htmlLang === tag && l.code !== "bi")?.name ?? tag;

  /**
   * The sample sentence for one narrated track, resolved per track rather than
   * through `t()`.
   *
   * `t()` in bilingual mode returns `English · 廣東話` joined into one string,
   * and feeding that to one utterance is exactly the failure this whole change
   * exists to remove: one voice reading the other language's characters.
   */
  const sampleFor = (tag: string): string => {
    if (tag === "zh-HK") return resolveTrack("yue", "yue", funny.yue, "narrator.sample");
    const code = (LOCALES.find(l => l.htmlLang === tag && l.code !== "bi")?.code ?? "en") as Locale;
    return resolveTrack(code, "en", funny.en, "narrator.sample");
  };

  const setTrack = (tag: string, patch: Partial<NarratorVoicePrefs>) => {
    const current = prefs.narratorVoices[tag] ?? DEFAULT_NARRATOR_VOICE;
    setPrefs({ narratorVoices: { ...prefs.narratorVoices, [tag]: { ...current, ...patch } } });
  };

  const matcher = useMatcher(query, useRegex, flags);
  const permanentWarn = t("storage.cleanup.permanentWarn");

  const sections: { id: string; text: string; node: ReactNode }[] = [
    {
      id: "mode",
      text: [t("lang.title"), t("lang.sub"), t("lang.mode"), ...LOCALES.map(l => l.name)].join(" "),
      node: (
        <Card key="mode" title={t("lang.title")} subtitle={t("lang.sub")}>
          <Field label={t("lang.mode")}>
            <div className="m3-row" style={{ gap: 8 }}>
              {LOCALES.map(l => (
                <Chip
                  key={l.code}
                  lang={l.htmlLang}
                  selected={locale === l.code}
                  onClick={() => setLocale(l.code as Locale)}
                >
                  {l.name}
                </Chip>
              ))}
            </div>
          </Field>
        </Card>
      ),
    },
    {
      id: "funny",
      text: [t("lang.funnyEn"), t("lang.funnyYue"), t("lang.funnyLadder"), permanentWarn].join(" "),
      node: (
        <Card key="funny">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "var(--sp-3)" }}>
            <div>
              <Slider
                id="ocx-fun-en"
                value={funny.en}
                min={FUNNY_MIN}
                max={FUNNY_MAX}
                onChange={en => setFunny({ en: en as FunnyLevel })}
                label={t("lang.funnyEn")}
                valueLabel={t("lang.funnyLevel", { n: funny.en })}
              />
              <FunnySample text={permanentWarn} />
            </div>
            <div lang="yue">
              <Slider
                id="ocx-fun-yue"
                value={funny.yue}
                min={FUNNY_MIN}
                max={FUNNY_MAX}
                onChange={yue => setFunny({ yue: yue as FunnyLevel })}
                label={t("lang.funnyYue")}
                valueLabel={t("lang.funnyLevel", { n: funny.yue })}
              />
              <FunnySample text={permanentWarn} />
            </div>
          </div>
          <FunnyLadder t={t} level={funny.en} lang="en" />
          <FunnyLadder t={t} level={funny.yue} lang="yue" />
          <p style={{ marginTop: "var(--sp-2)", fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)" }}>
            {t("lang.funnyCoverage", { en: voiceCoverage("en"), yue: voiceCoverage("yue") })}
          </p>
        </Card>
      ),
    },
    {
      id: "narrator",
      text: [
        t("narrator.title"), t("narrator.sub"), t("narrator.enable"), t("narrator.enableHint"),
        t("narrator.language"), t("narrator.test"), t("narrator.langBoth"),
        t("narrator.voice"), t("narrator.voiceSub"), t("narrator.voiceAuto"),
        t("narrator.rateShort"), t("narrator.pitchShort"),
        t("narrator.edgeTitle"), t("narrator.edgeEnable"), t("narrator.edgeDisclosure"),
        t("narrator.voiceSearch"), t("narrator.installMore"),
        ...trackTags.map(tag => `${t("narrator.voiceFor", { lang: trackLabel(tag) })} ${t("narrator.rate", { lang: trackLabel(tag) })} ${t("narrator.pitch", { lang: trackLabel(tag) })}`),
      ].join(" "),
      node: (
        <Card
          key="narrator"
          title={t("narrator.title")}
          subtitle={t("narrator.sub")}
          actions={
            <Toggle
              on={prefs.narrator}
              disabled={!available}
              label={t("narrator.enable")}
              onChange={next => {
                setPrefs({ narrator: next });
                if (!next) cancelNarration();
              }}
            />
          }
        >
          {!available && (
            <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
              {t("narrator.unavailable")}
            </p>
          )}
          <p style={{ margin: "0 0 var(--sp-3)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
            {t("narrator.enableHint")}
          </p>

          <Field label={t("narrator.language")}>
            <div className="m3-row" style={{ gap: 8 }}>
              {LOCALES.map(l => (
                <Chip
                  key={l.code}
                  lang={l.htmlLang}
                  selected={prefs.narratorLang === narratorValueFor(l.code)}
                  onClick={() => setPrefs({ narratorLang: narratorValueFor(l.code) })}
                >
                  {l.code === "bi" ? t("narrator.langBoth") : l.name}
                </Chip>
              ))}
            </div>
          </Field>

          {prefs.narratorLang === NARRATOR_BOTH && (
            <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
              {t("narrator.bothOrder")}
            </p>
          )}

          {/* One picker per narrated language — two of them in bilingual mode,
              each with its own voice, speed, pitch and status. */}
          <div className="m3-field-label" style={{ marginTop: "var(--sp-3)" }}>{t("narrator.voice")}</div>
          <p style={{ margin: "2px 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
            {t("narrator.voiceSub")}
          </p>
          {trackTags.map(tag => (
            <VoiceTrack
              key={tag}
              t={t}
              tag={tag}
              label={trackLabel(tag)}
              settings={prefs.narratorVoices[tag] ?? DEFAULT_NARRATOR_VOICE}
              disabled={!available}
              voices={voices}
              loaded={voicesLoaded}
              edge={{ enabled: prefs.narratorEdge, available: edge.available }}
              onChange={patch => setTrack(tag, patch)}
            />
          ))}

          {/* The offline answer to "more voices", stated in words rather than
              as a button that may not be able to open anything. */}
          <p style={{ margin: "var(--sp-3) 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
            {t("narrator.installMore")}
          </p>

          {/* The network source. Its disclosure sits on the control that turns
              it on, not in a tooltip — enabling it is the moment the user is
              agreeing to send text to Microsoft, so that is where it is said. */}
          <div
            style={{
              marginTop: "var(--sp-3)",
              padding: "12px 16px",
              borderRadius: "var(--r-l)",
              background: "var(--m3-surface-container-highest)",
            }}
          >
            <div className="m3-row" style={{ justifyContent: "space-between", gap: 12 }}>
              <div className="m3-field-label" style={{ margin: 0 }}>{t("narrator.edgeTitle")}</div>
              <Toggle
                on={prefs.narratorEdge}
                label={t("narrator.edgeEnable")}
                onChange={next => setPrefs({ narratorEdge: next })}
              />
            </div>
            <p style={{ margin: "8px 0 0", fontSize: "var(--t-body-s)" }}>
              {t("narrator.edgeDisclosure")}
            </p>
            <p style={{ margin: "6px 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
              {t("narrator.edgeUnsupported")}
            </p>
            <p style={{ margin: "6px 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
              {t("narrator.edgeCantonese")}
            </p>
            {prefs.narratorEdge && (
              <p
                role="status"
                style={{
                  margin: "6px 0 0",
                  fontSize: "var(--t-label-m)",
                  color: edge.available || edge.loading ? "var(--m3-on-surface-variant)" : "var(--m3-error)",
                }}
              >
                {edge.loading
                  ? t("narrator.edgeLoading")
                  : edge.available
                    ? t("narrator.edgeCount", { n: edge.voices.length, lang: trackLabel(trackTags[0] ?? "en") })
                    : t("narrator.edgeFailed", { reason: edge.error || "unavailable" })}
              </p>
            )}
          </div>

          <Button
            variant="outlined"
            disabled={!available}
            style={{ marginTop: "var(--sp-3)" }}
            onClick={() => {
              // The narrator never speaks while it is off — the button says so
              // instead of silently doing nothing.
              if (!prefs.narrator) {
                notify({ tone: "warn", title: t("narrator.offTitle"), body: t("narrator.offBody") });
                return;
              }
              // Resolved per track: the bilingual sample is two sentences spoken
              // one after the other, never one joined string read by one voice.
              const [first, second] = trackTags;
              narrate(first ? sampleFor(first) : "", second ? sampleFor(second) : undefined);
              notify({ tone: "success", title: t("narrator.spoke"), body: t("narrator.enableHint") });
            }}
          >
            <IconVolume aria-hidden />
            {t("narrator.test")}
          </Button>
        </Card>
      ),
    },
    {
      id: "emoji",
      text: [
        t("emoji.title"), t("emoji.sub"), t("emoji.previewCaption"),
        ...EMOJI_PREVIEW_TONES.map(item => t(item.tkey)),
      ].join(" "),
      node: (
        <Card
          key="emoji"
          title={t("emoji.title")}
          subtitle={t("emoji.sub")}
          actions={
            <Toggle
              on={prefs.showEmojis}
              label={t("emoji.title")}
              onChange={next => setPrefs({ showEmojis: next })}
            />
          }
        >
          <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
            {t("emoji.previewCaption")}
          </p>
          {/* Live previews, not a description of the feature: each row runs the
              exact same `decorateMessage` call a real snackbar makes, with the
              toggle above driving both. Proof that the switch changes rendered
              output, in the one place a reader can see it change as they flip it. */}
          <div style={{ display: "grid", gap: 6 }}>
            {EMOJI_PREVIEW_TONES.map(item => (
              <div
                key={item.kind}
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--r-m)",
                  background: "var(--m3-surface-container-highest)",
                  fontSize: "var(--t-body-s)",
                }}
              >
                {decorateMessage(item.kind, t(item.tkey), prefs.showEmojis)}
              </div>
            ))}
          </div>
        </Card>
      ),
    },
    {
      id: "dimsum",
      text: [t("dimsum.toggle"), t("dimsum.toggleHint"), t("dimsum.showNow")].join(" "),
      // No `actions` switch on this card, by contract: the surprise cannot be
      // turned off. What the card still owes the reader is an honest account of
      // when it can appear and a way to see one on demand, so nobody has to wait
      // out the odds to find out what the thing they cannot disable looks like.
      node: (
        <Card
          key="dimsum"
          title={t("dimsum.toggle")}
          subtitle={t("dimsum.toggleHint")}
        >
          <Button
            variant="outlined"
            onClick={() => setPreview(DISHES[Math.floor(Math.random() * DISHES.length)] ?? null)}
          >
            <IconSparkle aria-hidden />
            {t("dimsum.showNow")}
          </Button>

          {preview && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: "var(--sp-3)",
                padding: "12px 16px",
                borderRadius: "var(--r-l)",
                background: "var(--m3-tertiary-container)",
                color: "var(--m3-on-tertiary-container)",
              }}
            >
              {/* Same art path as the real card, so the preview shows exactly
                  what a launch would — photo when one is bundled, stand-in when
                  it is not. */}
              <DishArt dish={preview} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "var(--t-title-s)" }}>{t("dimsum.title")}</div>
                <div style={{ fontSize: "var(--t-body-s)" }}>
                  <span lang="zh-HK">{preview.zh}</span>
                  {" · "}
                  <span>{preview.name}</span>
                  <div style={{ fontSize: "var(--t-label-s)", opacity: 0.85, fontStyle: "italic" }}>{preview.jyutping}</div>
                </div>
              </div>
            </div>
          )}
        </Card>
      ),
    },
    {
      id: "vocabulary",
      text: [
        t("vocab.title"), t("vocab.sub"), t("vocab.uploadLabel"), t("vocab.replaceLabel"), t("vocab.clearLabel"),
      ].join(" "),
      node: <VocabularyCard key="vocab" t={t} />,
    },
  ];

  const visible = sections.filter(s => matcher.test(s.text));

  return (
    <>
      <p className="m3-page-lead">{t("lang.subtitle")}</p>

      {/* Every settings surface carries its own search, wired to the regex builder. */}
      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-3)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={!!matcher.error}
          aria-describedby={useRegex ? "lang-regex-error lang-regex-flags-state" : "lang-regex-error"}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")} aria-label={t("regex.regexMode")}>
          <code style={MONO}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          // Both halves of what the builder composed. Taking the pattern and
          // leaving the flags behind is what made the popover's flag chips
          // decorative from this field's point of view.
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          // The searchable text of this screen's own sections, so a pattern is
          // tried against the settings it will actually filter.
          sample={sections.map(s => s.text).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <SearchFlagsRow
        regex={useRegex}
        flags={flags}
        onFlagsChange={setFlags}
        id="lang-regex-flags-state"
      />
      {matcher.error && (
        <p id="lang-regex-error" role="alert" style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
          {`${t("regex.invalid")}: ${matcher.error}`}
        </p>
      )}

      {visible.map(s => s.node)}

      {!visible.length && (
        <p style={{ margin: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-m)" }}>
          {t("settings.noMatch")}
        </p>
      )}
    </>
  );
}
