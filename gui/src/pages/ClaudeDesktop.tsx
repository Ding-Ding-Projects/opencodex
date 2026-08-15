import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { LANE_PAGE, defaultCollapsedFamilies, laneView, rowStartsOpen } from "./claude-desktop-lane";
import { makeCollapseStore, toggleInSet } from "./collapse-store";
import { IconChevron, IconSearch } from "../icons";
import { BADGE_TONE_STYLE, Banner, Button, Chip, Empty, TextInput } from "../shell/m3-ui";
import { useNotifications } from "../shell/notifications-context";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS } from "../shell/settings-search";
import { makeMatcher } from "./models-shared";
import { claudeSettingLabels } from "./claude-settings-search";
import { useT, type TFn, type TKey } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { createBoundedFetch } from "../bounded-fetch";

const FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
type Family = typeof FAMILIES[number];

/**
 * How many of a lane's models are handed to its anchored builder as sample text.
 * Built on every render of the lane, so it is bounded: a catalogue of hundreds of
 * models would otherwise be joined into a string for a panel that is usually shut.
 */
const LANE_SAMPLE_ROWS = 40;

/**
 * Family collapse lives under its own key: the Models page collapses PROVIDERS, and a
 * shared key would make folding "opus" here fold a provider of the same name there.
 */
const FAMILY_COLLAPSE = makeCollapseStore("ocx.claudeDesktop.collapsedFamilies.v1");

interface Assignment {
  family: Family;
  alias: string;
}

interface DesktopProfile {
  version: 1;
  assignments: Record<string, Assignment>;
  defaults: Record<Family, string | null>;
  /** Written by the apply route; mirrors OcxClaudeDesktopProfile so a round-trip keeps them. */
  appliedFingerprint?: string;
  appliedAt?: string;
}

interface DesktopModel {
  route: string;
  label: string;
  available: boolean;
  contextWindow?: number;
  effortSupported?: boolean;
  supports1m?: boolean;
  assignment: Assignment;
}

interface DesktopStatus {
  applied: boolean;
  appliedAt: string | null;
  stale: boolean;
  /**
   * Whether Desktop's _meta.json appliedId actually points at our profile.
   * Desktop serves only that one, so false means it is ignoring us even when
   * `applied` (our saved fingerprint) says otherwise. null = undeterminable.
   */
  activeProfile?: boolean | null;
  health: { lastRequestAt: string | null; requestCount: number; errorCount: number };
}

interface DesktopResponse {
  profile: DesktopProfile;
  models: DesktopModel[];
  rendered: unknown[];
  port: number;
}

type PendingAction = "save" | "apply" | null;

/**
 * Tonal badge containers for the model rows. Layout is local to this dense
 * row (the shared `Badge` component's own chrome is identical, but these
 * spans also carry legacy `.claude-*`/`.badge-*` classNames the disclosure
 * tests query directly, so they stay plain spans rather than `<Badge>`).
 * Colour comes from the single shared map, not a local guess: this used to
 * declare its own "neutral" as `secondary-container`, which is why the 1M
 * chip and the effort-supported badge rendered a different colour than every
 * other "neutral" pill in the app. See `shell/m3-ui.tsx`'s `BADGE_TONE_STYLE`.
 */
const BADGE_BASE = {
  display: "inline-flex",
  alignItems: "center",
  height: "24px",
  padding: "0 10px",
  borderRadius: "999px",
  border: "none",
  fontSize: "var(--t-label-s)",
  fontWeight: 500,
  whiteSpace: "nowrap",
} as const;

const TONAL_BADGE = {
  ok: { ...BADGE_BASE, ...BADGE_TONE_STYLE.ok },
  neutral: { ...BADGE_BASE, ...BADGE_TONE_STYLE.neutral },
  // Prototype's "accent" badge. A container pair, not primary-on-primary: the Default
  // badge sits inside a row of tonal chips and a filled one reads as a button.
  accent: { ...BADGE_BASE, ...BADGE_TONE_STYLE.accent },
} as const;

/** M3 tonal status container; the tone-specific colours are applied per render. */
const STATUS_BAR_STYLE = {
  borderRadius: "var(--r-l)",
  borderWidth: "1px",
  borderStyle: "solid",
} as const;

/**
 * M3 paint for the three surfaces whose rules still live in the legacy `styles.css`
 * block (glass panel, hairline card, dashed drop zone). The classes stay — they carry
 * the layout and the tests' contract — and only the colour/shape roles are re-pointed
 * here, because a per-screen port may not edit the shared stylesheet.
 */
const PROFILE_BAR_STYLE = {
  background: "var(--m3-surface-container)",
  border: "1px solid var(--m3-outline-variant)",
  borderRadius: "var(--r-l)",
  backdropFilter: "none",
  WebkitBackdropFilter: "none",
  boxShadow: "none",
} as const;

const MODEL_CARD_STYLE = {
  background: "var(--m3-surface-container-lowest)",
  border: "none",
  borderRadius: "var(--r-m)",
  boxShadow: "none",
} as const;

