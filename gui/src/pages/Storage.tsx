import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n, type TFn, type TKey, type Locale } from "../i18n/shared";
import { Button, Chip, Empty, Field, Segmented, TextInput, Toggle } from "../shell/m3-ui";
import { IconRefresh } from "../icons";
import { formatBytes } from "../format-bytes";
import { useNotifications } from "../shell/notifications-context";
import { recordRevision } from "../shell/revisions";

interface StorageLargestEntry {
  path: string;
  bytes: number;
}

interface StorageBucket {
  key: string;
  label: string;
  bytes: number;
  fileCount: number;
  oldest?: number;
  newest?: number;
  largest?: StorageLargestEntry[];
  rows?: number | null;
}

interface StorageReport {
  codexHome: string;
  generatedAt: number;
  total: { bytes: number; fileCount: number };
  buckets: StorageBucket[];
  error?: string;
}

interface CleanupPreview {
  percent: number;
  count: number;
  bytes: number;
  digest: string;
  candidates: Array<{ relPath: string; bytes: number; physicalRelPaths?: string[] }>;
}

interface CleanupResult {
  ok: boolean;
  mode: "quarantine" | "permanent";
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

interface TrashEntry {
  id: string;
  epoch: string;
  fileCount: number;
  bytes: number;
  quarantinedAt?: number;
  mode?: "quarantine" | "permanent";
}

interface TrashList {
  entries: TrashEntry[];
}

interface RestoreResult {
  ok: boolean;
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

const GB = 1024 ** 3;

interface CleanupPolicy {
  enabled: boolean;
  trigger: { archivedBytesOver: number };
  target: { reduceToBytes?: number; removeOldestPercent?: number };
  schedule: "startup" | "daily" | "weekly" | "manual";
  mode: "quarantine" | "permanent";
  lastRun?: { at: number; freedBytes: number; removed: number };
  nextRun?: number;
  job?: {
    status: "idle" | "running";
    reason?: string;
    startedAt?: number;
    finishedAt?: number;
    lastError?: string;
    lastOutcome?: {
      ok: boolean;
      skipped?: string;
      deferred?: string;
      error?: string;
      mode?: string;
      freedBytes?: number;
      removed?: number;
    };
  };
}

const BUCKET_TKEYS: Record<string, TKey> = {
  sessions: "storage.bucket.sessions",
  archived_sessions: "storage.bucket.archived_sessions",
  logs_db: "storage.bucket.logs_db",
  state_db: "storage.bucket.state_db",
  attachments: "storage.bucket.attachments",
  deletion_manifests: "storage.bucket.deletion_manifests",
  other: "storage.bucket.other",
};

const PRESETS = [10, 25, 50] as const;

/** Shared presentation constants — tokens only, no literal colours. */
const SECTION_GAP: CSSProperties = { marginTop: "var(--sp-3)" };
const NUM_CELL: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
const MUTED_CELL: CSSProperties = { color: "var(--m3-on-surface-variant)" };
const CARD_BODY: CSSProperties = { marginTop: "var(--sp-2)" };
const TABLE_WRAP: CSSProperties = { overflowX: "auto", marginTop: "var(--sp-2)" };
const ERROR_TEXT: CSSProperties = { marginTop: "var(--sp-2)", color: "var(--m3-error)" };
const BAR_TRACK: CSSProperties = {
  display: "block",
  width: "100%",
  minWidth: 64,
  height: 8,
  borderRadius: "var(--r-pill)",
  background: "var(--m3-surface-container-highest)",
  overflow: "hidden",
};
const BAR_FILL: CSSProperties = { display: "block", height: "100%", background: "var(--m3-primary)" };
const STAT_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
  gap: "var(--sp-2)",
  marginBottom: "var(--sp-4)",
};
/** Tonal stat tile matching the prototype's --h-stat cards. */
const STAT_TILE: CSSProperties = {
  minHeight: "var(--h-stat)",
  padding: "var(--pad-card)",
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-low)",
  border: "1px solid var(--m3-outline-variant)",
  minWidth: 0,
};
const STAT_LABEL: CSSProperties = { color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)" };
const STAT_VALUE: CSSProperties = {
  marginTop: 6,
  fontFamily: "var(--mono)",
  fontSize: "var(--t-title-l)",
  fontWeight: 500,
  overflowWrap: "anywhere",
};
/** Reserved height so a hintless tile still lines up with its neighbours. */
const STAT_HINT: CSSProperties = {
  minHeight: 16,
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-s)",
  fontFamily: "var(--mono)",
  overflowWrap: "anywhere",
};

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={STAT_TILE}>
      <div style={STAT_LABEL}>{label}</div>
      <div style={STAT_VALUE}>{value}</div>
      <div style={STAT_HINT}>{hint}</div>
    </div>
  );
}

