/**
 * The command palette — `Ctrl+Shift+F`, one search over every page and every
 * setting the app has.
 *
 * This is the feature contract a completeness audit found entirely absent from
 * this codebase: no palette, no shortcut, no index, in any form. What follows
 * is built from that blank slate against the same rules every other search
 * surface here already follows — `command-palette-index.ts` builds the list
 * from data that already exists (`page-meta.ts`'s pages, `settings-registry.ts`'s
 * cross-page settings index) rather than a hand-curated third copy of either,
 * and this component's own search bar is wired to the same anchored regex
 * builder every settings screen carries.
 *
 * ## Rows are controls where a control can be honest, readouts everywhere else
 *
 * The contract asks for "rows are rich controls, not just labels" — but a
 * decorative switch that looks live and changes nothing is exactly the defect
 * class these rules exist to stop, and most of the app's 80 registered settings
 * are edited by state that lives on the page that owns them, not anywhere this
 * component can safely reach without duplicating fourteen pages' worth of
 * fetch-and-local-state logic. So a row is wired to a real control only when
 * its value already lives somewhere global — `usePrefs()`, the locale and
 * funny-level draft, or the `Settings` page's staged server snapshot once that
 * page has loaded it — and `command-palette-index.ts`'s `liveControlKindFor`
 * is the single place that says which rows qualify. Every other row renders an
 * honest readout naming the screen that actually edits it, and selecting *any*
 * row — live or not — teleports there.
 *
 * ## Teleporting without touching the pages it lands on
 *
 * `command-palette-teleport.ts` finds the target row by the translated label
 * text the owning page already renders, rather than a `data-*` anchor this
 * build would have had to add to all fourteen settings screens — see that
 * module's header for why. It is fuzzy, in the sense that any text-content
 * search is, but every registry row's label is close to unique on its own page.
 *
 * ## Size is a user choice
 *
 * `Ctrl+Shift+F` toggles a bounded card by default; the header carries a control
 * that expands it to most of the window, and that choice is persisted in
 * `localStorage` under `ocx-m3:palette-size` the same way every other shell
 * preference is.
 */

import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { Chip, Dialog, Segmented, SelectField, Slider, TextInput, Toggle } from "./m3-ui";
import { RegexBuilderButton } from "./RegexBuilderButton";
import { SearchFlagsRow } from "./SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS } from "./settings-search";
import {
  buildPaletteIndex, filterPaletteEntries, liveControlSource, paletteSample,
  type LiveControlKind, type PaletteDestination, type PaletteEntry, type PaletteSetting,
} from "./command-palette-index";
import { teleportToSetting } from "./command-palette-teleport";
import { PAGE_META_BY_ID } from "./page-meta";
import { IconSearch, IconWinMaximize, IconWinRestore, IconX } from "../icons";
import { LOCALES, useI18n } from "../i18n/shared";
import type { FunnyLevels, Locale, TFn } from "../i18n/shared";
import type { FunnyLevel } from "../i18n/voice";
import { usePrefs } from "../theme/prefs-context";
import type { PrefsContextValue } from "../theme/prefs-context";
import type { DensityLevel, ThemeMode } from "../theme/m3";
import { useSettingsDrafts } from "../settings-drafts-context";
import type { SettingsDraftContextValue } from "../settings-drafts-context";
import type {
  CleanupPolicySettings, DebugFlags, InjectionSettings, MultiAgentMode,
  ProxySettings, ShadowCallSettings, SettingsSnapshot,
} from "../pages/settings-shared";
import { formatHex, parseColor } from "../../../shared/m3/color";
import type { TabsApi } from "./use-tabs";
import { SHORTCUTS, matchesShortcut } from "./keyboard-shortcuts";

const MONO = { fontFamily: "var(--mono)" } as const;
const SIZE_KEY = "ocx-m3:palette-size";

/** Dispatched by the app-bar trigger; the shortcut below listens for the same event so the two open paths share one code path. */
export const PALETTE_OPEN_EVENT = "ocx:command-palette-open";

type PaletteSize = "bounded" | "full";