const LANE_EMPTY_STYLE = {
  border: "1px dashed var(--m3-outline)",
  borderRadius: "var(--r-m)",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-m)",
} as const;

/** "Needs your attention" text. The legacy rules paint these with `--amber`. */
const WARN_TEXT_STYLE = { color: "var(--m3-warn)" } as const;

const ALIAS_STYLE = {
  border: "1px solid var(--m3-outline-variant)",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-highest)",
  color: "var(--m3-on-surface)",
  fontSize: "var(--t-label-m)",
} as const;

const FAMILY_KEYS: Record<Family, TKey> = {
  opus: "claudeDesktop.family.opus",
  fable: "claudeDesktop.family.fable",
  sonnet: "claudeDesktop.family.sonnet",
  haiku: "claudeDesktop.family.haiku",
};

/** M3 paint for this tab's own settings search. Inline, because the shared stylesheets
 *  are off-limits to a per-screen port. */
const SETTINGS_HEADING_STYLE = {
  margin: "var(--sp-4) 0 var(--sp-2)",
  fontSize: "var(--t-title-m)",
  fontWeight: 600,
} as const;
const SETTINGS_SEARCH_ROW = { gap: 8 } as const;
const SETTINGS_SEARCH_INPUT = { flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 420 } as const;
const SETTINGS_HIT_LIST = { display: "grid", gap: 6, marginBottom: "var(--sp-3)" } as const;
const SETTINGS_HIT_ROW = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: 10,
  padding: "10px 12px",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-highest)",
} as const;
const SETTINGS_HIT_LABEL = { fontSize: "var(--t-body-m)", fontWeight: 500 } as const;
const SETTINGS_HIT_DESC = { color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" } as const;
const MONO_STYLE = { fontFamily: "var(--mono)" } as const;

/**
 * The id of this bar's flag state line, which its own search field points
 * `aria-describedby` at.
 *
 * A named constant rather than the same literal typed twice, because the two halves fail
 * silently and separately when they drift: a field describing an id nothing renders is a
 * dangling reference no screen catches, and a state line nothing points at is simply never
 * read aloud. It is scoped to this bar by name — the per-lane model filters below own their
 * own queries and modes, so if one of them ever grows a chip row it needs an id of its own
 * rather than a share of this one.
 */
const SETTINGS_FLAGS_STATE_ID = "claude-desktop-settings-flags-state";

/** One hit of this surface's settings search — same row anatomy the Codex pool uses. */
interface DesktopSettingHit {
  id: string;
  label: string;
  desc: string;
  /** Everything the query is tested against, including the option labels a user is
      likelier to remember ("Sonnet") than the control's own name ("Move to"). */
  haystack: string;
}

/**
 * The settings this tab owns, in the order they render. A user who knows a setting's
 * name types it here instead of scrolling four families looking for the control.
 */
function desktopSettingsIndex(t: TFn): DesktopSettingHit[] {
  const families = FAMILIES.map(family => t(FAMILY_KEYS[family]));
  const defaultsHaystack = [
    t("claudeDesktop.defaultBadge"),
    t("claudeDesktop.chooseDefault"),
    t("claudeDesktop.temporaryDefault"),
    ...FAMILIES.map(family => t("claudeDesktop.useAsDefault", { family: t(FAMILY_KEYS[family]) })),
  ].join(" ");
  return [
    {
      id: "importJson",
      label: t("claudeDesktop.importJson"),
      desc: t("claudeDesktop.importExpected"),
      haystack: [t("claudeDesktop.importJson"), t("claudeDesktop.importExpected"), t("claudeDesktop.importReady")].join(" "),
    },
    {
      id: "exportJson",
      label: t("claudeDesktop.exportJson"),
      desc: t("claudeDesktop.exported"),
      haystack: [t("claudeDesktop.exportJson"), t("claudeDesktop.exported")].join(" "),
    },
    {
      id: "familyDefault",
      label: t("claudeDesktop.defaultBadge"),
      desc: t("claudeDesktop.chooseDefault"),
      haystack: defaultsHaystack,
    },
    {
      id: "moveTo",
      label: t("claudeDesktop.moveTo"),
      desc: t("claudeDesktop.assignmentsLabel"),
      haystack: [t("claudeDesktop.moveTo"), t("claudeDesktop.move"), t("claudeDesktop.assignmentsLabel"), ...families].join(" "),
    },
    {
      id: "alias",
      label: t("claudeDesktop.alias"),
      desc: t("claudeDesktop.assignmentsLabel"),
      haystack: [t("claudeDesktop.alias"), t("claudeDesktop.assignmentsLabel")].join(" "),
    },
    {
      id: "saveApply",
      label: t("claudeDesktop.saveApply"),
      desc: t("claudeDesktop.status.notApplied"),
      haystack: [
        t("claudeDesktop.saveApply"),
        t("common.save"),
        t("claudeDesktop.status.applied"),
        t("claudeDesktop.status.stale"),
        t("claudeDesktop.status.notApplied"),
      ].join(" "),
    },
  ];
}

/**
 * Settings that live on the sibling Code tab. A miss here still points somewhere, which
 * is why the row reports a cross-tab hit by name instead of claiming the setting is gone.
 */
/**
 * The Claude Code tab's settings, for this surface's cross-tab search. Derived from
 * the shared id list rather than hand-listed: the hand-written version held nine of
 * fourteen, so five settings were unfindable from here and read as "no such setting".
 */
function desktopElsewhereIndex(t: TFn): { id: string; label: string; tab: string }[] {
  const tab = t("claude.tabCode");
  return claudeSettingLabels(t).map(({ id, label }) => ({ id, label, tab }));
}

function cloneProfile(profile: DesktopProfile): DesktopProfile {
  return {
    version: 1,
    assignments: Object.fromEntries(
      Object.entries(profile.assignments).map(([route, assignment]) => [route, { ...assignment }]),
    ),
    defaults: { ...profile.defaults },
    // The saved-profile clone is compared against `profile` to compute `dirty`. Dropping the
    // applied-state markers here would make a freshly loaded profile read as unsaved the moment
    // the server had ever applied it.
    ...(profile.appliedFingerprint !== undefined ? { appliedFingerprint: profile.appliedFingerprint } : {}),
    ...(profile.appliedAt !== undefined ? { appliedAt: profile.appliedAt } : {}),
  };
}

function normalizeProfile(data: DesktopResponse): DesktopProfile {
  const assignments = { ...data.profile.assignments };
  for (const model of data.models) {
    const current = assignments[model.route] ?? model.assignment;
    assignments[model.route] = {
      family: FAMILIES.includes(current?.family) ? current.family : "opus",
      alias: typeof current?.alias === "string" ? current.alias : "",
    };
  }
  return {
    version: 1,
    assignments,
    defaults: {
      opus: data.profile.defaults.opus ?? null,
      fable: data.profile.defaults.fable ?? null,
      sonnet: data.profile.defaults.sonnet ?? null,
      haiku: data.profile.defaults.haiku ?? null,
    },
  };
}

function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
  return fallback;
}