const localizedCatch = (e: unknown, fallback: string): string => {
  if (!(e instanceof Error)) return fallback;
  const msg = e.message;
  if (
    msg === "Failed to fetch"
    || msg.includes("NetworkError")
    || msg.includes("network error")
    || msg.includes("JSON")
    || msg.includes("Unexpected end of")
  ) {
    return fallback;
  }
  return msg || fallback;
};

function bucketLabel(bucket: StorageBucket, t: TFn): string {
  const tkey = BUCKET_TKEYS[bucket.key];
  return tkey ? t(tkey) : bucket.label;
}

function formatDate(ms: number | undefined, locale: Locale): string {
  return ms === undefined ? "—" : new Date(ms).toLocaleDateString(locale);
}

function BucketsTable({ buckets, totalBytes, locale, t }: {
  buckets: StorageBucket[];
  totalBytes: number;
  locale: Locale;
  t: TFn;
}) {
  return (
    <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-buckets-title">
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id="storage-buckets-title" className="m3-card-title">{t("storage.section.buckets")}</h2>
        </div>
      </header>
      <div style={TABLE_WRAP}>
        <table className="m3-table">
          <thead>
            <tr>
              <th>{t("storage.col.bucket")}</th>
              <th>{t("storage.col.share")}</th>
              <th style={NUM_CELL}>{t("storage.col.size")}</th>
              <th style={NUM_CELL}>{t("storage.col.files")}</th>
              <th>{t("storage.col.oldest")}</th>
              <th>{t("storage.col.newest")}</th>
              <th style={NUM_CELL}>{t("storage.col.rows")}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map(bucket => {
              const share = totalBytes > 0 ? Math.round((bucket.bytes / totalBytes) * 100) : 0;
              // A non-empty bucket that rounds to 0% still gets a visible sliver;
              // aria keeps the true value so the bar never lies to a screen reader.
              const width = bucket.bytes > 0 ? Math.max(2, share) : 0;
              return (
                <tr key={bucket.key}>
                  <td>{bucketLabel(bucket, t)}</td>
                  <td>
                    <span
                      role="progressbar"
                      aria-valuenow={share}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={bucketLabel(bucket, t)}
                      style={BAR_TRACK}
                    >
                      <span aria-hidden="true" style={{ ...BAR_FILL, width: `${width}%` }} />
                    </span>
                  </td>
                  <td className="mono" style={NUM_CELL}>{formatBytes(bucket.bytes, locale)}</td>
                  <td style={NUM_CELL}>{bucket.fileCount}</td>
                  <td style={MUTED_CELL}>{formatDate(bucket.oldest, locale)}</td>
                  <td style={MUTED_CELL}>{formatDate(bucket.newest, locale)}</td>
                  <td className="mono" style={NUM_CELL}>
                    {bucket.rows === undefined ? "—" : bucket.rows === null ? t("storage.rows.unknown") : bucket.rows.toLocaleString(locale)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LargestFilesPanel({ buckets, locale, t }: { buckets: StorageBucket[]; locale: Locale; t: TFn }) {
  // One flat list across every bucket, biggest first. The scanner's paths are
  // CODEX_HOME-relative, so they stay unambiguous once the buckets are merged.
  const files = buckets
    .flatMap(bucket => bucket.largest ?? [])
    .toSorted((a, b) => b.bytes - a.bytes);
  if (files.length === 0) return null;
  return (
    <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-largest-title">
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id="storage-largest-title" className="m3-card-title">{t("storage.section.largest")}</h2>
        </div>
      </header>
      <div style={TABLE_WRAP}>
        <table className="m3-table">
          <tbody>
            {files.map(entry => (
              <tr key={entry.path}>
                <td className="mono" style={{ overflowWrap: "anywhere" }}>{entry.path}</td>
                <td className="mono" style={NUM_CELL}>{formatBytes(entry.bytes, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ArchivedCleanupPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const { notify } = useNotifications();
  const [percent, setPercent] = useState(25);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  // The permanent switch lives on the card, not in the dialog, so closing the
  // dialog must not silently flip the mode the user already chose.
  const closeConfirm = useCallback((clearPreview = false) => {
    setConfirmOpen(false);
    if (clearPreview) setPreview(null);
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!confirmOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmOpen, closeConfirm]);

  const mapCleanupError = (code: string | undefined, fallback?: string, trashDir?: string) => {
    switch (code) {
      case "codex_busy": return t("storage.cleanup.err.codex_busy");
      case "stale_preview": return t("storage.cleanup.err.stale_preview");
      case "restore_pending_overlap": return t("storage.cleanup.err.restore_pending_overlap");
      case "referenced_history": return t("storage.cleanup.err.referenced_history");
      case "invalid_digest": return t("storage.cleanup.err.invalid_digest");
      case "invalid_mode": return t("storage.cleanup.err.invalid_mode");
      case "fs_failed":
        return trashDir
          ? t("storage.cleanup.err.fs_failed_trash", { trashDir })
          : t("storage.cleanup.err.fs_failed");
      case "db_reconcile_failed": return t("storage.cleanup.err.db_reconcile_failed");
      case "cleanup_failed": return t("storage.cleanup.err.cleanup_failed");
      default: return fallback ?? t("storage.cleanup.cleanupFailed");
    }
  };

  const formatPreset = (value: number) =>
    t("storage.cleanup.preset", {
      percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value / 100),
    });

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(mapCleanupError(json.error, t("storage.cleanup.previewFailed")));
      }
      const json = await res.json() as CleanupPreview;
      setPreview(json);
      setConfirmOpen(true);
    } catch (e) {
      setError(localizedCatch(e, t("storage.cleanup.previewFailed")));
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: preview.percent,
          mode: permanent ? "permanent" : "quarantine",
          digest: preview.digest,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as CleanupResult;
        if (json.error === "stale_preview") {
          // Digest can never succeed again — send the user back to Preview.
          closeConfirm(true);
        }
        throw new Error(mapCleanupError(json.error, json.message, json.trashDir));
      }
      const json = await res.json() as CleanupResult;
      if (!json.ok) {
        if (json.error === "stale_preview") {
          closeConfirm(true);
        }
        throw new Error(mapCleanupError(json.error, json.message, json.trashDir));
      }
      closeConfirm(true);
      const done = permanent
        ? t("storage.cleanup.donePermanent", { count: String(json.count), size: formatBytes(json.bytes, locale) })
        : t("storage.cleanup.doneQuarantine", { count: String(json.count), size: formatBytes(json.bytes, locale) });
      // Archived sessions are a user-visible record, so the cleanup is listed in
      // Version history — quarantine is recoverable, permanent delete is not.
      recordRevision({ scope: "settings", label: t("storage.cleanup.title"), summary: done });
      notify({
        tone: "success",
        title: done,
        body: permanent ? t("storage.cleanup.permanentWarn") : t("storage.cleanup.quarantineNote"),
      });
      onDone();
    } catch (e) {
      // Keep the dialog open (except stale_preview) so the failure is visible.
      setError(localizedCatch(e, t("storage.cleanup.cleanupFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-cleanup-title">
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id="storage-cleanup-title" className="m3-card-title">{t("storage.cleanup.title")}</h2>
          <p className="m3-card-sub">{t("storage.cleanup.help")}</p>
        </div>
      </header>

      {/* Raw input rather than <Slider>: the primitive has no disabled prop and
          the busy lock must stay exactly as it was. */}
      <div className="m3-slider-row" style={CARD_BODY}>
        <label className="m3-field-label" htmlFor="storage-cleanup-percent">{t("storage.cleanup.slider")}</label>
        <input
          id="storage-cleanup-percent"
          className="m3-slider"
          type="range"
          min={1}
          max={100}
          value={percent}
          onChange={e => setPercent(Number(e.target.value))}
          disabled={busy}
          aria-label={t("storage.cleanup.slider")}
        />
        <span className="m3-slider-value">{t("storage.cleanup.percent", { percent: String(percent) })}</span>
      </div>
      <div className="m3-row" style={CARD_BODY}>
        {PRESETS.map(p => (
          <Chip
            key={p}
            selected={percent === p}
            disabled={busy}
            onClick={() => setPercent(p)}
          >
            {formatPreset(p)}
          </Chip>
        ))}
      </div>

      <div className="m3-row m3-row--split" style={{ marginTop: "var(--sp-3)", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div>{t("storage.cleanup.permanent")}</div>
          <p className="m3-card-sub">{t("storage.cleanup.permanentWarn")}</p>
        </div>
        <Toggle
          on={permanent}
          disabled={busy}
          onChange={next => setPermanent(next)}
          label={t("storage.cleanup.permanent")}
        />
      </div>

      {/* Filled, not danger: previewing deletes nothing. The destructive tone
          belongs on the dialog's confirm, which is where the decision is made. */}
      <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
        <Button variant="filled" disabled={busy} onClick={() => void runPreview()}>
          {t("storage.cleanup.preview")}
        </Button>
      </div>

      {error && !confirmOpen && <p style={ERROR_TEXT} role="alert">{error}</p>}

      {confirmOpen && preview && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="storage-cleanup-confirm-title"
          onClick={() => !busy && closeConfirm()}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3 id="storage-cleanup-confirm-title">{t("storage.cleanup.confirmTitle")}</h3>
            <p>
              {t("storage.cleanup.confirmBody", {
                count: String(preview.count),
                size: formatBytes(preview.bytes, locale),
                percent: String(preview.percent),
              })}
            </p>
            {preview.candidates.length > 0 && (
              <ul className="mono" style={{ maxHeight: 160, overflow: "auto", fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)" }}>
                {preview.candidates.slice(0, 8).map(c => (
                  <li key={c.relPath}>{c.relPath}</li>
                ))}
                {preview.count > 8 && (
                  <li>{t("storage.cleanup.moreFiles", { n: String(Math.max(0, preview.count - 8)) })}</li>
                )}
              </ul>
            )}
            <p style={{ marginTop: "var(--sp-3)", fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)" }}>
              {permanent ? t("storage.cleanup.permanentWarn") : t("storage.cleanup.quarantineNote")}
            </p>
            {error && <p style={ERROR_TEXT} role="alert">{error}</p>}
            <div className="m3-row" style={{ marginTop: "var(--sp-3)", justifyContent: "flex-end" }}>
              <button
                ref={cancelRef}
                type="button"
                className="m3-btn m3-btn--text"
                disabled={busy}
                onClick={() => closeConfirm()}
              >
                {t("storage.cleanup.cancel")}
              </button>
              <Button
                variant={permanent ? "danger" : "filled"}
                disabled={busy || preview.count === 0}
                onClick={() => void runCleanup()}
              >
                {permanent ? t("storage.cleanup.confirmPermanent") : t("storage.cleanup.confirmQuarantine")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function QuarantineTrashPanel({
  apiBase,
  locale,
  t,
  onDone,
  reloadToken,
  onEntriesChange,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
  reloadToken: number;
  onEntriesChange?: (entries: TrashEntry[]) => void;
}) {
  const { notify } = useNotifications();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmEntry, setConfirmEntry] = useState<TrashEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const closeConfirm = useCallback(() => setConfirmEntry(null), []);

  useEffect(() => {
    if (!confirmEntry) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmEntry, closeConfirm]);

  const loadTrash = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/storage/trash`, { signal });
      if (!res.ok) {
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        throw new Error(t("storage.trash.listFailed"));
      }
      const json = await res.json() as TrashList;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      const next = Array.isArray(json.entries) ? json.entries : [];
      setEntries(next);
      onEntriesChange?.(next);
      setError(null);
    } catch (e) {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setEntries([]);
      onEntriesChange?.([]);
      setError(localizedCatch(e, t("storage.trash.listFailed")));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase, t, onEntriesChange]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadTrash(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [loadTrash, reloadToken]);

  const mapRestoreError = (code: string | undefined, fallback?: string) => {
    switch (code) {
      case "codex_busy": return t("storage.trash.err.codex_busy");
      case "invalid_trash": return t("storage.trash.err.invalid_trash");
      case "missing_trash": return t("storage.trash.err.missing_trash");
      case "dest_exists": return t("storage.trash.err.dest_exists");
      case "fs_failed": return t("storage.trash.err.fs_failed");
      case "db_reconcile_failed": return t("storage.trash.err.db_reconcile_failed");
      case "storage_mutation_busy": return t("storage.trash.err.storage_mutation_busy");
      case "restore_failed": return t("storage.trash.err.restore_failed");
      case "restore_worker_timeout": return t("storage.trash.err.restore_worker_timeout");
      case "restore_worker_aborted": return t("storage.trash.err.restore_worker_aborted");
      case "restore_worker_failed":
        return fallback ?? t("storage.trash.err.restore_worker_failed");
      default: return fallback ?? t("storage.trash.restoreFailed");
    }
  };

  const runRestore = async () => {
    if (!confirmEntry) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/trash/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: confirmEntry.id }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as RestoreResult;
        throw new Error(mapRestoreError(json.error, json.message));
      }
      const json = await res.json() as RestoreResult;
      if (!json.ok) {
        throw new Error(mapRestoreError(json.error, json.message));
      }
      closeConfirm();
      const done = t("storage.trash.done", {
        count: String(json.count),
        size: formatBytes(json.bytes, locale),
      });
      // Append-only: the restore is its own revision, so it can itself be undone.
      recordRevision({ scope: "settings", label: t("storage.trash.title"), summary: done, restored: true });
      notify({ tone: "success", title: done, body: confirmEntry.id });
      onDone();
    } catch (e) {
      setError(localizedCatch(e, t("storage.trash.restoreFailed")));
    } finally {
      setBusy(false);
    }
  };

  const formatWhen = (entry: TrashEntry) => {
    const ms = entry.quarantinedAt ?? Number(entry.epoch.split("-")[0]);
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    return new Date(ms).toLocaleString(locale);
  };

  const modeLabel = (mode: TrashEntry["mode"]) => {
    if (mode === "permanent") return t("storage.trash.mode.permanent");
    if (mode === "quarantine") return t("storage.trash.mode.quarantine");
    return "—";
  };

  return (
    <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-trash-title">
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id="storage-trash-title" className="m3-card-title">{t("storage.trash.title")}</h2>
          <p className="m3-card-sub">{t("storage.trash.help")}</p>
        </div>
      </header>

      {error && !confirmEntry && <p style={ERROR_TEXT} role="alert">{error}</p>}

      {loading ? (
        <p className="m3-card-sub" style={CARD_BODY}>{t("storage.trash.loading")}</p>
      ) : entries.length === 0 ? (
        <div style={CARD_BODY}><Empty title={t("storage.trash.empty")} /></div>
      ) : (
        <div style={TABLE_WRAP}>
          <table className="m3-table">
            <thead>
              <tr>
                <th>{t("storage.trash.col.id")}</th>
                <th>{t("storage.trash.col.when")}</th>
                <th style={NUM_CELL}>{t("storage.trash.col.files")}</th>
                <th style={NUM_CELL}>{t("storage.trash.col.size")}</th>
                <th>{t("storage.trash.col.mode")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td className="mono" style={{ fontSize: "var(--t-label-m)" }}>{entry.id}</td>
                  <td style={MUTED_CELL}>{formatWhen(entry)}</td>
                  <td style={NUM_CELL}>{entry.fileCount}</td>
                  <td className="mono" style={NUM_CELL}>{formatBytes(entry.bytes, locale)}</td>
                  <td style={MUTED_CELL}>{modeLabel(entry.mode)}</td>
                  <td>
                    <Button
                      variant="outlined"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setConfirmEntry(entry);
                      }}
                    >
                      {t("storage.trash.restore")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmEntry && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="storage-trash-confirm-title"
          onClick={() => !busy && closeConfirm()}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3 id="storage-trash-confirm-title">{t("storage.trash.confirmTitle")}</h3>
            <p>
              {t("storage.trash.confirmBody", {
                count: String(confirmEntry.fileCount),
                size: formatBytes(confirmEntry.bytes, locale),
                id: confirmEntry.id,
              })}
            </p>
            {error && <p style={ERROR_TEXT} role="alert">{error}</p>}
            <div className="m3-row" style={{ marginTop: "var(--sp-3)", justifyContent: "flex-end" }}>
              <button
                ref={cancelRef}
                type="button"
                className="m3-btn m3-btn--text"
                disabled={busy}
                onClick={() => closeConfirm()}
              >
                {t("storage.trash.cancel")}
              </button>
              <Button
                variant="filled"
                disabled={busy}
                onClick={() => void runRestore()}
              >
                {t("storage.trash.confirmRestore")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function policyFieldsFromResponse(json: CleanupPolicy): CleanupPolicy {
  const { job, ...policy } = json;
  void job;
  return policy;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

function AutoCleanupPolicyPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const { notify } = useNotifications();
  const [policy, setPolicy] = useState<CleanupPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<"percent" | "reduce">("percent");
  /** Draft string so blank/invalid percent targets are rejected instead of coerced. */
  const [percent, setPercent] = useState("25");
  /** Draft string so blank/invalid reduce targets are rejected instead of coerced to 0. */
  const [reduceGb, setReduceGb] = useState("4");
  /** Draft string so a cleared threshold is rejected instead of coerced to 0. */
  const [thresholdGb, setThresholdGb] = useState("5");
  /** Cancels in-flight Run-now polling when the panel unmounts. */
  const runAbortRef = useRef<AbortController | null>(null);

  const loadPolicy = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, { signal });
      if (!res.ok) throw new Error("load_failed");
      const json = await res.json() as CleanupPolicy;
      if (signal?.aborted) return;
      setPolicy(policyFieldsFromResponse(json));
      setThresholdGb(String(Math.max(0, Math.round((json.trigger.archivedBytesOver / GB) * 100) / 100)));
      if (json.target.reduceToBytes !== undefined) {
        setTargetMode("reduce");
        setReduceGb(String(Math.max(0, Math.round((json.target.reduceToBytes / GB) * 100) / 100)));
      } else {
        setTargetMode("percent");
        setPercent(String(Math.min(100, Math.max(1, Math.floor(json.target.removeOldestPercent ?? 25)))));
      }
    } catch {
      if (signal?.aborted) return;
      setPolicy(null);
      setError(t("storage.policy.loadFailed"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadPolicy(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [loadPolicy]);

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
      runAbortRef.current = null;
    };
  }, []);

  const buildBody = (): CleanupPolicy | null => {
    if (!policy) return null;
    const thresholdRaw = thresholdGb.trim();
    if (thresholdRaw === "") return null;
    const threshold = Number(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 0) return null;

    let target: CleanupPolicy["target"];
    if (targetMode === "reduce") {
      const raw = reduceGb.trim();
      if (raw === "") return null;
      const reduce = Number(raw);
      if (!Number.isFinite(reduce) || reduce < 0) return null;
      target = { reduceToBytes: Math.floor(reduce * GB) };
    } else {
      const pct = Number(percent);
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return null;
      target = { removeOldestPercent: Math.min(100, Math.max(1, Math.floor(pct))) };
    }

    return {
      enabled: policy.enabled,
      trigger: { archivedBytesOver: Math.floor(threshold * GB) },
      target,
      schedule: policy.schedule,
      mode: policy.mode,
    };
  };

  const savePolicy = async (patch?: Partial<CleanupPolicy>) => {
    const base = buildBody();
    if (!base) {
      setError(t("storage.policy.invalid"));
      return;
    }
    const body = { ...base, ...patch };
    const previous = policy;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      const json = await res.json() as { ok?: boolean; policy?: CleanupPolicy; error?: string };
      if (!json.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      setPolicy(policyFieldsFromResponse(json.policy));
      // The policy is a user-visible settings record: keep the value it replaced
      // so Version history can show what the change was undoing.
      recordRevision({
        scope: "settings",
        label: t("storage.policy.title"),
        summary: t("storage.policy.saved"),
        before: previous ? JSON.stringify(previous) : undefined,
      });
      notify({ tone: "success", title: t("storage.policy.saved") });
    } catch {
      setError(t("storage.policy.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const { signal } = controller;

    setRunning(true);
    setError(null);
    try {
      const base = buildBody();
      if (!base) {
        setError(t("storage.policy.invalid"));
        return;
      }
      const saveRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base),
        signal,
      });
      if (signal.aborted) return;
      if (!saveRes.ok) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      const saved = await saveRes.json() as { policy?: CleanupPolicy; error?: string };
      if (signal.aborted) return;
      if (!saved.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      setPolicy(policyFieldsFromResponse(saved.policy));

      const res = await fetch(`${apiBase}/api/storage/cleanup-policy/run`, {
        method: "POST",
        signal,
      });
      if (signal.aborted) return;
      if (res.status === 409) {
        const conflict = await res.json().catch(() => ({})) as {
          error?: string;
          policy?: CleanupPolicy;
        };
        if (signal.aborted) return;
        if (conflict.policy) setPolicy(policyFieldsFromResponse(conflict.policy));
        setError(t("storage.policy.alreadyRunning"));
        return;
      }
      if (!res.ok) {
        const failed = await res.json().catch(() => ({})) as {
          error?: string;
          policy?: CleanupPolicy;
        };
        if (signal.aborted) return;
        if (failed.policy) setPolicy(policyFieldsFromResponse(failed.policy));
        if (failed.error === "already_running") {
          setError(t("storage.policy.alreadyRunning"));
          return;
        }
        setError(t("storage.policy.runFailed"));
        return;
      }
      const startJson = await res.json() as {
        ok?: boolean;
        started?: boolean;
        error?: string;
        job?: CleanupPolicy["job"];
        policy?: CleanupPolicy;
      };
      if (signal.aborted) return;
      if (startJson.policy) setPolicy(policyFieldsFromResponse(startJson.policy));
      if (startJson.error === "already_running") {
        setError(t("storage.policy.alreadyRunning"));
        return;
      }
      if (!startJson.started || !startJson.job?.startedAt) {
        setError(t("storage.policy.runFailed"));
        return;
      }

      const startedAt = startJson.job.startedAt;
      const deadline = Date.now() + 120_000;
      let outcome: NonNullable<CleanupPolicy["job"]>["lastOutcome"] | undefined;
      let finalPolicy: CleanupPolicy | undefined;

      while (Date.now() < deadline) {
        if (signal.aborted) return;
        await sleep(250);
        if (signal.aborted) return;
        const pollRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, { signal });
        if (signal.aborted) return;
        if (!pollRes.ok) continue;
        const body = await pollRes.json() as CleanupPolicy;
        if (signal.aborted) return;
        finalPolicy = policyFieldsFromResponse(body);
        setPolicy(finalPolicy);
        const job = body.job;
        if (!job) continue;
        if (job.status === "running") continue;
        if (job.startedAt === startedAt && job.lastOutcome) {
          outcome = job.lastOutcome;
          break;
        }
        if (job.finishedAt && job.finishedAt >= startedAt && job.lastOutcome) {
          outcome = job.lastOutcome;
          break;
        }
      }

      if (signal.aborted) return;
      if (finalPolicy) setPolicy(finalPolicy);
      if (!outcome) {
        setError(t("storage.policy.runFailed"));
        return;
      }

      if (outcome.skipped === "disabled") {
        notify({ tone: "info", title: t("storage.policy.skippedDisabled") });
      } else if (outcome.skipped === "under_threshold") {
        notify({ tone: "info", title: t("storage.policy.skippedUnder") });
      } else if (outcome.skipped === "nothing_selected") {
        notify({ tone: "info", title: t("storage.policy.skippedEmpty") });
      } else if (outcome.deferred === "codex_busy" || outcome.error === "codex_busy") {
        setError(t("storage.cleanup.err.codex_busy"));
      } else if (!outcome.ok) {
        setError(t("storage.policy.runFailed"));
      } else {
        const done = outcome.mode === "permanent"
          ? t("storage.policy.donePermanent", {
            count: String(outcome.removed ?? 0),
            size: formatBytes(outcome.freedBytes ?? 0, locale),
          })
          : t("storage.policy.doneQuarantine", {
            count: String(outcome.removed ?? 0),
            size: formatBytes(outcome.freedBytes ?? 0, locale),
          });
        recordRevision({ scope: "settings", label: t("storage.policy.title"), summary: done });
        notify({ tone: "success", title: done });
        onDone();
      }
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      setError(t("storage.policy.runFailed"));
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      if (!signal.aborted) setRunning(false);
    }
  };

  const formatWhen = (ms: number | undefined) =>
    ms === undefined ? t("storage.policy.never") : new Date(ms).toLocaleString(locale);

  const policyHead = (
    <header className="m3-card-head">
      <div className="m3-card-headtext">
        <h2 id="storage-policy-title" className="m3-card-title">{t("storage.policy.title")}</h2>
      </div>
    </header>
  );

  if (loading && !policy) {
    return (
      <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-policy-title">
        {policyHead}
        <p className="m3-card-sub">{t("storage.policy.loading")}</p>
      </section>
    );
  }

  if (!policy) {
    return (
      <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-policy-title">
        {policyHead}
        {error && <p style={ERROR_TEXT} role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section className="m3-card" style={SECTION_GAP} aria-labelledby="storage-policy-title">
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h2 id="storage-policy-title" className="m3-card-title">{t("storage.policy.title")}</h2>
          <p className="m3-card-sub">{t("storage.policy.help")}</p>
        </div>
      </header>

      <div className="m3-row m3-row--split" style={CARD_BODY}>
        <div>
          <div>{t("storage.policy.enabled")}</div>
          <p className="m3-card-sub">{t("storage.policy.enabledHint")}</p>
        </div>
        <Toggle
          on={policy.enabled}
          disabled={saving || running}
          label={t("storage.policy.enabled")}
          onChange={enabled => { void savePolicy({ enabled }); }}
        />
      </div>

      <div className="m3-stack" style={{ marginTop: "var(--sp-3)", maxWidth: 420 }}>
        <Field label={t("storage.policy.threshold")} id="storage-policy-threshold">
          <TextInput
            id="storage-policy-threshold"
            type="number"
            min={0}
            step={0.1}
            value={thresholdGb}
            disabled={saving || running}
            onChange={e => setThresholdGb(e.target.value)}
            onBlur={() => void savePolicy()}
          />
        </Field>

        <div className="m3-field">
          <span className="m3-field-label">{t("storage.policy.target")}</span>
          <Segmented
            value={targetMode}
            label={t("storage.policy.target")}
            onChange={next => { if (!saving && !running) setTargetMode(next); }}
            options={[
              { value: "percent", label: t("storage.policy.targetPercent") },
              { value: "reduce", label: t("storage.policy.targetReduce") },
            ]}
          />
          {targetMode === "percent" && (
            <TextInput
              type="number"
              min={1}
              max={100}
              value={percent}
              disabled={saving || running}
              aria-label={t("storage.policy.targetPercent")}
              onChange={e => setPercent(e.target.value)}
              onBlur={() => void savePolicy()}
              style={{ marginTop: "var(--sp-1)" }}
            />
          )}
          {targetMode === "reduce" && (
            <TextInput
              type="number"
              min={0}
              step={0.1}
              value={reduceGb}
              disabled={saving || running}
              aria-label={t("storage.policy.targetReduce")}
              onChange={e => setReduceGb(e.target.value)}
              onBlur={() => void savePolicy()}
              style={{ marginTop: "var(--sp-1)" }}
            />
          )}
        </div>

        <Field label={t("storage.policy.schedule")} id="storage-policy-schedule">
          <select
            id="storage-policy-schedule"
            className="m3-input"
            value={policy.schedule}
            disabled={saving || running}
            onChange={e => {
              const schedule = e.target.value as CleanupPolicy["schedule"];
              void savePolicy({ schedule });
            }}
          >
            <option value="manual">{t("storage.policy.schedule.manual")}</option>
            <option value="startup">{t("storage.policy.schedule.startup")}</option>
            <option value="daily">{t("storage.policy.schedule.daily")}</option>
            <option value="weekly">{t("storage.policy.schedule.weekly")}</option>
          </select>
        </Field>

        <Field label={t("storage.policy.mode")} id="storage-policy-mode">
          <select
            id="storage-policy-mode"
            className="m3-input"
            value={policy.mode}
            disabled={saving || running}
            onChange={e => {
              const mode = e.target.value as CleanupPolicy["mode"];
              void savePolicy({ mode });
            }}
          >
            <option value="quarantine">{t("storage.policy.mode.quarantine")}</option>
            <option value="permanent">{t("storage.policy.mode.permanent")}</option>
          </select>
        </Field>
        {policy.mode === "permanent" && (
          <p style={{ color: "var(--m3-error)" }} role="status">{t("storage.policy.permanentWarn")}</p>
        )}
      </div>

      <div style={{ ...STAT_GRID, marginTop: "var(--sp-3)", marginBottom: 0 }}>
        <StatTile
          label={t("storage.policy.lastRun")}
          value={formatWhen(policy.lastRun?.at)}
          hint={policy.lastRun
            ? t("storage.policy.lastRunDetail", {
              count: String(policy.lastRun.removed),
              size: formatBytes(policy.lastRun.freedBytes, locale),
            })
            : undefined}
        />
        <StatTile label={t("storage.policy.nextRun")} value={formatWhen(policy.nextRun)} />
      </div>

      <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
        <Button variant="outlined" disabled={saving || running} onClick={() => void savePolicy()}>
          {t("storage.policy.save")}
        </Button>
        <Button variant="filled" disabled={saving || running || !policy.enabled} onClick={() => void runNow()}>
          {running ? t("storage.policy.running") : t("storage.policy.runNow")}
        </Button>
      </div>
      {error && <p style={ERROR_TEXT} role="alert">{error}</p>}
    </section>
  );
}

export default function Storage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [trashReloadToken, setTrashReloadToken] = useState(0);
  // Stamp trash awareness with apiBase so a base change invalidates without an effect.
  const [trashInfo, setTrashInfo] = useState({ apiBase, settled: false, hasEntries: false });
  const loadGenerationRef = useRef(0);

  const fetchStorage = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/storage`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const json = await res.json() as StorageReport;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(json);
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(null);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetchStorage(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchStorage]);

  const refreshAll = useCallback(() => {
    void fetchStorage();
    setTrashReloadToken(n => n + 1);
  }, [fetchStorage]);

  const onTrashEntriesChange = useCallback((entries: TrashEntry[]) => {
    setTrashInfo({ apiBase, settled: true, hasEntries: entries.length > 0 });
  }, [apiBase]);

  const trashSettled = trashInfo.apiBase === apiBase && trashInfo.settled;
  const trashHasEntries = trashInfo.apiBase === apiBase && trashInfo.hasEntries;
  const failed = !loading && (!data || data.error !== undefined);
  const empty = !loading && !failed && data!.total.fileCount === 0 && trashSettled && !trashHasEntries;
  const archived = data?.buckets.find(b => b.key === "archived_sessions");
  const archivedCount = archived?.fileCount ?? 0;
  const showBody = Boolean(data) && !failed;
  // While storage is empty, keep the trash panel mounted until it reports so we
  // do not flash the empty state over a non-empty quarantine.
  const showTrashWhileSettling = showBody && (data!.total.fileCount > 0 || !trashSettled || trashHasEntries);

  return (
    <>
      {/* No page heading: the app bar already carries the page title, exactly as
          the prototype's screen sections do. */}
      <div className="m3-row m3-row--split" style={{ marginBottom: "var(--sp-4)", alignItems: "flex-start" }}>
        <p style={{ margin: 0, maxWidth: "74ch", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-l)" }}>
          {t("storage.subtitle")}
        </p>
        <Button variant="text" disabled={loading} onClick={() => refreshAll()}>
          <IconRefresh aria-hidden="true" /> {t("storage.refresh")}
        </Button>
      </div>

      {loading && !data ? (
        <Empty title={t("storage.loading")} />
      ) : failed ? (
        <Empty title={t("storage.error")} />
      ) : empty ? (
        <>
          <Empty title={t("storage.empty")} />
          <AutoCleanupPolicyPanel
            apiBase={apiBase}
            locale={locale}
            t={t}
            onDone={() => refreshAll()}
          />
        </>
      ) : (
        <>
          {data && data.total.fileCount > 0 && (
            <>
              <div style={STAT_GRID}>
                <StatTile
                  label={t("storage.card.total")}
                  value={formatBytes(data.total.bytes, locale)}
                  hint={data.codexHome}
                />
                <StatTile
                  label={t("storage.card.files")}
                  value={data.total.fileCount.toLocaleString(locale)}
                />
                <StatTile
                  label={t("storage.bucket.archived_sessions")}
                  value={formatBytes(archived?.bytes ?? 0, locale)}
                  hint={`${t("storage.card.files")} ${archivedCount.toLocaleString(locale)}`}
                />
              </div>
              <BucketsTable buckets={data.buckets} totalBytes={data.total.bytes} locale={locale} t={t} />
              <LargestFilesPanel buckets={data.buckets} locale={locale} t={t} />
            </>
          )}
          {archivedCount > 0 && (
            <ArchivedCleanupPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              onDone={() => refreshAll()}
            />
          )}
          {showTrashWhileSettling && (
            <QuarantineTrashPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              reloadToken={trashReloadToken}
              onEntriesChange={onTrashEntriesChange}
              onDone={() => refreshAll()}
            />
          )}
          <AutoCleanupPolicyPanel
            apiBase={apiBase}
            locale={locale}
            t={t}
            onDone={() => refreshAll()}
          />
        </>
      )}
    </>
  );
}
