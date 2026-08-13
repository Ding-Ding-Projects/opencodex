import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { setClientResourceData, useKeyedClientResource } from "../client-resource";
import { useI18n } from "../i18n/shared";
import { Empty } from "../shell/m3-ui";
import { SettingsSearchRow } from "../shell/SettingsSearch";
import { useSettingsSearch } from "../shell/use-settings-search";
import type { SettingsOption } from "../shell/settings-search";
import { DebugClaudeInboundPanel } from "./debug-claude-inbound-panel";
import { DebugLogViewer } from "./debug-log-viewer";
import { DebugPageHeader, DebugSettingsPanel } from "./debug-settings-panel";
import {
  DEBUG_FLAGS,
  DEBUG_STREAMS,
  type DebugSettings,
  type LogStream,
  isDebugFlagEnabled,
  isStreamEnabled,
} from "./debug-shared";

function debugSettingsKey(apiBase: string): string {
  return `debug-settings:${apiBase}`;
}

export default function Debug({ apiBase, embedded }: { apiBase: string; embedded?: boolean }) {
  const { t } = useI18n();
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<import("./debug-shared").DebugLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const afterRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const debugPoll = useKeyedClientResource(
    debugSettingsKey(apiBase),
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/debug`, { signal });
      if (!res.ok) return null;
      return res.json() as Promise<DebugSettings>;
    },
    { pollMs: 2000 },
  );
  const debug = debugPoll.data ?? null;

  const claudePoll = useKeyedClientResource(
    `debug-claude-inbound:${apiBase}`,
    [apiBase, debug?.claude],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/claude/inbound-debug`, { signal });
      if (!res.ok) return [] as import("./debug-shared").ClaudeInboundEntry[];
      const data = await res.json() as { entries?: import("./debug-shared").ClaudeInboundEntry[] };
      return Array.isArray(data.entries) ? data.entries : [];
    },
    { pollMs: 2000, enabled: !!debug?.claude },
  );
  const claudeEntries = claudePoll.data ?? [];

  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const lineVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 20,
    overscan: 30,
    getItemKey: index => entries[index]!.seq,
  });

  const streamIsOn = useCallback(
    (candidate: LogStream): boolean => isStreamEnabled(debug, candidate),
    [debug],
  );

  useEffect(() => {
    if (!debug || streamIsOn(stream)) return;
    const next = DEBUG_STREAMS.find(streamIsOn);
    if (!next) return;
    const timeout = window.setTimeout(() => setStream(next), 0);
    return () => window.clearTimeout(timeout);
  }, [debug, stream, streamIsOn]);

  const streamEnabled = streamIsOn(stream);
  const logsPath =
    stream === "provider"
      ? `${apiBase}/api/debug/logs`
      : stream === "usage"
        ? `${apiBase}/api/debug/usage-logs`
        : `${apiBase}/api/debug/injection-logs`;

  const fetchLogs = useCallback(async (initial: boolean) => {
    if (!streamEnabled) {
      setEntries([]);
      afterRef.current = 0;
      return;
    }
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (!initial && afterRef.current > 0) params.set("after", String(afterRef.current));
      const res = await fetch(`${logsPath}?${params}`);
      if (!res.ok) return;
      const next = await res.json() as import("./debug-shared").DebugLogEntry[];
      if (next.length === 0) return;
      setEntries(prev => (initial ? next : [...prev, ...next]).slice(-2000));
      afterRef.current = next[next.length - 1]!.seq;
    } catch { /* ignore */ } finally {
      setRefreshing(false);
    }
  }, [logsPath, streamEnabled]);

  useEffect(() => {
    afterRef.current = 0;
    const timeout = window.setTimeout(() => {
      setEntries([]);
      void fetchLogs(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [stream, streamEnabled, fetchLogs]);

  const pollLogs = useEffectEvent((initial: boolean) => {
    void fetchLogs(initial);
  });

  useEffect(() => {
    if (!follow || !streamEnabled) return;
    const interval = setInterval(() => pollLogs(false), 1000);
    return () => clearInterval(interval);
  }, [follow, streamEnabled]);

  useEffect(() => {
    if (follow && entries.length > 0) {
      lineVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, follow, lineVirtualizer]);

  const runDebugMutation = async (body: Record<string, unknown>) => {
    const generation = ++mutationGenerationRef.current;
    setDebugBusy(true);
    // Serialize PUTs so server writes follow user-action order. Latest-wins
    // response filtering alone cannot prevent out-of-order server state.
    const run = async () => {
      try {
        const res = await fetch(`${apiBase}/api/debug`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const next = await res.json() as DebugSettings;
        if (generation !== mutationGenerationRef.current) return;
        setClientResourceData(debugSettingsKey(apiBase), next);
      } catch { /* ignore */ }
    };
    const previous = mutationQueueRef.current ?? Promise.resolve();
    const queued = previous.then(run, run);
    mutationQueueRef.current = queued.then(() => undefined, () => undefined);
    try {
      await queued;
    } finally {
      if (generation === mutationGenerationRef.current) setDebugBusy(false);
    }
  };

  const setDebugFlag = async (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => {
    await runDebugMutation({ [flag]: enabled });
  };

  const resetDebug = async () => {
    await runDebugMutation({ reset: true });
  };

  /**
   * What this surface is searchable by.
   *
   * Capture is a configuration card like any other — four capture flags that
   * persist server-side, a reset, and a stream selector — so it carries the same
   * search bar every settings surface carries, and the header's two view
   * controls are indexed with it because they are the rest of what this screen
   * lets a user adjust.
   *
   * Each switch carries its on/off state as well as its name. The switches are
   * M3 switches with no text beside them, so that state is the one thing a user
   * can remember setting and never read back: "I turned usage extraction on" has
   * to find the row whether they type "usage" or type "on".
   *
   * The stream selector is one option, not three. It is a single control whose
   * three pills are alternatives, so the pill labels go in `keywords` — typing
   * "injection" finds the switcher that prints the injection log, rather than
   * finding nothing because no setting is named that.
   *
   * Flat on purpose: no `tab`, no `activeTab`. The pills under the switches look
   * like tabs and are not — they choose what the viewer prints and hide no
   * setting — and the Logs/Debug tablist that genuinely does hide things belongs
   * to the host page, which is a different surface with its own search.
   */
  const options: SettingsOption[] = useMemo(() => {
    const on = t("debug.stateOn");
    const off = t("debug.stateOff");
    const streamLabels: Record<LogStream, string> = {
      provider: t("debug.streamProvider"),
      usage: t("debug.streamUsage"),
      injection: t("debug.streamInjection"),
    };
    return [
      ...DEBUG_FLAGS.map(flag => ({
        id: flag,
        label: t(`debug.${flag}`),
        // The card's single subtitle is the only description any of the four
        // switches has, and it describes all four equally, so all four carry it.
        desc: t("debug.captureSub"),
        // Undefined rather than "Off" while the poll is still in flight: the
        // card is not on screen yet, and indexing a state the user cannot see is
        // how a search starts answering for settings that are not there.
        value: debug ? (isDebugFlagEnabled(debug, flag) ? on : off) : undefined,
      })),
      { id: "reset", label: t("debug.reset") },
      {
        id: "stream",
        label: t("debug.streamsAria"),
        value: streamLabels[stream],
        keywords: Object.values(streamLabels).join(" "),
      },
      { id: "follow", label: t("debug.follow"), value: follow ? on : off },
      { id: "refresh", label: t("debug.refresh") },
    ];
  }, [t, debug, stream, follow]);

  // `logs` rather than a page of its own: this panel is a half of the Logs
  // tablist, so a hit on one of *its* settings is a hit on Logs & Debug, and the
  // registry must not offer to send the user somewhere they already are.
  const search = useSettingsSearch({ options, scope: "logs" });
  const { matches } = search;

  return (
    <>
      <DebugPageHeader
        embedded={embedded}
        refreshing={refreshing}
        streamEnabled={streamEnabled}
        follow={follow}
        matches={matches}
        onRefresh={() => void fetchLogs(true)}
        onFollowChange={setFollow}
      />

      {/*
        One bar for the whole surface, sitting under the lead the header ends
        with. Safe to render embedded as well as standalone: the host page keeps
        its own log-text search inside the Logs panel, and that panel and this one
        are mutually exclusive halves of the same tablist, so the two bars are
        never on screen together — and they search different things anyway, this
        one the settings, that one the request rows.
      */}
      <SettingsSearchRow search={search} />

      {!debug ? (
        <Empty title={t("debug.loading")} />
      ) : (
        <DebugSettingsPanel
          debug={debug}
          debugBusy={debugBusy}
          stream={stream}
          matches={matches}
          onSetFlag={(flag, enabled) => { void setDebugFlag(flag, enabled); }}
          onReset={() => { void resetDebug(); }}
          onStreamChange={setStream}
        />
      )}

      {debug?.claude && <DebugClaudeInboundPanel entries={claudeEntries} />}

      <DebugLogViewer
        debug={!!debug}
        stream={stream}
        streamEnabled={streamEnabled}
        entries={entries}
        scrollContainerRef={scrollContainerRef}
        lineVirtualizer={lineVirtualizer}
      />
    </>
  );
}
