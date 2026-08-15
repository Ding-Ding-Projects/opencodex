/**
 * Local model-runtime (Ollama) suite manager.
 *
 * A thin client over `/api/model-runtime/*`
 * (`src/server/management/model-runtime-routes.ts`), which is itself a thin
 * caller of `src/lib/model-runtime/*` — the module that talks to Ollama's
 * documented local HTTP API (health, version, tags, ps, show, delete) and
 * runs the hardware-fit estimate. The renderer never reaches the Ollama
 * daemon directly; every request here goes through this app's own privileged
 * process, exactly like PDF tools' filesystem operations.
 *
 * ## What this page does NOT do (yet), on purpose
 *
 * The batch-pull cart, the streaming chat surface, and allowlisted harness
 * launch are separate, still-`absent` contracts
 * (`docs/FEATURE-INVENTORY.md`, slice 8) — large enough each to deserve their
 * own lane, and a half-built pull queue or a harness launcher that accepts
 * an unvalidated argument would be worse than not having one. This page can
 * show what is already installed and remove it; it cannot install anything.
 *
 * ## Server-authored diagnostic text stays in English
 *
 * `health.detail`, every string in `fit.evidence`, and every string in
 * `hardware.warnings` are generated in `src/lib/model-runtime/*` — plain
 * English sentences describing what was actually measured, in the same way
 * `PdfTools.tsx` displays a server's `error` string verbatim rather than
 * re-localizing it. Only this page's own chrome (labels, buttons, headers)
 * goes through `t()`.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Badge, Banner, Button, Card, Empty, Segmented, SelectField, Toggle } from "../shell/m3-ui";
import type { BadgeTone } from "../shell/badge-tone";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { IconArrowDown, IconArrowUp, IconCheckCircle, IconError, IconGauge, IconHardDrive, IconNetworkCheck, IconPower, IconRefresh, IconTrash } from "../icons";
import { useI18n } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm } from "../shell/confirm-context";
import { formatBytes } from "../format-bytes";

type OllamaHealthState = "healthy" | "missing" | "stopped" | "unhealthy" | "offline";

interface OllamaHealthResult {
  state: OllamaHealthState;
  baseUrl: string;
  version: string | null;
  detail: string;
  hostWarning: string | null;
  checkedAt: number;
}

type FitVerdict = "runs-well" | "runs-with-limits" | "unlikely" | "unknown";

interface FitResult {
  verdict: FitVerdict;
  evidence: string[];
  computedAt: number;
}

interface GpuFact {
  name: string;
  vramBytes: number | null;
  source: "nvidia-smi" | "windows-wmi" | "unknown";
  caveats: string[];
}

interface HardwareFacts {
  detectedAt: number;
  platform: string;
  totalRamBytes: number | null;
  freeRamBytes: number | null;
  gpus: GpuFact[];
  freeDiskBytes: number | null;
  diskPath: string | null;
  warnings: string[];
}

interface CatalogEntry {
  name: string;
  model: string;
  modifiedAt: string | null;
  sizeBytes: number | null;
  digest: string | null;
  format: string | null;
  family: string | null;
  families: string[] | null;
  parameterSize: string | null;
  parameterCountBillions: number | null;
  quantizationLevel: string | null;
  contextLength: number | null;
  capabilities: string[] | null;
  running: boolean;
  runningVramBytes: number | null;
  showOk: boolean;
  showError: string | null;
  fit: FitResult;
}

type CompletenessVerdict = "complete" | "partial" | "unavailable";

interface CatalogResult {
  entries: CatalogEntry[];
  refreshedAt: number;
  sourceRevision: string | null;
  pageCount: number;
  completeness: { verdict: CompletenessVerdict; detail: string };
  hardware: HardwareFacts;
}

interface CatalogResponse {
  health: OllamaHealthResult;
  catalog: CatalogResult | null;
}

type SortKey = "name" | "size" | "fit";

const FIT_ORDER: Record<FitVerdict, number> = { "runs-well": 0, "runs-with-limits": 1, unlikely: 2, unknown: 3 };

const HEALTH_ICON: Record<OllamaHealthState, typeof IconError> = {
  healthy: IconCheckCircle,
  missing: IconError,
  stopped: IconPower,
  unhealthy: IconError,
  offline: IconNetworkCheck,
};

const HEALTH_BANNER_TONE: Record<OllamaHealthState, "info" | "success" | "warn" | "error"> = {
  healthy: "success",
  missing: "error",
  stopped: "warn",
  unhealthy: "warn",
  offline: "error",
};

const HEALTH_TITLE_KEY: Record<OllamaHealthState, TKey> = {
  healthy: "ollama.health.healthy",
  missing: "ollama.health.missing",
  stopped: "ollama.health.stopped",
  unhealthy: "ollama.health.unhealthy",
  offline: "ollama.health.offline",
};

const HEALTH_GUIDANCE_KEY: Record<OllamaHealthState, TKey | null> = {
  healthy: null,
  missing: "ollama.health.missingGuidance",
  stopped: "ollama.health.stoppedGuidance",
  unhealthy: "ollama.health.unhealthyGuidance",
  offline: "ollama.health.offlineGuidance",
};

const FIT_LABEL_KEY: Record<FitVerdict, TKey> = {
  "runs-well": "ollama.fit.runsWell",
  "runs-with-limits": "ollama.fit.runsWithLimits",
  unlikely: "ollama.fit.unlikely",
  unknown: "ollama.fit.unknown",
};

const FIT_BADGE_TONE: Record<FitVerdict, BadgeTone> = {
  "runs-well": "ok",
  "runs-with-limits": "warn",
  unlikely: "error",
  unknown: "neutral",
};

const COMPLETENESS_KEY: Record<CompletenessVerdict, TKey> = {
  complete: "ollama.catalog.completeness.complete",
  partial: "ollama.catalog.completeness.partial",
  unavailable: "ollama.catalog.completeness.unavailable",
};

/** Auto-recheck cadence while the runtime is not healthy — the "return path to the interrupted action" the health contract asks for, without the user having to click anything. */
const AUTO_RETRY_MS = 12_000;