function readSize(): PaletteSize {
  try {
    return localStorage.getItem(SIZE_KEY) === "full" ? "full" : "bounded";
  } catch {
    return "bounded";
  }
}

function writeSize(size: PaletteSize): void {
  try { localStorage.setItem(SIZE_KEY, size); } catch { /* quota — the choice just does not survive a reload */ }
}

/**
 * `requestAnimationFrame`, where it exists; `setTimeout` where it does not —
 * the same fallback `command-palette-teleport.ts`'s own scheduler uses, for
 * the same reason: not every environment this runs in (the test harness among
 * them) carries it, and a focus effect that throws on mount is worse than one
 * that lands a frame later than it ideally would.
 */
function scheduleFrame(run: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(run);
  return setTimeout(run, 16) as unknown as number;
}
function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/** Whether the server-backed group a snapshot row reads from has ever loaded, this session. */
function snapshotGroupReady(kind: LiveControlKind, settings: SettingsSnapshot | null): boolean {
  if (!settings) return false;
  switch (kind) {
    case "codexAutoStart": return settings.proxy !== null;
    case "shadowCall": return settings.shadowCall !== null;
    case "maMode": return settings.maMode !== null;
    case "multiAgentGuidance":
    case "syncCodexSubagentDefaults": return settings.injection !== null;
    case "policyEnabled":
    case "policySchedule": return settings.policy !== null;
    case "debugDebug":
    case "debugUsage":
    case "debugInjection":
    case "debugClaude": return settings.debug !== null;
    default: return false;
  }
}

