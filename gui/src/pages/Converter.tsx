/**
 * The universal file converter — a categorized adapter catalogue, byte-level
 * detection, and a real run action for every bundled family, for real files
 * on this machine.
 *
 * A thin client over `/api/converter/*` (`src/server/management/converter-routes.ts`),
 * itself a thin caller of
 * `src/lib/converter/{registry,service,archive-service,structured-service}.ts`
 * — the same modules `ocx convert` (`src/cli/converter.ts`) calls, so this
 * page and the CLI can never disagree about what the catalogue says, what a
 * detection pass found, or what a conversion actually did to a file on disk.
 *
 * ## Three bundled families, each runnable from here
 *
 * The contract's rule 1 is that an adapter is enabled only when every
 * dependency it needs is bundled inside the installed app and proven to work
 * offline. Today that is true of three families:
 *  - **Documents/PDF** (`pdf-lib`) hands a detected source off to the
 *    existing `PdfTools.tsx` page rather than reimplementing its seven
 *    operations a second time here — one working implementation, reached
 *    from two places.
 *  - **Archives** (ZIP extraction, `node:zlib` alone) runs right here: pick a
 *    destination directory that does not exist yet, extract.
 *  - **Structured Data** (JSON/CSV/TSV/XML, hand-written, bounded) also runs
 *    right here: the target-format choices are computed from the catalogue's
 *    own `operations` list for the detected format — never a hard-coded
 *    pair — so a format only offers the conversions the catalogue actually
 *    advertises. A lossy target format's `lossyNote` is shown before the
 *    Convert button is enabled, gated behind an explicit acknowledgement,
 *    the same "disclose before it runs" shape `PdfTools.tsx` already uses
 *    for a signed source.
 *
 * Every other category is real in the catalogue — visible, searchable — and
 * honestly disabled, naming its exact missing dependency rather than being
 * hidden. See `src/lib/converter/registry.ts` for the reasoning behind each
 * one.
 *
 * ## The missing native browse control is not specific to this page
 *
 * Same pre-existing, cross-cutting gap `PdfTools.tsx` already documents: no
 * page in this app has a native file/folder browse dialog yet. The source and
 * destination fields here are plain absolute-path text inputs for the same
 * reason.
 */

import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Empty, Field, SelectField, TextInput, Toggle } from "../shell/m3-ui";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { useT, type TKey } from "../i18n/shared";
import { navigateWithSource } from "../lib/converter-handoff";
import { useNotifications } from "../shell/notifications-context";
import {
  IconAudioFile, IconCode, IconDataObject, IconFolderZip, IconImage, IconPictureAsPdf, IconTableChart, IconVideoFile,
} from "../icons";

type AdapterCategoryId =
  | "documents-pdf" | "images" | "audio" | "video" | "archives"
  | "structured-data" | "code-text" | "binary-encodings";

const CATEGORY_ORDER: AdapterCategoryId[] = [
  "documents-pdf", "images", "audio", "video", "archives", "structured-data", "code-text", "binary-encodings",
];

const CATEGORY_ICON: Record<AdapterCategoryId, typeof IconImage> = {
  "documents-pdf": IconPictureAsPdf,
  images: IconImage,
  audio: IconAudioFile,
  video: IconVideoFile,
  archives: IconFolderZip,
  "structured-data": IconTableChart,
  "code-text": IconCode,
  "binary-encodings": IconDataObject,
};

const CATEGORY_LABEL_KEY: Record<AdapterCategoryId, TKey> = {
  "documents-pdf": "converter.category.documentsPdf",
  images: "converter.category.images",
  audio: "converter.category.audio",
  video: "converter.category.video",
  archives: "converter.category.archives",
  "structured-data": "converter.category.structuredData",
  "code-text": "converter.category.codeText",
  "binary-encodings": "converter.category.binaryEncodings",
};

