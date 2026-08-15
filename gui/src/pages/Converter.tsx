/**
 * The universal file converter — a categorized adapter catalogue plus
 * byte-level detection for real files on this machine.
 *
 * A thin client over `/api/converter/*` (`src/server/management/converter-routes.ts`),
 * itself a thin caller of `src/lib/converter/{registry,service}.ts` — the same
 * module `ocx convert` (`src/cli/converter.ts`) calls, so this page and the
 * CLI can never disagree about what the catalogue says or what a detection
 * pass found.
 *
 * ## Honestly scoped: only Documents/PDF is enabled
 *
 * The contract's rule 1 is that an adapter is enabled only when every
 * dependency it needs is bundled inside the installed app and proven to work
 * offline. Today that is true of exactly one family: `pdf-lib`, which
 * `src/lib/pdf-tools/` already ships, tests (90 cases) and exposes as a full
 * page (`PdfTools.tsx`). Rather than re-implementing those seven operations a
 * second time on this page, a detected PDF source hands off to that page —
 * one working implementation, reached from two places, instead of two
 * implementations that could quietly disagree.
 *
 * Every other category is real in the catalogue — visible, searchable — and
 * honestly disabled, naming its exact missing dependency rather than being
 * hidden. See `src/lib/converter/registry.ts` for the reasoning behind each
 * one, including the two (ZIP, and the structured-data family) that already
 * have a real dependency-free precedent elsewhere in this codebase but are
 * not wired through this contract's bounds/sandbox/disclosure pipeline yet.
 *
 * ## The missing native browse control is not specific to this page
 *
 * Same pre-existing, cross-cutting gap `PdfTools.tsx` already documents: no
 * page in this app has a native file/folder browse dialog yet. The source
 * field here is a plain absolute-path text input for the same reason.
 */

import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Empty, Field, TextInput } from "../shell/m3-ui";
import { SearchField } from "../shell/RegexBuilderButton";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { useT, type TKey } from "../i18n/shared";
import { navigateWithSource } from "../lib/converter-handoff";
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

interface CategorySearchState { query: string; regex: boolean; flags: string }

function initialCategorySearch(): Record<AdapterCategoryId, CategorySearchState> {
  const entry: CategorySearchState = { query: "", regex: false, flags: DEFAULT_SEARCH_FLAGS };
  return Object.fromEntries(CATEGORY_ORDER.map(id => [id, { ...entry }])) as Record<AdapterCategoryId, CategorySearchState>;
}

async function callConverterApi<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string; blocked?: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "the request failed" };
  }
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (res.status === 403) {
    return { ok: false, error: (body as { error?: string } | null)?.error ?? "blocked", blocked: true };
  }
  if (!res.ok) {
    return { ok: false, error: body?.error ?? String(res.status) };
  }
  return { ok: true, data: body as T };
}

/** Deep-link a detected PDF into the full PDF Tools page, carrying its path the same way a mobile pairing QR carries a token. */
function openInPdfTools(path: string): void {
  navigateWithSource("pdf", path);
}

export default function Converter({ apiBase }: { apiBase: string }) {
  const t = useT();

  const [blocked, setBlocked] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ConverterCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [sourcePath, setSourcePath] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectedSource | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);

  const [categorySearch, setCategorySearch] = useState(() => initialCategorySearch());

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