/** A hex-swatch preview plus a plain text box — the same value `ColorField` writes on Appearance, without pulling in the whole infinite picker. */
function SeedControl({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  // Resets the draft when the applied seed changes for a reason other than
  // this box's own edit — a global "reset appearance", or the row simply
  // being reopened on a fresh render. Adjusted during render rather than in
  // an effect (react.dev's own "adjusting state when a prop changes"
  // pattern): the draft has to match `value` before the browser paints a
  // stale hex, not one render late.
  const [committedValue, setCommittedValue] = useState(value);
  if (value !== committedValue) {
    setCommittedValue(value);
    setDraft(value);
  }
  const commit = () => {
    const parsed = draft ? parseColor(draft) : null;
    if (parsed) onChange(formatHex(parsed));
    else setDraft(value);
  };
  return (
    <div className="m3-palette-row-control">
      <span
        aria-hidden="true"
        style={{ width: 20, height: 20, borderRadius: "50%", background: value, border: "1px solid var(--m3-outline-variant)", flex: "0 0 auto" }}
      />
      <TextInput
        aria-label={label}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        style={{ width: 110, ...MONO }}
      />
    </div>
  );
}

interface LiveControlProps {
  entry: PaletteSetting;
  t: TFn;
  prefs: PrefsContextValue;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  funny: FunnyLevels;
  setFunny: (patch: Partial<FunnyLevels>) => void;
  drafts: SettingsDraftContextValue;
}

/** Renders the real control for a live row, or the honest reason there is none. */
function LiveControl({ entry, t, prefs, locale, setLocale, funny, setFunny, drafts }: LiveControlProps) {
  const kind = entry.live;
  if (!kind) {
    return <p className="m3-palette-row-hint">{t("commandPalette.editOnPage", { tab: entry.tabLabel })}</p>;
  }

  const source = liveControlSource(kind);
  if (source === "snapshot" && !snapshotGroupReady(kind, drafts.settings)) {
    return <p className="m3-palette-row-hint">{t("commandPalette.loadOnPage", { tab: entry.tabLabel })}</p>;
  }

  const setProxy = (patch: Partial<ProxySettings>) => drafts.setSettings(
    prev => (prev.proxy ? { ...prev, proxy: { ...prev.proxy, ...patch } } : prev),
  );
  const setShadowCall = (patch: Partial<ShadowCallSettings>) => drafts.setSettings(
    prev => (prev.shadowCall ? { ...prev, shadowCall: { ...prev.shadowCall, ...patch } } : prev),
  );
  const setInjection = (patch: Partial<InjectionSettings>) => drafts.setSettings(
    prev => (prev.injection ? { ...prev, injection: { ...prev.injection, ...patch } } : prev),
  );
  const setPolicy = (patch: Partial<CleanupPolicySettings>) => drafts.setSettings(
    prev => (prev.policy ? { ...prev, policy: { ...prev.policy, ...patch } } : prev),
  );
  const setDebug = (patch: Partial<DebugFlags>) => drafts.setSettings(
    prev => (prev.debug ? { ...prev, debug: { ...prev.debug, ...patch } } : prev),
  );

  switch (kind) {
    case "theme":
      return (
        <div className="m3-palette-row-control">
          <Segmented<ThemeMode>
            label={entry.label}
            value={prefs.prefs.theme}
            onChange={theme => prefs.setPrefs({ theme })}
            options={[
              { value: "light", label: t("theme.light") },
              { value: "dark", label: t("theme.dark") },
              { value: "system", label: t("theme.system") },
            ]}
          />
        </div>
      );
    case "seed":
      return <SeedControl value={prefs.prefs.seed} onChange={seed => prefs.setPrefs({ seed })} label={entry.label} />;
    case "density":
      return (
        <div className="m3-palette-row-control">
          <Slider
            id="palette-density" label={entry.label} min={1} max={5}
            value={prefs.prefs.density} valueLabel={String(prefs.prefs.density)}
            onChange={v => prefs.setPrefs({ density: v as DensityLevel })}
          />
        </div>
      );
    case "fontScale":
      return (
        <div className="m3-palette-row-control">
          <Slider
            id="palette-fontscale" label={entry.label} min={0.85} max={1.4} step={0.05}
            value={prefs.prefs.fontScale} valueLabel={`${Math.round(prefs.prefs.fontScale * 100)}%`}
            onChange={fontScale => prefs.setPrefs({ fontScale })}
          />
        </div>
      );
    case "fontWeight":
      return (
        <div className="m3-palette-row-control">
          <Slider
            id="palette-fontweight" label={entry.label} min={300} max={600} step={50}
            value={prefs.prefs.fontWeight} valueLabel={String(prefs.prefs.fontWeight)}
            onChange={fontWeight => prefs.setPrefs({ fontWeight })}
          />
        </div>
      );
    case "locale":
      return (
        <div className="m3-palette-row-control">
          <SelectField
            label={entry.label}
            value={locale}
            onChange={next => setLocale(next as Locale)}
            options={LOCALES.map(item => ({ value: item.code, label: item.name }))}
          />
        </div>
      );
    case "funnyEn":
      return (
        <div className="m3-palette-row-control">
          <Slider
            id="palette-funny-en" label={entry.label} min={1} max={5}
            value={funny.en} valueLabel={String(funny.en)}
            onChange={v => setFunny({ en: v as FunnyLevel })}
          />
        </div>
      );
    case "funnyYue":
      return (
        <div className="m3-palette-row-control">
          <Slider
            id="palette-funny-yue" label={entry.label} min={1} max={5}
            value={funny.yue} valueLabel={String(funny.yue)}
            onChange={v => setFunny({ yue: v as FunnyLevel })}
          />
        </div>
      );
    case "narrator":
      return (
        <div className="m3-palette-row-control">
          <Toggle on={prefs.prefs.narrator} onChange={narrator => prefs.setPrefs({ narrator })} label={t("narrator.enable")} />
        </div>
      );
    case "codexAutoStart":
      return (
        <div className="m3-palette-row-control">
          <Toggle
            on={drafts.settings!.proxy!.codexAutoStart}
            onChange={codexAutoStart => setProxy({ codexAutoStart })}
            label={entry.label}
          />
        </div>
      );
    case "shadowCall":
      return (
        <div className="m3-palette-row-control">
          <Toggle
            on={drafts.settings!.shadowCall!.enabled}
            onChange={enabled => setShadowCall({ enabled })}
            label={entry.label}
          />
        </div>
      );
    case "maMode":
      return (
        <div className="m3-palette-row-control">
          <Segmented<MultiAgentMode>
            label={entry.label}
            value={drafts.settings!.maMode!}
            onChange={maMode => drafts.setSettings(prev => ({ ...prev, maMode }))}
            options={[
              { value: "v1", label: t("models.v2Mode_v1") },
              { value: "default", label: t("models.v2Mode_default") },
              { value: "v2", label: t("models.v2Mode_v2") },
            ]}
          />
        </div>
      );
    case "multiAgentGuidance":
      return (
        <div className="m3-palette-row-control">
          <Toggle
            on={drafts.settings!.injection!.multiAgentGuidanceEnabled}
            onChange={multiAgentGuidanceEnabled => setInjection({ multiAgentGuidanceEnabled })}
            label={entry.label}
          />
        </div>
      );
    case "syncCodexSubagentDefaults":
      return (
        <div className="m3-palette-row-control">
          <Toggle
            on={drafts.settings!.injection!.syncCodexSubagentDefaults}
            onChange={syncCodexSubagentDefaults => setInjection({ syncCodexSubagentDefaults })}
            label={entry.label}
          />
        </div>
      );
    case "policyEnabled":
      return (
        <div className="m3-palette-row-control">
          <Toggle
            on={drafts.settings!.policy!.enabled}
            onChange={enabled => setPolicy({ enabled })}
            label={entry.label}
          />
        </div>
      );
    case "policySchedule":
      return (
        <div className="m3-palette-row-control">
          <SelectField
            label={entry.label}
            value={drafts.settings!.policy!.schedule}
            onChange={schedule => setPolicy({ schedule: schedule as CleanupPolicySettings["schedule"] })}
            options={[
              { value: "manual", label: t("storage.policy.schedule.manual") },
              { value: "startup", label: t("storage.policy.schedule.startup") },
              { value: "daily", label: t("storage.policy.schedule.daily") },
              { value: "weekly", label: t("storage.policy.schedule.weekly") },
            ]}
          />
        </div>
      );
    case "debugDebug":
      return (
        <div className="m3-palette-row-control">
          <Toggle on={drafts.settings!.debug!.debug} onChange={debug => setDebug({ debug })} label={entry.label} />
        </div>
      );
    case "debugUsage":
      return (
        <div className="m3-palette-row-control">
          <Toggle on={drafts.settings!.debug!.usage} onChange={usage => setDebug({ usage })} label={entry.label} />
        </div>
      );
    case "debugInjection":
      return (
        <div className="m3-palette-row-control">
          <Toggle on={drafts.settings!.debug!.injection} onChange={injection => setDebug({ injection })} label={entry.label} />
        </div>
      );
    case "debugClaude":
      return (
        <div className="m3-palette-row-control">
          <Toggle on={drafts.settings!.debug!.claude} onChange={claude => setDebug({ claude })} label={entry.label} />
        </div>
      );
    default:
      return null;
  }
}

export interface CommandPaletteProps {
  tabs: TabsApi;
}

export default function CommandPalette({ tabs }: CommandPaletteProps) {
  const { t, locale, setLocale, funny, setFunny } = useI18n();
  const prefs = usePrefs();
  const drafts = useSettingsDrafts();

  const [open, setOpen] = useState(false);
  // Tracked so a closed-to-open transition can be caught during render — see
  // the reset block below, right after `results` is computed.
  const [committedOpen, setCommittedOpen] = useState(open);
  const [size, setSize] = useState<PaletteSize>(readSize);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [activeIndex, setActiveIndex] = useState(0);

  const mainRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const flagsStateId = useId();
  // `TextInput` is a plain function component with no forwarded ref (the same
  // reason `RegexBuilderButton.tsx`'s own pattern field is looked up by id
  // rather than held in a ref) — so the search field is found and focused by
  // its id instead.
  const searchFieldId = useId();
  const focusSearchField = useCallback(
    () => (document.getElementById(searchFieldId) as HTMLInputElement | null)?.focus(),
    [searchFieldId],
  );

  // Every open reseeds a blank query — a palette that remembered the last
  // search would show yesterday's results for a moment before anyone has
  // typed anything today. Reset during render (react.dev's "adjusting state
  // when a prop changes" pattern) rather than a `useEffect`, so the closed
  // -to-open transition never paints the stale query even for one frame.
  if (open !== committedOpen) {
    setCommittedOpen(open);
    if (open) {
      setQuery("");
      setUseRegex(false);
    }
  }

  const index = useMemo(() => buildPaletteIndex(t), [t]);
  const { results, error } = useMemo(
    () => filterPaletteEntries(index, query, useRegex, flags),
    [index, query, useRegex, flags],
  );

  // The active row resets to the top whenever the query, its mode or its flags
  // change — a fresh filter starting where the old one left off would highlight
  // whatever row happened to land at that position, not the best match. Reset
  // during render (react.dev's "adjusting state when a prop changes" pattern)
  // rather than a `useEffect`, so the very first paint of a new filter already
  // shows the right row highlighted instead of flashing the stale one for a frame.
  const filterKey = `${query} ${String(useRegex)} ${flags}`;
  const [committedFilterKey, setCommittedFilterKey] = useState(filterKey);
  if (filterKey !== committedFilterKey) {
    setCommittedFilterKey(filterKey);
    setActiveIndex(0);
  }

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, SHORTCUTS.commandPalette)) return;
      event.preventDefault();
      setOpen(o => !o);
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    // Cleared here rather than during the render-time reset above: mutating a
    // ref's `.current` while rendering is exactly the "outside render" rule
    // effects exist to satisfy, even though this array holds no state React
    // itself tracks.
    mainRefs.current = [];
    let raf = 0;
    // Two frames: the first lets `Dialog`'s own `showModal()` effect run first —
    // that call itself moves focus, and landing after it is what makes this the
    // focus a keyboard user actually ends up with rather than a call the native
    // dialog overwrites a moment later.
    const first = scheduleFrame(() => {
      raf = scheduleFrame(focusSearchField);
    });
    return () => { cancelFrame(first); cancelFrame(raf); };
  }, [open, focusSearchField]);

  const activate = useCallback((entry: PaletteEntry) => {
    setOpen(false);
    if (entry.kind === "destination") {
      tabs.openPage(entry.page);
      return;
    }
    void teleportToSetting(
      { page: entry.page, label: entry.label },
      { openPage: tabs.openPage, getRoot: () => document.querySelector(".m3-page-inner:not([hidden])") },
    );
  }, [tabs]);

  const focusRow = (index: number) => {
    const el = mainRefs.current[index];
    if (el) { el.focus(); setActiveIndex(index); }
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) focusRow(0);
    } else if (event.key === "Enter") {
      if (results.length === 0) return;
      event.preventDefault();
      activate(results[Math.min(activeIndex, results.length - 1)]!);
    }
  };

  const onRowKeyDown = (rowIndex: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (rowIndex + 1 < results.length) focusRow(rowIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rowIndex === 0) { focusSearchField(); setActiveIndex(0); }
      else focusRow(rowIndex - 1);
    }
  };

  const toggleSize = () => {
    setSize(current => {
      const next = current === "full" ? "bounded" : "full";
      writeSize(next);
      return next;
    });
  };

  function renderDestination(entry: PaletteDestination, rowIndex: number): ReactNode {
    const Icon = PAGE_META_BY_ID[entry.page].Icon;
    return (
      <button
        type="button"
        ref={el => { mainRefs.current[rowIndex] = el; }}
        className="m3-palette-row-main"
        onClick={() => activate(entry)}
        onFocus={() => setActiveIndex(rowIndex)}
        onKeyDown={onRowKeyDown(rowIndex)}
        aria-label={t("commandPalette.goTo", { label: entry.label })}
      >
        <Icon aria-hidden />
        <span className="m3-palette-row-text">
          <span className="m3-palette-row-label">{entry.label}</span>
        </span>
        <span className="m3-palette-row-badge">{t("commandPalette.kindPage")}</span>
      </button>
    );
  }

  function renderSetting(entry: PaletteSetting, rowIndex: number): ReactNode {
    const describedLabel = entry.desc ? `${entry.label}. ${entry.desc}` : entry.label;
    return (
      <>
        <button
          type="button"
          ref={el => { mainRefs.current[rowIndex] = el; }}
          className="m3-palette-row-main"
          onClick={() => activate(entry)}
          onFocus={() => setActiveIndex(rowIndex)}
          onKeyDown={onRowKeyDown(rowIndex)}
          aria-label={`${t("commandPalette.goTo", { label: describedLabel })}. ${entry.tabLabel}`}
        >
          {entry.desc
            ? (
              <span className="m3-palette-row-text">
                <span className="m3-palette-row-label">{entry.label}</span>
                <span className="m3-palette-row-desc">{entry.desc}</span>
              </span>
            )
            : (
              <span className="m3-palette-row-text">
                <span className="m3-palette-row-label">{entry.label}</span>
              </span>
            )}
          <span className="m3-palette-row-badge">{entry.tabLabel}</span>
        </button>
        <LiveControl entry={entry} t={t} prefs={prefs} locale={locale} setLocale={setLocale} funny={funny} setFunny={setFunny} drafts={drafts} />
      </>
    );
  }

  if (!open) return null;

  const trimmedQuery = query.trim();

  return (
    <Dialog
      open
      onClose={close}
      title={t("commandPalette.title")}
      width={size === "full" ? 1400 : 640}
      headAction={
        <div className="m3-row" style={{ gap: 4 }}>
          <button
            type="button"
            className="m3-icon-btn"
            onClick={toggleSize}
            aria-label={t(size === "full" ? "commandPalette.collapse" : "commandPalette.expand")}
            title={t(size === "full" ? "commandPalette.collapse" : "commandPalette.expand")}
          >
            {size === "full" ? <IconWinRestore aria-hidden /> : <IconWinMaximize aria-hidden />}
          </button>
          <button type="button" className="m3-icon-btn" onClick={close} aria-label={t("commandPalette.close")} title={t("commandPalette.close")}>
            <IconX aria-hidden />
          </button>
        </div>
      }
    >
      <div className={`m3-palette${size === "full" ? " m3-palette--full" : ""}`}>
        <div className="m3-row m3-palette-search" role="search">
          <IconSearch width={20} height={20} aria-hidden="true" />
          <TextInput
            id={searchFieldId}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t("commandPalette.searchPlaceholder")}
            aria-label={t("commandPalette.searchLabel")}
            aria-invalid={!!error}
            aria-describedby={useRegex ? flagsStateId : undefined}
            style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
          />
          <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("regex.regexMode")}>
            <code style={MONO}>.*</code>
          </Chip>
          <RegexBuilderButton
            value={query}
            onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
            regex={useRegex}
            onRegexChange={setUseRegex}
            flags={flags}
            sample={paletteSample(index)}
            label={t("settings.openBuilder")}
          />
        </div>
        <SearchFlagsRow regex={useRegex} flags={flags} onFlagsChange={setFlags} id={flagsStateId} />
        <p
          role="status"
          style={{ minHeight: 20, margin: "4px 0 8px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}
        >
          {error ? `${t("regex.invalid")}: ${error}` : trimmedQuery && results.length === 0 ? t("commandPalette.noResults", { query: trimmedQuery }) : ""}
        </p>

        {results.length === 0 ? (
          <div className="m3-palette-empty">
            {trimmedQuery ? t("commandPalette.noResults", { query: trimmedQuery }) : ""}
          </div>
        ) : (
          <ul className="m3-palette-results">
            {results.flatMap((entry, rowIndex) => {
              const out: ReactNode[] = [];
              if (rowIndex === 0 || results[rowIndex - 1]!.kind !== entry.kind) {
                out.push(
                  <li key={`heading-${entry.kind}`} className="m3-palette-group-heading" role="presentation">
                    {t(entry.kind === "destination" ? "commandPalette.destinationsGroup" : "commandPalette.settingsGroup")}
                  </li>,
                );
              }
              out.push(
                <li
                  key={entry.entryId}
                  className={`m3-palette-row${rowIndex === activeIndex ? " m3-palette-row--active" : ""}`}
                >
                  {entry.kind === "destination" ? renderDestination(entry, rowIndex) : renderSetting(entry, rowIndex)}
                </li>,
              );
              return out;
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