interface CatalogFormat {
  id: string;
  label: string;
  category: AdapterCategoryId;
  extensions: string[];
  bundled: boolean;
  missingDependency?: string;
  reason?: string;
  operations?: string[];
  lossy?: boolean;
  lossyNote?: string;
}

interface CatalogCategory {
  id: AdapterCategoryId;
  label: string;
  formats: CatalogFormat[];
}

interface ConverterCatalog {
  categories: CatalogCategory[];
  totalFormats: number;
  enabledFormats: number;
}

interface DetectedSource {
  ok: boolean;
  boundary?: "empty" | "too-small" | "unreadable" | "too-large";
  reason?: string;
  formatId?: string;
  category?: AdapterCategoryId;
  evidence?: string;
  bytesInspected: number;
}

interface ExtractZipOutcome {
  ok: boolean;
  destination?: string;
  entryCount?: number;
  bytesWritten?: number;
  boundary?: string;
  error?: string;
}

interface StructuredConversionOutcome {
  ok: boolean;
  path?: string;
  bytesWritten?: number;
  lossy?: boolean;
  notes?: string[];
  boundary?: string;
  error?: string;
}

type StructuredFormatId = "json" | "csv" | "tsv" | "xml";

interface CategorySearchState { query: string; regex: boolean; flags: string }

function initialCategorySearch(): Record<AdapterCategoryId, CategorySearchState> {
  const entry: CategorySearchState = { query: "", regex: false, flags: DEFAULT_SEARCH_FLAGS };
  return Object.fromEntries(CATEGORY_ORDER.map(id => [id, { ...entry }])) as Record<AdapterCategoryId, CategorySearchState>;
}

async function callConverterApi<T>(
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
    return { ok: false, error: body?.error ?? String(res.status), boundary: body?.boundary };
  }
  return { ok: true, data: body as T };
}

/** Deep-link a detected PDF into the full PDF Tools page, carrying its path the same way a mobile pairing QR carries a token. */
function openInPdfTools(path: string): void {
  navigateWithSource("pdf", path);
}

