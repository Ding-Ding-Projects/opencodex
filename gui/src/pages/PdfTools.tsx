/**
 * PDF tools — inspect, split, merge, extract, reorder, rotate and edit
 * metadata for real files on this machine.
 *
 * A thin client over `/api/pdf/*` (`src/server/management/pdf-routes.ts`),
 * which is itself a thin caller of `src/lib/pdf-tools/service.ts` — the exact
 * module `ocx pdf` (`src/cli/pdf.ts`) calls too, so this page and the CLI can
 * never disagree about what an operation did.
 *
 * ## Deliberately scoped: PDF tools, not the universal file converter
 *
 * The feature contract that would host these operations inside a categorized
 * adapter catalogue alongside images, audio, archives and everything else is
 * a separate, still-`absent` contract (`docs/FEATURE-INVENTORY.md`, slice 8).
 * This page is built so that converter can adopt these operations later — the
 * server routes and the fs-facing service underneath it do not know or care
 * that this page exists — but it does not attempt to be that converter.
 *
 * ## Path fields carry a native browse control
 *
 * They did not for a long time, and this comment used to say so: grepping for
 * `showOpenDialog` across the whole tree returned nothing, and the page told
 * the user as much. `components/PathInput.tsx` closes that — an open-file
 * picker for the source, a save picker for each single destination, through a
 * `dialog:open-path` channel the main process owns.
 *
 * Two fields here are still text-only, deliberately: `pdf-sources` (merge) and
 * `pdf-destinations` (split) each hold a comma-separated LIST of paths, and a
 * single-file picker does not fit a list. Browse-and-append would, and is not
 * built. Said plainly rather than left as an unexplained inconsistency.
 */

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Card, Chip, Empty, Field, Segmented, TextInput, Toggle } from "../shell/m3-ui";
import { PathInput } from "../components/PathInput";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { useT, type TKey } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { takeHandoffSourceFromUrl } from "../lib/converter-handoff";

type Operation = "inspect" | "split" | "merge" | "extract" | "reorder" | "rotate" | "metadata";

/** Literal-typed, so a renamed or removed `pdf.op.*` key is a compile error here too. */
const OPERATION_LABEL_KEY: Record<Operation, TKey> = {
  inspect: "pdf.op.inspect",
  split: "pdf.op.split",
  merge: "pdf.op.merge",
  extract: "pdf.op.extract",
  reorder: "pdf.op.reorder",
  rotate: "pdf.op.rotate",
  metadata: "pdf.op.metadata",
};

interface PdfCapabilities {
  ok: boolean;
  boundary?: "not-a-pdf" | "malformed" | "encrypted" | "bounds-exceeded";
  reason?: string;
  signed: boolean;
  pageCount?: number;
}

interface PdfPageInfo {
  page: number;
  widthPt: number;
  heightPt: number;
  rotationDegrees: number;
}

interface PdfMetadataFields {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

interface PdfInspectResult {
  capabilities: PdfCapabilities;
  pages?: PdfPageInfo[];
  metadata?: PdfMetadataFields;
}

interface HistoryEntry {
  id: string;
  at: number;
  operation: Operation;
  summary: string;
  ok: boolean;
  detail: string;
}

const HISTORY_KEY = "ocx-m3:pdf-history";
const HISTORY_CAP = 200;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_CAP))); } catch { /* best effort */ }
}

async function callPdfApi<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string; boundary?: string; blocked?: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed" };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string; boundary?: string }) | null;
  if (res.status === 403) {
    return { ok: false, error: (body as { error?: string } | null)?.error ?? "blocked", blocked: true };
  }
  if (!res.ok) {
    // The server always sends a real `error` string; this is a last-resort
    // fallback for a response that somehow did not, so it stays a bare status
    // code rather than an English sentence that would need its own i18n key.
    return { ok: false, error: body?.error ?? String(res.status), boundary: body?.boundary };
  }
  return { ok: true, data: body as T };
}

/** Parses `1-2,3-5` / `7` into `{start,end}` pairs, mirroring `src/cli/pdf.ts`'s `parseRanges`. */
function parseRanges(raw: string): { start: number; end: number }[] | null {
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: { start: number; end: number }[] = [];
  for (const part of parts) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] !== undefined ? Number(match[2]) : start;
    out.push({ start, end });
  }
  return out;
}