const TABLE_WRAP: CSSProperties = { overflowX: "auto", marginTop: "var(--sp-2)" };

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed", status: 0 };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: body?.error ?? String(res.status), status: res.status };
  return { ok: true, data: body as T };
}

function FitCell({ fit, t }: { fit: FitResult; t: TFn }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="m3-ollama-fit">
      <Badge tone={FIT_BADGE_TONE[fit.verdict]}>{t(FIT_LABEL_KEY[fit.verdict])}</Badge>
      {fit.evidence.length > 0 && (
        <button type="button" className="m3-ollama-fit__toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {open ? t("ollama.fit.hideEvidence") : t("ollama.fit.showEvidence")}
        </button>
      )}
      {open && (
        <ul className="m3-ollama-fit__evidence" role="note">
          {fit.evidence.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

function GpuFactRow({ gpu, t, locale }: { gpu: GpuFact; t: TFn; locale: Parameters<typeof formatBytes>[1] }) {
  return (
    <div className="m3-ollama-hardware__fact">
      <IconGauge width={18} height={18} />
      <span>
        {t("ollama.hardware.gpu", {
          name: gpu.name,
          vram: gpu.vramBytes != null ? formatBytes(gpu.vramBytes, locale) : t("ollama.hardware.gpuVramUnknown"),
          source: gpu.source,
        })}
        {gpu.caveats.map((caveat, i) => <div key={i} className="m3-field-hint">{caveat}</div>)}
      </span>
    </div>
  );
}

export default function Ollama({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();
  const confirm = useConfirm();

  const [health, setHealth] = useState<OllamaHealthResult | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [familyFilter, setFamilyFilter] = useState("");
  const [fitFilter, setFitFilter] = useState<"" | FitVerdict>("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const result = await fetchJson<CatalogResponse>(apiBase, "/api/model-runtime/catalog", { signal });
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setHealth(result.data.health);
    setCatalog(result.data.catalog);
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred initial load (matches Models/Usage/ClaudeCode): avoids synchronous
    // setState inside the effect body, per the react-hooks/set-state-in-effect lint gate.
    const timeout = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [load]);

  // Auto-recheck while unhealthy, so recovery (starting the daemon, installing
  // it) is picked up without the user having to come back and click Retry —
  // the "return path to the interrupted action" the health contract asks for.
  useEffect(() => {
    if (!health || health.state === "healthy") return;
    const timer = setInterval(() => { void load(); }, AUTO_RETRY_MS);
    return () => clearInterval(timer);
  }, [health, load]);

  async function handleDelete(entry: CatalogEntry): Promise<void> {
    const confirmed = await confirm({
      title: t("ollama.delete.confirmTitle", { name: entry.name }),
      body: t("ollama.delete.confirmBody"),
      confirmLabel: t("ollama.delete.confirmLabel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setDeleting(entry.name);
    const result = await fetchJson<{ ok: true }>(apiBase, "/api/model-runtime/models", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: entry.name }),
    });
    setDeleting(null);
    if (!result.ok) {
      notify({ tone: "error", title: t("ollama.delete.failedTitle"), body: result.error });
      return;
    }
    notify({ tone: "success", title: t("ollama.delete.okTitle"), body: entry.name });
    void load();
  }

  // `?? []` alone would mint a fresh array reference on every render whenever
  // catalog is null, which the eslint set-state-in-effect sibling rule
  // (exhaustive-deps) correctly flags as churning every useMemo below on every
  // render rather than only when the catalog itself actually changes.
  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);

  const families = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.family) set.add(e.family);
    return Array.from(set).sort();
  }, [entries]);

  const matcher = useMemo(() => settingsMatcher(query, useRegex, flags), [query, useRegex, flags]);
  const sampleText = useMemo(() => entries.slice(0, 40).map(e => e.name).join("\n"), [entries]);

  const filtered = useMemo(() => {
    let list = entries.filter(e => matcher.test(`${e.name} ${e.family ?? ""} ${e.parameterSize ?? ""} ${e.quantizationLevel ?? ""}`));
    if (familyFilter) list = list.filter(e => e.family === familyFilter);
    if (fitFilter) list = list.filter(e => e.fit.verdict === fitFilter);
    if (runningOnly) list = list.filter(e => e.running);
    const sorted = [...list].sort((a, b) => {
      const cmp = sortKey === "name" ? a.name.localeCompare(b.name)
        : sortKey === "size" ? (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)
        : FIT_ORDER[a.fit.verdict] - FIT_ORDER[b.fit.verdict];
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [entries, matcher, familyFilter, fitFilter, runningOnly, sortKey, sortDesc]);

  const hardware = catalog?.hardware;

  return (
    <div className="m3-stack">
      <Card title={t("ollama.title")} subtitle={t("ollama.subtitle")}>
        {error && <Banner tone="error">{error}</Banner>}

        {health && (() => {
          const HealthIcon = HEALTH_ICON[health.state];
          const guidanceKey = HEALTH_GUIDANCE_KEY[health.state];
          return (
            <Banner
              tone={HEALTH_BANNER_TONE[health.state]}
              title={<span className="m3-row" style={{ gap: 8 }}><HealthIcon width={18} height={18} /> {t(HEALTH_TITLE_KEY[health.state])}</span>}
              action={<Button variant="text" onClick={() => void load()}><IconRefresh width={16} height={16} /> {t("ollama.health.retry")}</Button>}
            >
              <p>{health.detail}</p>
              {guidanceKey && <p>{t(guidanceKey)}</p>}
              {health.hostWarning && <p>{t("ollama.health.hostWarning", { warning: health.hostWarning })}</p>}
            </Banner>
          );
        })()}

        {loading && !health && <p>{t("ollama.health.checking")}</p>}
      </Card>

      {hardware && (
        <Card title={t("ollama.hardware.title")}>
          <div className="m3-ollama-hardware">
            <div className="m3-ollama-hardware__fact">
              <IconGauge width={18} height={18} />
              <span>
                {hardware.totalRamBytes != null
                  ? t("ollama.hardware.ram", { total: formatBytes(hardware.totalRamBytes, locale), free: hardware.freeRamBytes != null ? formatBytes(hardware.freeRamBytes, locale) : "?" })
                  : t("ollama.hardware.ramUnknown")}
              </span>
            </div>
            <div className="m3-ollama-hardware__fact">
              <IconHardDrive width={18} height={18} />
              <span>
                {hardware.freeDiskBytes != null
                  ? t("ollama.hardware.disk", { free: formatBytes(hardware.freeDiskBytes, locale) })
                  : t("ollama.hardware.diskUnknown")}
              </span>
            </div>
            {hardware.gpus.length === 0 && (
              <div className="m3-ollama-hardware__fact"><IconGauge width={18} height={18} /><span>{t("ollama.hardware.gpuNone")}</span></div>
            )}
            {hardware.gpus.map((gpu, i) => <GpuFactRow key={i} gpu={gpu} t={t} locale={locale} />)}
            {hardware.warnings.map((w, i) => <p key={i} className="m3-field-hint">{w}</p>)}
          </div>
        </Card>
      )}

      {catalog && (
        <Card
          title={t("ollama.catalog.title")}
          subtitle={t("ollama.catalog.refreshedAt", { when: new Date(catalog.refreshedAt).toLocaleString(locale) })}
          actions={<Button variant="text" onClick={() => void load()} disabled={loading}><IconRefresh width={16} height={16} /> {loading ? t("ollama.catalog.refreshing") : t("ollama.catalog.refresh")}</Button>}
        >
          <div className="m3-row" style={{ flexWrap: "wrap", gap: 12 }}>
            <Badge>{t("ollama.catalog.sourceRevision", { version: catalog.sourceRevision ?? "?" })}</Badge>
            <Badge>{t("ollama.catalog.pageCount", { count: catalog.pageCount })}</Badge>
            <Badge tone={catalog.completeness.verdict === "complete" ? "ok" : catalog.completeness.verdict === "partial" ? "warn" : "error"}>
              {t(COMPLETENESS_KEY[catalog.completeness.verdict])}
            </Badge>
          </div>
          <p className="m3-field-hint">{catalog.completeness.detail}</p>

          <SearchField
            id="ollama-search"
            value={query}
            onChange={setQuery}
            searchLabel={t("ollama.catalog.searchLabel")}
            placeholder={t("ollama.catalog.searchLabel")}
            regex={useRegex}
            onRegexChange={setUseRegex}
            flags={flags}
            onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
            sample={sampleText}
          />
          {matcher.error && <p className="m3-field-hint" role="alert">{matcher.error}</p>}

          <div className="m3-row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
            <SelectField
              id="ollama-family-filter"
              label={t("ollama.catalog.familyFilterLabel")}
              value={familyFilter}
              onChange={setFamilyFilter}
              options={[{ value: "", label: t("ollama.catalog.familyFilterAll") }, ...families.map(f => ({ value: f, label: f }))]}
            />
            <SelectField
              id="ollama-fit-filter"
              label={t("ollama.catalog.fitFilterLabel")}
              value={fitFilter}
              onChange={v => setFitFilter(v as "" | FitVerdict)}
              options={[
                { value: "", label: t("ollama.catalog.fitFilterAll") },
                { value: "runs-well", label: t("ollama.fit.runsWell") },
                { value: "runs-with-limits", label: t("ollama.fit.runsWithLimits") },
                { value: "unlikely", label: t("ollama.fit.unlikely") },
                { value: "unknown", label: t("ollama.fit.unknown") },
              ]}
            />
            <Toggle on={runningOnly} onChange={setRunningOnly} label={t("ollama.catalog.runningOnlyLabel")} />
            <Segmented
              label={t("ollama.catalog.sortLabel")}
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: "name", label: t("ollama.catalog.sort.name") },
                { value: "size", label: t("ollama.catalog.sort.size") },
                { value: "fit", label: t("ollama.catalog.sort.fit") },
              ]}
            />
            <Button variant="text" onClick={() => setSortDesc(d => !d)} aria-label={t("ollama.catalog.sortDirection")}>
              {sortDesc ? <IconArrowDown width={16} height={16} /> : <IconArrowUp width={16} height={16} />}
            </Button>
          </div>

          {filtered.length === 0 ? (
            <Empty title={t("ollama.catalog.empty")} />
          ) : (
            <div style={TABLE_WRAP}>
              <table className="m3-table">
                <thead>
                  <tr>
                    <th>{t("ollama.catalog.col.name")}</th>
                    <th>{t("ollama.catalog.col.family")}</th>
                    <th>{t("ollama.catalog.col.params")}</th>
                    <th>{t("ollama.catalog.col.quant")}</th>
                    <th>{t("ollama.catalog.col.context")}</th>
                    <th>{t("ollama.catalog.col.size")}</th>
                    <th>{t("ollama.catalog.col.fit")}</th>
                    <th><span className="sr-only">{t("ollama.catalog.col.actions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(entry => (
                    <tr key={entry.name}>
                      <td>
                        {entry.name}
                        {entry.running && <Badge tone="accent">{t("ollama.catalog.runningBadge")}</Badge>}
                        {!entry.showOk && entry.showError && <div className="m3-field-hint">{entry.showError}</div>}
                      </td>
                      <td>{entry.family ?? "—"}</td>
                      <td>{entry.parameterSize ?? "—"}</td>
                      <td>{entry.quantizationLevel ?? "—"}</td>
                      <td>{entry.contextLength != null ? entry.contextLength.toLocaleString(locale) : "—"}</td>
                      <td>{entry.sizeBytes != null ? formatBytes(entry.sizeBytes, locale) : "—"}</td>
                      <td><FitCell fit={entry.fit} t={t} /></td>
                      <td>
                        <Button variant="text" onClick={() => void handleDelete(entry)} disabled={deleting === entry.name}>
                          <IconTrash width={16} height={16} /> {t("ollama.delete.action")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