export default function Converter({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();

  const [blocked, setBlocked] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ConverterCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [sourcePath, setSourcePath] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectedSource | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);

  const [categorySearch, setCategorySearch] = useState(() => initialCategorySearch());

  // Run state for the two bundled families that convert right here (Archives
  // and Structured Data). PDF stays a hand-off to `PdfTools.tsx` — see the
  // module doc comment — so it needs none of this.
  const [destinationPath, setDestinationPath] = useState("");
  const [targetFormat, setTargetFormat] = useState<StructuredFormatId | "">("");
  const [acknowledgeLossy, setAcknowledgeLossy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runSuccess, setRunSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await callConverterApi<ConverterCatalog>(apiBase, "/api/converter/catalog");
      if (cancelled) return;
      if (!result.ok) {
        if (result.blocked) setBlocked(result.error);
        else setCatalogError(result.error);
        return;
      }
      setCatalog(result.data);
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  async function runDetect(): Promise<void> {
    const path = sourcePath.trim();
    if (!path) return;
    setDetecting(true);
    setDetectError(null);
    setDetection(null);
    // A fresh detection starts a fresh run: a stale destination, target
    // format or result from the previous source must never carry over onto
    // whatever this detection just found.
    setDestinationPath("");
    setTargetFormat("");
    setAcknowledgeLossy(false);
    setRunError(null);
    setRunSuccess(null);
    const result = await callConverterApi<DetectedSource>(apiBase, "/api/converter/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    setDetecting(false);
    if (!result.ok) {
      setDetectError(result.error);
      return;
    }
    setDetection(result.data);
  }

  const detectedFormat = useMemo(() => {
    if (!detection?.ok || !detection.formatId || !catalog) return null;
    for (const cat of catalog.categories) {
      const match = cat.formats.find(f => f.id === detection.formatId);
      if (match) return match;
    }
    return null;
  }, [detection, catalog]);

  /**
   * The target formats this source format may convert to, computed strictly
   * from the catalogue's own `operations` list (e.g. csv's `["to-json",
   * "from-json"]`) rather than a hard-coded pair — a format only offers the
   * conversions the catalogue actually advertises as bundled and enabled.
   */
  const structuredTargets = useMemo<CatalogFormat[]>(() => {
    if (!detectedFormat || detectedFormat.category !== "structured-data" || !catalog) return [];
    const structuredCategory = catalog.categories.find(c => c.id === "structured-data");
    if (!structuredCategory) return [];
    const targetIds = new Set((detectedFormat.operations ?? []).filter(op => op.startsWith("to-")).map(op => op.slice(3)));
    return structuredCategory.formats.filter(f => f.bundled && targetIds.has(f.id));
  }, [detectedFormat, catalog]);

  useEffect(() => {
    if (!structuredTargets.length) {
      if (targetFormat !== "") setTargetFormat("");
      return;
    }
    if (!structuredTargets.some(f => f.id === targetFormat)) {
      setTargetFormat(structuredTargets[0]!.id as StructuredFormatId);
      setAcknowledgeLossy(false);
    }
    // Only the available target set should re-pick a default; typing into
    // `targetFormat` itself must not be undone by this same effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetFormat is read, not reacted to
  }, [structuredTargets]);

  const targetFormatEntry = useMemo(
    () => structuredTargets.find(f => f.id === targetFormat) ?? null,
    [structuredTargets, targetFormat],
  );

  async function runExtractZip(): Promise<void> {
    const path = sourcePath.trim();
    const destination = destinationPath.trim();
    if (!path || !destination) return;
    setRunBusy(true);
    setRunError(null);
    setRunSuccess(null);
    const result = await callConverterApi<ExtractZipOutcome>(apiBase, "/api/converter/extract-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, destination }),
    });
    setRunBusy(false);
    if (!result.ok) {
      const message = result.boundary ? t("converter.result.boundary", { boundary: result.boundary, error: result.error }) : result.error;
      setRunError(message);
      notify({ tone: "error", title: t("converter.runFailedTitle"), body: message });
      return;
    }
    const summary = t("converter.extractSuccess", { count: String(result.data.entryCount ?? 0), destination });
    setRunSuccess(summary);
    notify({ tone: "success", title: t("converter.runOkTitle"), body: summary });
  }

  async function runConvertStructured(): Promise<void> {
    const path = sourcePath.trim();
    const destination = destinationPath.trim();
    const sourceFormat = detectedFormat?.id;
    if (!path || !destination || !targetFormat || !sourceFormat) return;
    if (targetFormatEntry?.lossy && !acknowledgeLossy) return;
    setRunBusy(true);
    setRunError(null);
    setRunSuccess(null);
    const result = await callConverterApi<StructuredConversionOutcome>(apiBase, "/api/converter/convert-structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, sourceFormat, destination, destFormat: targetFormat }),
    });
    setRunBusy(false);
    if (!result.ok) {
      const message = result.boundary ? t("converter.result.boundary", { boundary: result.boundary, error: result.error }) : result.error;
      setRunError(message);
      notify({ tone: "error", title: t("converter.runFailedTitle"), body: message });
      return;
    }
    const summary = t("converter.convertSuccess", { source: sourceFormat, target: targetFormat, destination });
    setRunSuccess(summary);
    notify({ tone: "success", title: t("converter.runOkTitle"), body: summary });
  }

  function updateCategorySearch(id: AdapterCategoryId, patch: Partial<CategorySearchState>): void {
    setCategorySearch(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  if (blocked) {
    return (
      <Card title={t("converter.title")} subtitle={t("converter.subtitle")}>
        <Empty title={t("converter.blockedTitle")}>{blocked}</Empty>
      </Card>
    );
  }

  return (
    <div className="m3-stack">
      <Card title={t("converter.title")} subtitle={t("converter.subtitle")}>
        <Field label={t("converter.sourceLabel")} hint={t("converter.sourceHint")} id="converter-source">
          <TextInput
            id="converter-source"
            value={sourcePath}
            onChange={e => setSourcePath(e.target.value)}
            placeholder={t("converter.sourcePlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <div className="m3-row">
          <Button onClick={() => void runDetect()} disabled={!sourcePath.trim() || detecting}>
            {detecting ? t("converter.detecting") : t("converter.detectAction")}
          </Button>
        </div>

        {detectError && <Banner tone="error">{detectError}</Banner>}

        {detection && (
          <div className="m3-converter-detection" role="status">
            {!detection.ok ? (
              <Banner tone="error">
                {t("converter.detectedBoundary", { boundary: detection.boundary ?? "", reason: detection.reason ?? "" })}
              </Banner>
            ) : !detection.formatId ? (
              <Banner tone="warn">{t("converter.detectedUnknown", { evidence: detection.evidence ?? "" })}</Banner>
            ) : (
              <>
                <Badge tone={detectedFormat?.bundled ? "ok" : "neutral"}>
                  {t("converter.detectedFormat", {
                    label: detectedFormat?.label ?? detection.formatId,
                    category: detection.category ? t(CATEGORY_LABEL_KEY[detection.category]) : "",
                  })}
                </Badge>
                <p className="m3-field-hint">{detection.evidence}</p>
                {detectedFormat?.bundled ? (
                  <div className="m3-row">
                    <Banner tone="success">{t("converter.enabledBanner")}</Banner>
                  </div>
                ) : (
                  <Banner tone="warn">
                    {t("converter.disabledBanner", { reason: detectedFormat?.reason ?? "" })}
                  </Banner>
                )}
                {detectedFormat?.id === "pdf" && detectedFormat.bundled && (
                  <div className="m3-row">
                    <Button onClick={() => openInPdfTools(sourcePath.trim())}>{t("converter.openInPdfTools")}</Button>
                  </div>
                )}

                {detectedFormat?.id === "zip" && detectedFormat.bundled && (
                  <div className="m3-stack">
                    <Field label={t("converter.destinationLabel")} hint={t("converter.destinationHintZip")} id="converter-destination-zip">
                      <TextInput
                        id="converter-destination-zip"
                        value={destinationPath}
                        onChange={e => setDestinationPath(e.target.value)}
                        placeholder={t("converter.destinationPlaceholderZip")}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                    <div className="m3-row">
                      <Button onClick={() => void runExtractZip()} disabled={!destinationPath.trim() || runBusy}>
                        {runBusy ? t("converter.extracting") : t("converter.extractAction")}
                      </Button>
                    </div>
                  </div>
                )}

                {detectedFormat?.category === "structured-data" && detectedFormat.bundled && (
                  <div className="m3-stack">
                    {structuredTargets.length === 0 ? (
                      <Banner tone="warn">{t("converter.noStructuredTargets")}</Banner>
                    ) : (
                      <>
                        <Field label={t("converter.targetFormatLabel")} id="converter-target-format">
                          <SelectField
                            id="converter-target-format"
                            value={targetFormat}
                            onChange={value => { setTargetFormat(value as StructuredFormatId); setAcknowledgeLossy(false); }}
                            label={t("converter.targetFormatLabel")}
                            options={structuredTargets.map(f => ({ value: f.id, label: f.label }))}
                          />
                        </Field>
                        <Field label={t("converter.destinationLabel")} hint={t("converter.destinationHintStructured")} id="converter-destination-structured">
                          <TextInput
                            id="converter-destination-structured"
                            value={destinationPath}
                            onChange={e => setDestinationPath(e.target.value)}
                            placeholder={t("converter.destinationPlaceholderStructured")}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </Field>
                        {targetFormatEntry?.lossy && (
                          <>
                            <Banner tone="warn">{t("converter.lossyNotePrefix")}{targetFormatEntry.lossyNote}</Banner>
                            <Toggle on={acknowledgeLossy} onChange={setAcknowledgeLossy} label={t("converter.acknowledgeLossy")} />
                          </>
                        )}
                        <div className="m3-row">
                          <Button
                            onClick={() => void runConvertStructured()}
                            disabled={!destinationPath.trim() || !targetFormat || (targetFormatEntry?.lossy === true && !acknowledgeLossy) || runBusy}
                          >
                            {runBusy ? t("converter.converting") : t("converter.convertAction")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {runError && <Banner tone="error">{runError}</Banner>}
                {runSuccess && <Banner tone="success">{runSuccess}</Banner>}
              </>
            )}
          </div>
        )}
      </Card>

      {catalogError && (
        <Card title={t("converter.catalogTitle")}>
          <Banner tone="error">{catalogError}</Banner>
        </Card>
      )}

      {catalog && (
        <Card title={t("converter.catalogTitle")} subtitle={t("converter.catalogSubtitle", { enabled: String(catalog.enabledFormats), total: String(catalog.totalFormats) })}>
          <p className="m3-field-hint">{t("converter.scopeNote")}</p>
        </Card>
      )}

      {catalog && CATEGORY_ORDER.map(id => {
        const category = catalog.categories.find(c => c.id === id);
        if (!category) return null;
        const Icon = CATEGORY_ICON[id];
        const search = categorySearch[id];
        const matcher = settingsMatcher(search.query, search.regex, search.flags);
        const rowText = (f: CatalogFormat) =>
          [f.label, f.id, f.extensions.join(" "), f.bundled ? "bundled enabled" : `disabled ${f.reason ?? ""}`].join(" ");
        const filtered = category.formats.filter(f => matcher.test(rowText(f)));
        const sample = category.formats.map(rowText).slice(0, 20).join("\n");
        const categoryLabel = t(CATEGORY_LABEL_KEY[id]);

        return (
          <Card
            key={id}
            title={(
              <span className="m3-row" style={{ gap: 8, alignItems: "center" }}>
                <Icon aria-hidden="true" focusable="false" style={{ width: 20, height: 20 }} />
                {categoryLabel}
              </span>
            )}
          >
            <SearchField
              id={`converter-search-${id}`}
              value={search.query}
              onChange={q => updateCategorySearch(id, { query: q })}
              searchLabel={t("converter.categorySearchLabel", { category: categoryLabel })}
              placeholder={t("converter.categorySearchLabel", { category: categoryLabel })}
              regex={search.regex}
              onRegexChange={r => updateCategorySearch(id, { regex: r })}
              flags={search.flags}
              onApply={(pattern, flags) => updateCategorySearch(id, { query: pattern, flags })}
              sample={sample}
            />
            {matcher.error && <p className="m3-field-hint" role="alert">{matcher.error}</p>}
            {filtered.length === 0 ? (
              <Empty title={t("converter.emptyCategory")} />
            ) : (
              <ul className="m3-converter-format-list">
                {filtered.map(f => (
                  <li key={f.id} className="m3-converter-format-row">
                    <span className="m3-converter-format-label">{f.label}</span>
                    {f.extensions.length > 0 && (
                      <span className="m3-field-hint">{f.extensions.map(ext => `.${ext}`).join(", ")}</span>
                    )}
                    {f.bundled ? (
                      <Badge tone="ok">{t("converter.status.enabled")}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("converter.status.disabled")}</Badge>
                    )}
                    {f.operations && (
                      <p className="m3-field-hint">{t("converter.formatRow.operations", { ops: f.operations.join(", ") })}</p>
                    )}
                    {!f.bundled && f.reason && (
                      <p className="m3-field-hint">{t("converter.status.reasonPrefix")}{f.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}