function parseNumberList(raw: string): number[] | null {
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) return null;
    out.push(n);
  }
  return out;
}

function parsePaths(raw: string): string[] {
  return raw.split(",").map(p => p.trim()).filter(Boolean);
}

function parseRotations(raw: string, relative: boolean): { page: number; degrees: number; relative: boolean }[] | null {
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: { page: number; degrees: number; relative: boolean }[] = [];
  for (const part of parts) {
    const match = /^(\d+):(-?\d+)$/.exec(part);
    if (!match) return null;
    out.push({ page: Number(match[1]), degrees: Number(match[2]), relative });
  }
  return out;
}

export default function PdfTools({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();

  const [blocked, setBlocked] = useState<string | null>(null);
  // Prefills from the converter catalogue's "Open in PDF Tools" hand-off
  // (`lib/converter-handoff.ts`), exactly once, then falls back to empty —
  // the same one-shot hash-param pattern `lib/mobile-pairing.ts` uses.
  const [sourcePath, setSourcePath] = useState(() => takeHandoffSourceFromUrl() ?? "");
  const [operation, setOperation] = useState<Operation>("inspect");

  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspection, setInspection] = useState<PdfInspectResult | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [acknowledgeSigned, setAcknowledgeSigned] = useState(false);

  const [destination, setDestination] = useState("");
  const [destinations, setDestinations] = useState("");
  const [ranges, setRanges] = useState("");
  const [sources, setSources] = useState("");
  const [pages, setPages] = useState("");
  const [order, setOrder] = useState("");
  const [rotations, setRotations] = useState("");
  const [relative, setRelative] = useState(false);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaAuthor, setMetaAuthor] = useState("");
  const [metaSubject, setMetaSubject] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [metaCreator, setMetaCreator] = useState("");
  const [metaProducer, setMetaProducer] = useState("");

  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runSuccess, setRunSuccess] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyRegex, setHistoryRegex] = useState(false);
  const [historyFlags, setHistoryFlags] = useState(DEFAULT_SEARCH_FLAGS);

  // Probe the local-machine gate once, the same way Terminal does, so the
  // whole page can say plainly why it is unavailable rather than every action
  // failing silently one at a time.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await callPdfApi<PdfInspectResult>(apiBase, "/api/pdf/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "" }),
      });
      if (cancelled) return;
      if (!result.ok && result.blocked) setBlocked(result.error);
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  function recordHistory(entry: Omit<HistoryEntry, "id" | "at">): void {
    const full: HistoryEntry = { ...entry, id: crypto.randomUUID(), at: Date.now() };
    setHistory(prev => {
      const next = [full, ...prev].slice(0, HISTORY_CAP);
      saveHistory(next);
      return next;
    });
  }

  async function runInspect(): Promise<void> {
    if (!sourcePath.trim()) return;
    setInspectBusy(true);
    setInspectError(null);
    setInspection(null);
    setAcknowledgeSigned(false);
    const result = await callPdfApi<PdfInspectResult>(apiBase, "/api/pdf/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sourcePath.trim() }),
    });
    setInspectBusy(false);
    if (!result.ok) {
      setInspectError(result.error);
      recordHistory({ operation: "inspect", summary: t("pdf.history.inspect"), ok: false, detail: result.error });
      return;
    }
    setInspection(result.data);
    recordHistory({
      operation: "inspect",
      summary: t("pdf.history.inspect"),
      ok: result.data.capabilities.ok,
      detail: result.data.capabilities.ok
        ? t("pdf.capabilities.ok", { count: String(result.data.capabilities.pageCount ?? 0) })
        : (result.data.capabilities.reason ?? String(result.data.capabilities.boundary)),
    });
  }

  const needsAcknowledgement = operation !== "inspect" && inspection?.capabilities.signed === true;

  async function runOperation(): Promise<void> {
    setRunError(null);
    setRunSuccess(null);
    const path = sourcePath.trim();
    if (!path) { setRunError(t("pdf.error.noSource")); return; }
    if (needsAcknowledgement && !acknowledgeSigned) { setRunError(t("pdf.error.needsAck")); return; }

    let apiPath: string;
    let body: Record<string, unknown>;
    let summaryOk: string;

    if (operation === "split") {
      const parsedRanges = parseRanges(ranges);
      const dests = parsePaths(destinations);
      if (!parsedRanges) { setRunError(t("pdf.error.badRanges")); return; }
      if (!dests.length || dests.length !== parsedRanges.length) { setRunError(t("pdf.error.destCountMismatch")); return; }
      apiPath = "/api/pdf/split";
      body = { path, ranges: parsedRanges, destinations: dests, acknowledgeSigned };
      summaryOk = t("pdf.history.split", { count: String(dests.length) });
    } else if (operation === "merge") {
      const srcs = parsePaths(sources);
      if (srcs.length < 1) { setRunError(t("pdf.error.needSources")); return; }
      if (!destination.trim()) { setRunError(t("pdf.error.needDestination")); return; }
      apiPath = "/api/pdf/merge";
      body = { paths: srcs, destination: destination.trim(), acknowledgeSigned };
      summaryOk = t("pdf.history.merge", { count: String(srcs.length) });
    } else if (operation === "extract") {
      const parsedPages = parseNumberList(pages);
      if (!parsedPages) { setRunError(t("pdf.error.badPages")); return; }
      if (!destination.trim()) { setRunError(t("pdf.error.needDestination")); return; }
      apiPath = "/api/pdf/extract";
      body = { path, pages: parsedPages, destination: destination.trim(), acknowledgeSigned };
      summaryOk = t("pdf.history.extract", { count: String(parsedPages.length) });
    } else if (operation === "reorder") {
      const parsedOrder = parseNumberList(order);
      if (!parsedOrder) { setRunError(t("pdf.error.badOrder")); return; }
      if (!destination.trim()) { setRunError(t("pdf.error.needDestination")); return; }
      apiPath = "/api/pdf/reorder";
      body = { path, order: parsedOrder, destination: destination.trim(), acknowledgeSigned };
      summaryOk = t("pdf.history.reorder");
    } else if (operation === "rotate") {
      const parsedRotations = parseRotations(rotations, relative);
      if (!parsedRotations) { setRunError(t("pdf.error.badRotations")); return; }
      if (!destination.trim()) { setRunError(t("pdf.error.needDestination")); return; }
      apiPath = "/api/pdf/rotate";
      body = { path, rotations: parsedRotations, destination: destination.trim(), acknowledgeSigned };
      summaryOk = t("pdf.history.rotate", { count: String(parsedRotations.length) });
    } else if (operation === "metadata") {
      if (!destination.trim()) { setRunError(t("pdf.error.needDestination")); return; }
      const fields: PdfMetadataFields = {};
      if (metaTitle) fields.title = metaTitle;
      if (metaAuthor) fields.author = metaAuthor;
      if (metaSubject) fields.subject = metaSubject;
      if (metaCreator) fields.creator = metaCreator;
      if (metaProducer) fields.producer = metaProducer;
      if (metaKeywords) fields.keywords = metaKeywords.split(",").map(k => k.trim()).filter(Boolean);
      if (!Object.keys(fields).length) { setRunError(t("pdf.error.needFields")); return; }
      apiPath = "/api/pdf/metadata";
      body = { path, destination: destination.trim(), fields, acknowledgeSigned };
      summaryOk = t("pdf.history.metadata");
    } else {
      return; // inspect has its own action
    }

    setRunBusy(true);
    const result = await callPdfApi<{ path?: string; pageCount?: number; results?: { ok: boolean; path?: string }[] }>(
      apiBase, apiPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    setRunBusy(false);
    if (!result.ok) {
      const message = result.boundary ? t("pdf.result.boundary", { boundary: result.boundary, error: result.error }) : result.error;
      setRunError(message);
      notify({ tone: "error", title: t("pdf.runFailedTitle"), body: message });
      recordHistory({ operation, summary: summaryOk, ok: false, detail: message });
      return;
    }
    setRunSuccess(summaryOk);
    notify({ tone: "success", title: t("pdf.runOkTitle"), body: summaryOk });
    recordHistory({ operation, summary: summaryOk, ok: true, detail: summaryOk });
  }

  const historyMatcher = useMemo(
    () => settingsMatcher(historyQuery, historyRegex, historyFlags),
    [historyQuery, historyRegex, historyFlags],
  );
  const filteredHistory = useMemo(
    () => history.filter(entry => historyMatcher.test(`${entry.summary} ${entry.detail} ${entry.operation}`)),
    [history, historyMatcher],
  );
  const historySample = useMemo(() => history.map(e => `${e.summary} ${e.detail}`).slice(0, 20).join("\n"), [history]);

  if (blocked) {
    return (
      <Card title={t("pdf.title")} subtitle={t("pdf.subtitle")}>
        <Empty title={t("pdf.blockedTitle")}>{blocked}</Empty>
      </Card>
    );
  }

  const operationOptions: { value: Operation; label: string }[] = [
    { value: "inspect", label: t("pdf.op.inspect") },
    { value: "split", label: t("pdf.op.split") },
    { value: "merge", label: t("pdf.op.merge") },
    { value: "extract", label: t("pdf.op.extract") },
    { value: "reorder", label: t("pdf.op.reorder") },
    { value: "rotate", label: t("pdf.op.rotate") },
    { value: "metadata", label: t("pdf.op.metadata") },
  ];

  return (
    <div className="m3-stack">
      <Card title={t("pdf.title")} subtitle={t("pdf.subtitle")}>
        <Field label={t("pdf.sourceLabel")} hint={t("pdf.sourceHint")} id="pdf-source">
          <PathInput
            id="pdf-source"
            value={sourcePath}
            onChange={setSourcePath}
            mode="file"
            placeholder={t("pdf.sourcePlaceholder")}
          />
        </Field>

        <div className="m3-row">
          <Button onClick={() => void runInspect()} disabled={!sourcePath.trim() || inspectBusy}>
            {inspectBusy ? t("pdf.inspecting") : t("pdf.inspectAction")}
          </Button>
        </div>

        {inspectError && <Banner tone="error">{inspectError}</Banner>}

        {inspection && (
          <div className="m3-pdf-capabilities" role="status">
            {inspection.capabilities.ok ? (
              <>
                <Chip>{t("pdf.capabilities.ok", { count: String(inspection.capabilities.pageCount ?? 0) })}</Chip>
                {inspection.capabilities.signed && <Banner tone="warn">{t("pdf.capabilities.signed")}</Banner>}
                {inspection.metadata?.title && <p className="m3-field-hint">{t("pdf.capabilities.title", { title: inspection.metadata.title })}</p>}
              </>
            ) : (
              <Banner tone="error">
                {t("pdf.capabilities.boundaryPrefix", { boundary: inspection.capabilities.boundary ?? "" })} {inspection.capabilities.reason}
              </Banner>
            )}
          </div>
        )}
      </Card>

      <Card title={t("pdf.operationLabel")}>
        <Segmented value={operation} options={operationOptions} onChange={setOperation} label={t("pdf.operationLabel")} />

        {operation !== "inspect" && needsAcknowledgement && (
          <Toggle on={acknowledgeSigned} onChange={setAcknowledgeSigned} label={t("pdf.acknowledgeSigned")} />
        )}

        {operation === "split" && (
          <>
            <Field label={t("pdf.rangesLabel")} id="pdf-ranges">
              <TextInput id="pdf-ranges" value={ranges} onChange={e => setRanges(e.target.value)} placeholder="1-2,3-5" />
            </Field>
            <Field label={t("pdf.destinationsLabel")} id="pdf-destinations">
              <TextInput id="pdf-destinations" value={destinations} onChange={e => setDestinations(e.target.value)} />
            </Field>
          </>
        )}

        {operation === "merge" && (
          <>
            <Field label={t("pdf.sourcesLabel")} id="pdf-sources">
              <TextInput id="pdf-sources" value={sources} onChange={e => setSources(e.target.value)} />
            </Field>
            <Field label={t("pdf.destinationLabel")} id="pdf-destination-merge">
              <PathInput id="pdf-destination-merge" value={destination} onChange={setDestination} mode="save" />
            </Field>
          </>
        )}

        {operation === "extract" && (
          <>
            <Field label={t("pdf.pagesLabel")} id="pdf-pages">
              <TextInput id="pdf-pages" value={pages} onChange={e => setPages(e.target.value)} placeholder="3,1,2" />
            </Field>
            <Field label={t("pdf.destinationLabel")} id="pdf-destination-extract">
              <PathInput id="pdf-destination-extract" value={destination} onChange={setDestination} mode="save" />
            </Field>
          </>
        )}

        {operation === "reorder" && (
          <>
            <Field label={t("pdf.orderLabel")} id="pdf-order">
              <TextInput id="pdf-order" value={order} onChange={e => setOrder(e.target.value)} placeholder="3,1,2" />
            </Field>
            <Field label={t("pdf.destinationLabel")} id="pdf-destination-reorder">
              <PathInput id="pdf-destination-reorder" value={destination} onChange={setDestination} mode="save" />
            </Field>
          </>
        )}

        {operation === "rotate" && (
          <>
            <Field label={t("pdf.rotationsLabel")} id="pdf-rotations">
              <TextInput id="pdf-rotations" value={rotations} onChange={e => setRotations(e.target.value)} placeholder="1:90,2:180" />
            </Field>
            <Toggle on={relative} onChange={setRelative} label={t("pdf.relativeLabel")} />
            <Field label={t("pdf.destinationLabel")} id="pdf-destination-rotate">
              <PathInput id="pdf-destination-rotate" value={destination} onChange={setDestination} mode="save" />
            </Field>
          </>
        )}

        {operation === "metadata" && (
          <>
            <Field label={t("pdf.meta.title")} id="pdf-meta-title">
              <TextInput id="pdf-meta-title" value={metaTitle} onChange={e => setMetaTitle(e.target.value)} />
            </Field>
            <Field label={t("pdf.meta.author")} id="pdf-meta-author">
              <TextInput id="pdf-meta-author" value={metaAuthor} onChange={e => setMetaAuthor(e.target.value)} />
            </Field>
            <Field label={t("pdf.meta.subject")} id="pdf-meta-subject">
              <TextInput id="pdf-meta-subject" value={metaSubject} onChange={e => setMetaSubject(e.target.value)} />
            </Field>
            <Field label={t("pdf.meta.keywords")} id="pdf-meta-keywords">
              <TextInput id="pdf-meta-keywords" value={metaKeywords} onChange={e => setMetaKeywords(e.target.value)} placeholder={t("pdf.meta.keywordsPlaceholder")} />
            </Field>
            <Field label={t("pdf.meta.creator")} id="pdf-meta-creator">
              <TextInput id="pdf-meta-creator" value={metaCreator} onChange={e => setMetaCreator(e.target.value)} />
            </Field>
            <Field label={t("pdf.meta.producer")} id="pdf-meta-producer">
              <TextInput id="pdf-meta-producer" value={metaProducer} onChange={e => setMetaProducer(e.target.value)} />
            </Field>
            <Field label={t("pdf.destinationLabel")} id="pdf-destination-metadata">
              <TextInput id="pdf-destination-metadata" value={destination} onChange={e => setDestination(e.target.value)} />
            </Field>
          </>
        )}

        {operation !== "inspect" && (
          <div className="m3-row">
            <Button onClick={() => void runOperation()} disabled={runBusy}>
              {runBusy ? t("pdf.running") : t("pdf.runAction")}
            </Button>
          </div>
        )}

        {runError && <Banner tone="error">{runError}</Banner>}
        {runSuccess && <Banner tone="success">{runSuccess}</Banner>}
      </Card>

      <Card title={t("pdf.historyTitle")}>
        <SearchField
          id="pdf-history-search"
          value={historyQuery}
          onChange={setHistoryQuery}
          searchLabel={t("pdf.historySearchLabel")}
          placeholder={t("pdf.historySearchLabel")}
          regex={historyRegex}
          onRegexChange={setHistoryRegex}
          flags={historyFlags}
          onApply={(pattern, flags) => { setHistoryQuery(pattern); setHistoryFlags(flags); }}
          sample={historySample}
        />
        {history.length > 0 && (
          <div className="m3-row">
            <Button variant="text" onClick={() => { setHistory([]); saveHistory([]); }}>{t("pdf.historyClear")}</Button>
          </div>
        )}
        {historyMatcher.error && <p className="m3-field-hint" role="alert">{historyMatcher.error}</p>}
        {history.length === 0 ? (
          <Empty title={t("pdf.historyEmptyTitle")}>{t("pdf.historyEmpty")}</Empty>
        ) : filteredHistory.length === 0 ? (
          <Empty title={t("pdf.historyEmptyFiltered", { query: historyQuery })} />
        ) : (
          <ul className="m3-pdf-history-list">
            {filteredHistory.map(entry => (
              <li key={entry.id} className={entry.ok ? "m3-pdf-history-ok" : "m3-pdf-history-fail"}>
                <span className="m3-pdf-history-op">{t(OPERATION_LABEL_KEY[entry.operation])}</span>
                <span className="m3-pdf-history-detail">{entry.detail}</span>
                <span className="m3-pdf-history-time">{new Date(entry.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