function formatContextWindow(value: number | undefined, t: TFn): string | null {
  if (!value) return null;
  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
  // 1048576 / 1e6 = 1.048576 reads as a bug.
  if (value >= 1_048_576) return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

export default function ClaudeDesktop({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [data, setData] = useState<DesktopResponse | null>(null);
  const [profile, setProfile] = useState<DesktopProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState<DesktopProfile | null>(null);
  const [destinations, setDestinations] = useState<Record<string, Family>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  // Lane density: search and paging are RENDER-ONLY. modelsByFamily and effectiveDefaults must
  // keep seeing every model — filtering the source arrays would silently change which model is
  // the effective default, turning a view filter into a data mutation.
  const [laneSearch, setLaneSearch] = useState<Record<string, string>>({});
  const [laneLimit, setLaneLimit] = useState<Record<string, number>>({});
  // Regex mode is per lane, never shared: each search bar owns its own query, pattern and
  // mode, so turning `.*` on for Opus cannot silently reinterpret what Sonnet is filtering.
  const [laneRegex, setLaneRegex] = useState<Record<string, boolean>>({});
  // Collapse is view state too. It is a plain user-owned Set rather than something
  // derived per render: modelsByFamily changes on every move, so deriving would fold a
  // section under the user's cursor the moment they moved the last model out of it.
  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(() => FAMILY_COLLAPSE.read() ?? new Set());
  // Which rows the user has explicitly opened or closed. Deliberately NOT persisted:
  // a family's fold is a durable preference, but which single model you were inspecting
  // is not, and restoring five open rows on reload would rebuild the wall this removes.
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  // This tab's own settings search, bound to this field alone. It never shares state with
  // the per-lane model filters below it, so a query here cannot reinterpret what Opus is
  // filtering — and the Code tab's search cannot reinterpret this one.
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsRegex, setSettingsRegex] = useState(false);
  /**
   * The flags THIS field compiles with. State rather than the `"i"` the matcher
   * used to pin: the builder anchored to this field composes a pattern *and* its
   * flags, so a pattern deliberately built as case-sensitive arrived here
   * case-insensitive and matched settings the user had ruled out. Held beside the
   * query and the mode above it, and — like them — owned by this bar alone: the
   * per-lane model filters below keep their own, so correcting `i` here cannot
   * recompile what Opus is filtering.
   */
  const [settingsFlags, setSettingsFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop`);
      const payload = await readJsonOrThrow<DesktopResponse | { error?: string }>(
        response,
        t("claudeDesktop.loadFail"),
      );
      if (!payload || !("profile" in payload) || !("models" in payload)) {
        throw new Error(errorMessage(payload, t("claudeDesktop.loadFail")));
      }
      const normalized = normalizeProfile(payload);
      setData(payload);
      setProfile(normalized);
      setSavedProfile(cloneProfile(normalized));
      setDestinations(Object.fromEntries(payload.models.map(model => [model.route, normalized.assignments[model.route]?.family ?? "opus"])));
      // Fold empty families on load, but only while the user has no stored preference.
      // Doing it here rather than per render means a later move or import can never
      // re-fold a section the user opened.
      if (FAMILY_COLLAPSE.read() === null) {
        const counts = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<Family, number>;
        for (const model of payload.models) counts[normalized.assignments[model.route]?.family ?? "opus"] += 1;
        setCollapsedFamilies(defaultCollapsedFamilies(counts));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("claudeDesktop.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dirty = useMemo(
    () => profile !== null && savedProfile !== null && JSON.stringify(profile) !== JSON.stringify(savedProfile),
    [profile, savedProfile],
  );

  const modelsByFamily = useMemo(() => {
    const grouped = Object.fromEntries(FAMILIES.map(family => [family, [] as DesktopModel[]])) as Record<Family, DesktopModel[]>;
    if (!data || !profile) return grouped;
    for (const model of data.models) grouped[profile.assignments[model.route]?.family ?? "opus"].push(model);
    return grouped;
  }, [data, profile]);

  const effectiveDefaults = useMemo(() => {
    const result = {} as Record<Family, string | null>;
    for (const family of FAMILIES) {
      const active = modelsByFamily[family].filter(model => model.available).map(model => model.route).sort();
      const stored = profile?.defaults[family] ?? null;
      result[family] = stored && active.includes(stored) ? stored : (active[0] ?? null);
    }
    return result;
  }, [modelsByFamily, profile]);

  // Poll Desktop status every 5s for applied-state + health.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let active: ReturnType<typeof createBoundedFetch> | null = null;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      const bounded = createBoundedFetch(10_000);
      active = bounded;
      void fetch(`${apiBase}/api/claude-desktop/status`, { signal: bounded.signal })
        .then((response) => readJsonIfOk<DesktopStatus>(response))
        .then((data) => {
          if (cancelled) return;
          if (data) setStatus(data);
        })
        .catch(() => { /* offline / older proxy / aborted */ })
        .finally(() => {
          bounded.clear();
          if (active === bounded) active = null;
          inFlight = false;
        });
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      active?.controller.abort();
      active?.clear();
    };
  }, [apiBase]);

  const moveModel = (route: string, family: Family) => {
    if (!profile || profile.assignments[route]?.family === family) return;
    setProfile(current => {
      if (!current) return current;
      const previous = current.assignments[route];
      if (!previous || previous.family === family) return current;
      const assignments = { ...current.assignments, [route]: { ...previous, family } };
      const defaults = { ...current.defaults };
      if (defaults[previous.family] === route) {
        defaults[previous.family] = Object.keys(assignments)
          .filter(key => key !== route && assignments[key].family === previous.family)
          .sort()[0] ?? null;
      }
      if (defaults[family] === null) defaults[family] = route;
      return { ...current, assignments, defaults };
    });
    setDestinations(current => ({ ...current, [route]: family }));
    setAnnouncement(t("claudeDesktop.moved", { route, family: t(FAMILY_KEYS[family]) }));
  };

  const toggleFamily = (family: Family) => {
    // The first toggle also persists, so the load-time default becomes a real preference
    // the moment the user disagrees with it.
    const next = toggleInSet(collapsedFamilies, family);
    FAMILY_COLLAPSE.write(next);
    setCollapsedFamilies(next);
  };

  const save = async (applyAfter: boolean) => {
    if (!profile || pending) return;
    setPending("save");
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("claudeDesktop.saveFailed"));
      setSavedProfile(cloneProfile(profile));

      if (applyAfter) {
        setPending("apply");
        const applyResponse = await fetch(`${apiBase}/api/claude-desktop/apply`, { method: "POST" });
        await readJsonOrThrow<{ error?: string }>(applyResponse, t("claudeDesktop.applyFailed"));
        notify({ tone: "success", title: t("claudeDesktop.savedApplied") });
        setAnnouncement(t("claudeDesktop.savedAppliedAnnounce"));
      } else {
        notify({ tone: "success", title: t("claudeDesktop.saved") });
        setAnnouncement(t("claudeDesktop.savedAnnounce"));
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : t("claudeDesktop.updateFailed");
      notify({ tone: "error", title: text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  const exportProfile = () => {
    if (!profile) return;
    // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- file content newline, not UI text
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(profile, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "claude-desktop-profile.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement(t("claudeDesktop.exported"));
  };

  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const candidate = JSON.parse(await file.text()) as Partial<DesktopProfile>;
      if (candidate.version !== 1 || !candidate.assignments || !candidate.defaults) throw new Error(t("claudeDesktop.importExpected"));
      const imported = normalizeProfile({ ...data!, profile: candidate as DesktopProfile });
      setProfile(imported);
      notify({ tone: "success", title: t("claudeDesktop.importReady") });
      setAnnouncement(t("claudeDesktop.importedAnnounce"));
    } catch (error) {
      const text = error instanceof Error ? error.message : t("claudeDesktop.importInvalid");
      notify({ tone: "error", title: text });
      setAnnouncement(t("claudeDesktop.importFailed", { error: text }));
    }
  };

  const dropOnLane = (event: DragEvent<HTMLElement>, family: Family) => {
    event.preventDefault();
    const route = event.dataTransfer.getData("text/plain");
    if (route) moveModel(route, family);
  };

  if (loading) return <div className="claude-desktop-loading" role="status">{t("claudeDesktop.loading")}</div>;
  if (loadError || !data || !profile) {
    return (
      <div className="claude-desktop-error">
        {/* Inline and permanent: the condition is "this screen has no data", which
            only clears when a retry succeeds — not on a snackbar's timer. */}
        <Banner
          tone="error"
          action={<Button variant="outlined" onClick={() => void load()}>{t("claudeDesktop.retry")}</Button>}
        >
          {loadError || t("claudeDesktop.loadFail")}
        </Banner>
      </div>
    );
  }

  const statusTone = status?.activeProfile === false
    ? "not-applied"
    : status?.stale ? "stale" : status?.applied ? "applied" : "not-applied";

  // Plain text is the default; `.*` is the explicit opt-in, evaluated locally through the
  // shared capped ECMAScript matcher (400 pattern chars). An invalid pattern matches
  // nothing and says so, rather than silently reverting to substring search.
  //
  // The flags come from this bar's own state rather than the matcher's default, so the
  // builder's preview and this hit list cannot report different matches for one pattern.
  // The matcher drops `g` and `y` before compiling — both carry `lastIndex` between calls,
  // so one matcher reused down the settings index would keep every other row, and which
  // half survived would depend only on the order the rows were tested in.
  const settingsActive = settingsQuery.trim().length > 0;
  const settingsMatcher = makeMatcher(settingsQuery, settingsRegex, settingsFlags);
  // Held rather than rebuilt per use: the anchored builder hands the same rows back
  // as its sample, and two calls could drift into two different indexes.
  const settingsIndex = desktopSettingsIndex(t);
  const settingsHits = settingsIndex.filter(row => settingsMatcher.test(row.haystack));
  // Only claimed once something was typed: an untouched field has matched nothing, here
  // or on the Code tab.
  const settingsOtherHits = settingsActive
    ? desktopElsewhereIndex(t).filter(row => settingsMatcher.test(row.label))
    : [];
  const settingsOtherTabs = [...new Set(settingsOtherHits.map(row => row.tab))].join(", ");
  const settingsNote = settingsMatcher.error
    ? `${t("regex.invalid")}: ${settingsMatcher.error}`
    : settingsOtherHits.length > 0
      ? t("settings.otherTab", { count: settingsOtherHits.length, tabs: settingsOtherTabs })
      // "Nothing matched" is a different fact from "this tab has no settings", and this
      // surface always has some — so the no-match wording is the honest one here.
      : settingsActive && settingsHits.length === 0
        ? t("settings.noMatch")
        : "";

  return (
    <>
      <div className="page-head claude-desktop-head">
        <div>
          {/* Title dropped: the Desktop tab already names this panel, and the prototype's
              desktop view opens on the toolbar. The lede stays — it carries the port. */}
          <p className="page-sub">{t("claudeDesktop.subtitle", { port: data.port })}</p>
        </div>
        <div className="claude-profile-tools m3-row">
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importProfile(event)} />
          <Button variant="outlined" onClick={() => importRef.current?.click()}>{t("claudeDesktop.importJson")}</Button>
          <Button variant="outlined" onClick={exportProfile}>{t("claudeDesktop.exportJson")}</Button>
        </div>
      </div>

      {status && (
        // Tonal status container: the applied/stale/ignored state carries the colour role,
        // so the badge reads without depending on the dot alone.
        <div
          className={`claude-status-bar ${statusTone}`}
          style={{
            ...STATUS_BAR_STYLE,
            background: statusTone === "applied" ? "var(--m3-ok-container)" : statusTone === "stale" ? "var(--m3-warn-container)" : "var(--m3-surface-container)",
            borderColor: statusTone === "applied" ? "var(--m3-ok)" : statusTone === "stale" ? "var(--m3-warn)" : "var(--m3-outline-variant)",
            // The container carries the tone, so the label has to take its on-colour with it —
            // on-surface over a dark ok-container is the contrast failure this avoids.
            color: statusTone === "applied" ? "var(--m3-on-ok-container)" : statusTone === "stale" ? "var(--m3-on-warn-container)" : "var(--m3-on-surface)",
          }}
        >
          <span className="claude-status-dot" style={{ background: statusTone === "applied" ? "var(--m3-ok)" : statusTone === "stale" ? "var(--m3-warn)" : "var(--m3-outline)" }} />
          {/* Desktop serving another profile outranks content drift: stale config that is
              read still works, a config that is never read does not. */}
          <span>{status.activeProfile === false ? t("claudeDesktop.status.notActiveProfile") : status.stale ? t("claudeDesktop.status.stale") : status.applied ? t("claudeDesktop.status.applied") : t("claudeDesktop.status.notApplied")}</span>
          {status.health.lastRequestAt && <span className="claude-status-health">{t("claudeDesktop.health.lastRequest")}: {new Date(status.health.lastRequestAt).toLocaleTimeString()}</span>}
          {status.health.requestCount > 0 && <span className="claude-status-health">{t("claudeDesktop.health.stats", { count: status.health.requestCount, errors: status.health.errorCount })}</span>}
        </div>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

      {/* This tab's own settings search, above the controls it describes: plain text by
          default, `.*` as an explicit opt-in, and the full builder one click away anchored
          to this field rather than parked in a menu. A hit that lives on the Code tab is
          named instead of being reported as "no such setting". */}
      <h2 style={SETTINGS_HEADING_STYLE}>{t("common.settings")}</h2>
      <div className="m3-row" role="search" style={SETTINGS_SEARCH_ROW}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={settingsQuery}
          onChange={event => setSettingsQuery(event.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={settingsMatcher.error !== null}
          // Only in regex mode, because that is the only mode the chip row renders in.
          // Pointing at an id nothing renders would leave a screen reader hunting for a
          // description that is not on the page.
          aria-describedby={settingsRegex ? SETTINGS_FLAGS_STATE_ID : undefined}
          style={SETTINGS_SEARCH_INPUT}
        />
        <Chip
          selected={settingsRegex}
          onClick={() => setSettingsRegex(on => !on)}
          title={t("search.regexHint")}
          aria-label={t("search.regexHint")}
        >
          <code style={MONO_STYLE}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={settingsQuery}
          // Both halves of what the builder composed. Taking the pattern and leaving the
          // flags behind is what made the popover's flag chips decorative from this
          // field's point of view.
          onApply={(pattern, appliedFlags) => { setSettingsQuery(pattern); setSettingsFlags(appliedFlags); }}
          regex={settingsRegex}
          onRegexChange={setSettingsRegex}
          // Seeded from this field, so re-opening the panel shows the flags the search is
          // actually running under instead of resetting them to the shipped default.
          flags={settingsFlags}
          sample={settingsIndex.map(row => row.haystack).join("\n")}
        />
      </div>
      {/* Below the row rather than inside it: the row is one flex line already carrying the
          field, the `.*` chip and the builder trigger, and six more chips in it would crush
          the field at the narrow widths this tab is checked at. It stays directly under the
          search it describes, which is what the anchoring is for. */}
      <SearchFlagsRow
        regex={settingsRegex}
        flags={settingsFlags}
        onFlagsChange={setSettingsFlags}
        id={SETTINGS_FLAGS_STATE_ID}
      />
      <p
        role={settingsMatcher.error ? "alert" : "status"}
        style={{
          minHeight: 20,
          margin: "4px 0 var(--sp-2)",
          color: settingsMatcher.error ? "var(--m3-error)" : "var(--m3-on-surface-variant)",
          fontSize: "var(--t-label-m)",
        }}
      >
        {settingsNote}
      </p>
      {/* Hits appear only once something has been typed — an untouched field would
          otherwise list every setting twice, above the controls that already show them. */}
      {settingsActive && settingsHits.length > 0 && (
        <div data-settings-hits="" style={SETTINGS_HIT_LIST}>
          {settingsHits.map(row => (
            <div key={row.id} style={SETTINGS_HIT_ROW}>
              <span style={SETTINGS_HIT_LABEL}>{row.label}</span>
              <span style={SETTINGS_HIT_DESC}>{row.desc}</span>
            </div>
          ))}
        </div>
      )}

      <div className="claude-profile-bar" style={PROFILE_BAR_STYLE}>
        <span className={`claude-dirty${dirty ? " active" : ""}`} style={dirty ? WARN_TEXT_STYLE : undefined}>
          {dirty ? t("claudeDesktop.unsaved") : t("claudeDesktop.upToDate")}
        </span>
        <div className="claude-save-actions m3-row">
          <Button variant="outlined" disabled={!dirty || pending !== null} onClick={() => void save(false)}>
            {pending === "save" ? t("claudeDesktop.saving") : t("common.save")}
          </Button>
          <Button variant="filled" disabled={pending !== null} onClick={() => void save(true)}>
            {pending === "apply" ? t("claudeDesktop.applying") : pending === "save" ? t("claudeDesktop.saving") : t("claudeDesktop.saveApply")}
          </Button>
        </div>
      </div>

      {data.models.length === 0 && (
        <Empty title={t("claudeDesktop.emptyTitle")}>{t("claudeDesktop.emptyHint")}</Empty>
      )}

      <div className="ocx-group-stack" aria-label={t("claudeDesktop.assignmentsLabel")}>
        {FAMILIES.map(family => {
          // Render-only narrowing: the lane header, effectiveDefaults and every assignment keep
          // reading the full list, so filtering can never change what Claude Desktop resolves.
          const all = modelsByFamily[family];
          const lane = laneView(all, laneSearch[family] ?? "", laneLimit[family] ?? LANE_PAGE, laneRegex[family] ?? false);
          const isCollapsed = collapsedFamilies.has(family);
          const familyDefault = effectiveDefaults[family];
          return (
          <section
            key={family}
            className={`ocx-group${isCollapsed ? " collapsed" : ""}`}
            aria-labelledby={`claude-lane-${family}`}
            onDragOver={event => event.preventDefault()}
            onDrop={event => dropOnLane(event, family)}
          >
            <header className={`ocx-group-head${isCollapsed ? "" : " open"}`}>
              {/* The button goes INSIDE the heading: a heading is not phrasing content, so
                  nesting it the other way round is invalid. This keeps the family in the
                  a11y tree and gives the toggle its name. */}
              {/* h2, not h3: with the duplicated panel title gone the families are the
                  panel's top level, and h1 → h3 is a skipped heading level. */}
              <h2 id={`claude-lane-${family}`} className="ocx-group-heading">
                <button
                  type="button"
                  className="ocx-group-toggle"
                  aria-expanded={!isCollapsed}
                  aria-controls={`claude-lane-body-${family}`}
                  onClick={() => toggleFamily(family)}
                >
                  <IconChevron
                    className="ocx-chevron"
                    width={14}
                    height={14}
                    aria-hidden="true"
                    style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }}
                  />
                  <span className="ocx-group-name">{t(FAMILY_KEYS[family])}</span>
                  <span className="ocx-group-count">
                    {t(all.length === 1 ? "claudeDesktop.modelCountOne" : "claudeDesktop.modelCountMany", { count: all.length })}
                  </span>
                  {/* Collapsed legibility: the resolved default is what a user opens a
                      family to check, so it stays readable while folded. */}
                  {familyDefault && <code className="claude-lane-default" title={familyDefault}>{familyDefault}</code>}
                </button>
              </h2>
              {/* Warnings stay outside the fold — never hide state the user must act on. */}
              {all.length > 0 && profile.defaults[family] === null && <span className="claude-default-needed" style={WARN_TEXT_STYLE}>{t("claudeDesktop.chooseDefault")}</span>}
              {familyDefault && familyDefault !== profile.defaults[family] && (
                <span className="claude-default-needed" style={WARN_TEXT_STYLE} title={familyDefault}>{t("claudeDesktop.temporaryDefault")}</span>
              )}
            </header>

            {!isCollapsed && (
            <div id={`claude-lane-body-${family}`}>
            {lane.showSearch && (
              // Every search bar carries its own `.*` opt-in and its own builder shortcut,
              // anchored to this field rather than parked in a menu somewhere else.
              <div className="m3-row" role="search" style={{ gap: 8 }}>
                <input
                  className="m3-input claude-lane-search"
                  type="search"
                  placeholder={t("models.search")}
                  aria-label={t("models.search")}
                  aria-invalid={lane.regexError !== null}
                  value={laneSearch[family] ?? ""}
                  onChange={event => {
                    const next = event.target.value;
                    setLaneSearch(current => ({ ...current, [family]: next }));
                    // A new query starts from the first page; otherwise a previously expanded lane
                    // would hide the very matches the user just searched for.
                    setLaneLimit(current => ({ ...current, [family]: LANE_PAGE }));
                  }}
                />
                <Chip
                  selected={laneRegex[family] ?? false}
                  title={t("regex.regexMode")}
                  aria-label={t("regex.regexMode")}
                  onClick={() => setLaneRegex(current => ({ ...current, [family]: !(current[family] ?? false) }))}
                >
                  <code style={{ fontFamily: "var(--mono)" }}>.*</code>
                </Chip>
                {/* One builder per lane, bound to that lane's own query: a shared
                    instance would apply a pattern to whichever lane was touched last. */}
                <RegexBuilderButton
                  value={laneSearch[family] ?? ""}
                  onApply={pattern => {
                    setLaneSearch(current => ({ ...current, [family]: pattern }));
                    // A new query starts from the first page, exactly as typing does —
                    // otherwise an expanded lane hides the matches just asked for.
                    setLaneLimit(current => ({ ...current, [family]: LANE_PAGE }));
                  }}
                  regex={laneRegex[family] ?? false}
                  onRegexChange={next => setLaneRegex(current => ({ ...current, [family]: next }))}
                  sample={all.slice(0, LANE_SAMPLE_ROWS).map(model => `${model.label} ${model.route}`).join("\n")}
                />
              </div>
            )}
            {lane.regexError && (
              <p role="alert" style={{ margin: "4px 0 0", color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
                {t("regex.invalid")}: {lane.regexError}
              </p>
            )}

            <div className="claude-lane-models">
              {all.length === 0 ? (
                <div className="claude-lane-empty" style={LANE_EMPTY_STYLE}>{t("claudeDesktop.laneEmpty")}</div>
              ) : lane.noMatch ? (
                <div className="claude-lane-empty" style={LANE_EMPTY_STYLE}>{t("claudeDesktop.laneNoMatch")}</div>
              ) : lane.shown.map(model => {
                const assignment = profile.assignments[model.route];
                const context = formatContextWindow(model.contextWindow, t);
                const destination = destinations[model.route] ?? "opus";
                const rowOpen = openRows[model.route] ?? rowStartsOpen(model.route, effectiveDefaults[family]);
                return (
                  <article
                    key={model.route}
                    className={`claude-model-card${rowOpen ? " open" : ""}`}
                    style={MODEL_CARD_STYLE}
                    draggable={model.available}
                    onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", model.route); }}
                  >
                    {/* Summary: identification and triage only. Availability, context and
                        effort stay OUT of the fold because they are what you scan to pick a
                        default — only the edit affordances are hidden. */}
                    <button
                      type="button"
                      className="claude-model-summary"
                      aria-expanded={rowOpen}
                      aria-controls={`claude-model-body-${model.route}`}
                      onClick={() => setOpenRows(current => ({ ...current, [model.route]: !rowOpen }))}
                    >
                      <IconChevron
                        className="ocx-chevron"
                        width={12}
                        height={12}
                        aria-hidden="true"
                        style={{ transform: rowOpen ? "rotate(90deg)" : "none" }}
                      />
                      <span className="claude-model-names">
                        <strong title={model.label}>{model.label}</strong>
                        <code title={model.route}>{model.route}</code>
                      </span>
                      {context && <span className="claude-model-context">{context}</span>}
                      {/* Distinguish "we do not know the window" from "we know it is
                          small": a blank reads as broken. */}
                      {!context && <span className="claude-model-context claude-model-context-unknown">{t("claudeDesktop.contextUnknown")}</span>}
                      {/* Read-only view of the 1M capability the written config already
                          carries — distinct from the context number, because a 984k
                          model is below the threshold. */}
                      {/* Tonal containers per the M3 status vocabulary. The legacy class names
                          stay: they are the row's a11y/test contract, only the paint changes. */}
                      {model.supports1m === true && <span className="claude-1m-chip" style={TONAL_BADGE.neutral}>{t("claudeDesktop.supports1m")}</span>}
                      {model.effortSupported === false && <span className="claude-effort-badge off" style={TONAL_BADGE.neutral}>{t("claudeDesktop.effort.displayOnly")}</span>}
                      {model.effortSupported === true && <span className="claude-effort-badge on" style={TONAL_BADGE.neutral}>{t("claudeDesktop.effort.supported")}</span>}
                      {profile.defaults[family] === model.route && (
                        <span className="claude-row-default" style={TONAL_BADGE.accent}>{t("claudeDesktop.defaultBadge")}</span>
                      )}
                      <span className={`badge ${model.available ? "badge-green" : "badge-muted"}`} style={model.available ? TONAL_BADGE.ok : TONAL_BADGE.neutral}>
                        {model.available ? t("claudeDesktop.available") : t("claudeDesktop.unavailable")}
                      </span>
                    </button>

                    {rowOpen && (
                    <div className="claude-model-body" id={`claude-model-body-${model.route}`}>
                    {effectiveDefaults[family] === model.route && profile.defaults[family] !== model.route && (
                      <span className="claude-effective-default" style={WARN_TEXT_STYLE}>{t("claudeDesktop.temporaryDefault")}</span>
                    )}

                    <div className="claude-field">
                      <span>{t("claudeDesktop.alias")}</span>
                      <code className="claude-alias" style={ALIAS_STYLE} title={assignment.alias}>{assignment.alias}</code>
                    </div>

                    <label className="claude-default-radio">
                      <input
                        type="radio"
                        name={`default-${family}`}
                        checked={profile.defaults[family] === model.route}
                        disabled={!model.available}
                        onChange={() => setProfile(current => current && ({ ...current, defaults: { ...current.defaults, [family]: model.route } }))}
                      />
                      {t("claudeDesktop.useAsDefault", { family: t(FAMILY_KEYS[family]) })}
                    </label>

                    <div className="claude-move-row">
                      <label htmlFor={`move-${model.route}`}>{t("claudeDesktop.moveTo")}</label>
                      <select
                        id={`move-${model.route}`}
                        // m3-input, not the legacy `.input`: the old rule pinned this select to
                        // 34px, below the 44px minimum hit target.
                        className="m3-input"
                        value={destination}
                        disabled={!model.available}
                        onChange={event => setDestinations(current => ({ ...current, [model.route]: event.target.value as Family }))}
                      >
                        {FAMILIES.map(option => <option key={option} value={option}>{t(FAMILY_KEYS[option])}</option>)}
                      </select>
                      <Button
                        variant="outlined"
                        disabled={!model.available || destination === family}
                        onClick={() => moveModel(model.route, destination)}
                      >
                        {t("claudeDesktop.move")}
                      </Button>
                    </div>
                    </div>
                    )}
                  </article>
                );
              })}
              {lane.hidden > 0 && (
                <Button
                  variant="text"
                  className="claude-lane-more"
                  onClick={() => setLaneLimit(current => ({ ...current, [family]: (current[family] ?? LANE_PAGE) + LANE_PAGE }))}
                >
                  {t("models.showMore", { n: lane.hidden })}
                </Button>
              )}
            </div>
            </div>
            )}
          </section>
          );
        })}
      </div>
    </>
  );
}
