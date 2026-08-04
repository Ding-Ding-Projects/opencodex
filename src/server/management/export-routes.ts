/**
 * The export surface: any list, any format, optionally archived, optionally
 * handed to VS Code.
 *
 * One route rather than an export endpoint bolted onto each list. The formats,
 * the fidelity warnings and the archive options are identical whatever is being
 * exported, so writing them per list would be writing them wrong in different
 * ways — and a list added later would quietly ship without any of it.
 *
 * Endpoints (on the intentionally open management plane):
 * - GET  /api/export/capabilities → formats, fidelity per dataset, 7z and VS Code availability
 * - POST /api/export              → { dataset, format, archive?, sevenZip?, openInVsCode? }
 *
 * ## Why capabilities is its own call
 *
 * The UI has to say what will be lost *before* the user commits, and it cannot
 * know that without the data — CSV is lossless for a flat dataset and lossy for
 * a nested one. So the fidelity is computed server-side against the real rows
 * and handed over with the format list, rather than the client guessing from the
 * format name.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EXPORT_FORMATS, FORMAT_META, describeFidelity, filenameFor, serialize,
  type ExportFormat, type ExportInput, type Row,
} from "../../lib/export-formats";
import {
  buildZip, describePlan, findSevenZip, runSevenZip,
  type ArchiveKind, type SevenZipOptions,
} from "../../lib/export-archive";
import { findVsCode, openInVsCode } from "../../lib/open-in-vscode";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/** A named collection this route knows how to export. */
export interface Dataset {
  id: string;
  label: string;
  rows: () => Row[] | Promise<Row[]>;
}

/**
 * Where an export is written when it is not streamed back.
 *
 * Its own directory under the OS temp root, created per export. Not the user's
 * Downloads folder: this is also the path handed to VS Code, and writing into a
 * directory the user actively uses risks colliding with a file they care about.
 */
function exportDir(): string {
  return mkdtempSync(join(tmpdir(), "opencodex-export-"));
}

const isFormat = (value: unknown): value is ExportFormat =>
  typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);

export interface ExportRequest {
  dataset?: unknown;
  format?: unknown;
  archive?: unknown;
  sevenZip?: unknown;
  openInVsCode?: unknown;
  /** Export several formats at once, into one archive. */
  formats?: unknown;
}

/**
 * Handle the export routes.
 *
 * `datasets` is injected so the route has no opinion about where rows come from
 * and every list in the app can register itself without this file growing a
 * branch per list.
 */
export async function handleExportRoutes(
  ctx: ManagementContext,
  datasets: Map<string, Dataset>,
): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/export/capabilities" && req.method === "GET") {
    const wanted = url.searchParams.get("dataset");
    const sevenZip = findSevenZip();
    const vscode = findVsCode();

    const described = [];
    for (const dataset of datasets.values()) {
      if (wanted && dataset.id !== wanted) continue;
      const rows = await dataset.rows();
      const input: ExportInput = { name: dataset.id, rows };
      described.push({
        id: dataset.id,
        label: dataset.label,
        rowCount: rows.length,
        // Per format, for THIS data. The whole reason this is a server call.
        formats: EXPORT_FORMATS.map(format => ({
          format,
          ...FORMAT_META[format],
          ...describeFidelity(input, format),
        })),
      });
    }

    return jsonResponse({
      datasets: described,
      archives: {
        zip: { available: true, ...describePlan("zip") },
        // Reported rather than assumed: the UI must not offer an encrypted 7z on
        // a machine that cannot produce one and discover it at the last step.
        sevenZip: { available: !!sevenZip, path: sevenZip, ...describePlan("7z", {}, sevenZip) },
      },
      vsCode: { available: vscode.found, label: vscode.label ?? null, downloadUrl: vscode.downloadUrl ?? null },
    }, 200, req, config);
  }

  if (url.pathname === "/api/export" && req.method === "POST") {
    let body: ExportRequest;
    try { body = (await req.json()) as ExportRequest; }
    catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }

    const dataset = typeof body.dataset === "string" ? datasets.get(body.dataset) : undefined;
    if (!dataset) {
      return jsonResponse({
        error: `Unknown dataset. Known: ${[...datasets.keys()].join(", ")}`,
      }, 400, req, config);
    }

    // Every requested format must be one we know. Dropping the unknown ones and
    // exporting the rest would hand back an archive missing a format the caller
    // asked for, with nothing anywhere saying so — the same quiet-truncation
    // failure the fidelity warnings exist to prevent, one level up.
    const requested: unknown[] = Array.isArray(body.formats)
      ? body.formats
      : body.format !== undefined ? [body.format] : [];
    const unknown = requested.filter(format => !isFormat(format));
    if (unknown.length) {
      return jsonResponse({
        error: `Unknown format(s): ${unknown.map(String).join(", ")}. Known: ${EXPORT_FORMATS.join(", ")}`,
      }, 400, req, config);
    }
    const formats = requested.filter(isFormat);
    if (!formats.length) {
      return jsonResponse({
        error: `No format requested. Known: ${EXPORT_FORMATS.join(", ")}`,
      }, 400, req, config);
    }

    const rows = await dataset.rows();
    const input: ExportInput = { name: dataset.id, rows };
    const files = formats.map(format => ({
      name: filenameFor(dataset.id, format),
      format,
      body: serialize(input, format),
      fidelity: describeFidelity(input, format),
    }));

    const archiveKind: ArchiveKind | null =
      body.archive === "zip" ? "zip" : body.archive === "7z" ? "7z" : null;

    // One file and no archive asked for: hand it straight back. Wrapping a
    // single CSV in a ZIP to be uniform would just make the user unwrap it.
    if (!archiveKind && files.length === 1) {
      const only = files[0];
      return new Response(only.body, {
        status: 200,
        headers: {
          "Content-Type": `${FORMAT_META[only.format].mime}; charset=utf-8`,
          "Content-Disposition": `attachment; filename="${only.name}"`,
          "Cache-Control": "no-store",
          // The losses travel with the file, so a caller that skipped the
          // capabilities call still cannot claim it was not told.
          "X-Export-Fidelity": only.fidelity.level,
        },
      });
    }

    const kind: ArchiveKind = archiveKind ?? "zip";
    const sevenZipOptions = (body.sevenZip ?? {}) as SevenZipOptions;

    if (kind === "zip") {
      const zip = buildZip(files.map(file => ({
        path: file.name,
        data: new TextEncoder().encode(file.body),
      })));
      // Handing it to VS Code needs a path, so write it out rather than only
      // streaming; otherwise "open this" has nothing to open.
      if (body.openInVsCode) {
        const dir = exportDir();
        for (const file of files) writeFileSync(join(dir, file.name), file.body, "utf-8");
        const opened = await openInVsCode(dir);
        return jsonResponse({ ok: true, path: dir, files: files.map(f => f.name), vsCode: opened }, 200, req, config);
      }
      return new Response(zip as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${dataset.id}.zip"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // 7z: refuse rather than quietly hand back a ZIP. A user who asked for an
    // encrypted archive and received an unencrypted one has been told their data
    // is protected when it is not.
    const plan = describePlan("7z", sevenZipOptions);
    if (plan.blocked) return jsonResponse({ error: plan.blocked }, 409, req, config);

    const staging = exportDir();
    try {
      for (const file of files) writeFileSync(join(staging, file.name), file.body, "utf-8");
      const target = join(dirname(staging), `${dataset.id}.7z`);
      const result = await runSevenZip(staging, target, sevenZipOptions);
      if (!result.ok) return jsonResponse({ error: result.message }, 500, req, config);

      if (body.openInVsCode) {
        const opened = await openInVsCode(dirname(target));
        return jsonResponse({ ok: true, path: target, notes: plan.notes, vsCode: opened }, 200, req, config);
      }

      const bytes = readFileSync(target);
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/x-7z-compressed",
          "Content-Disposition": `attachment; filename="${dataset.id}.7z"`,
          "Cache-Control": "no-store",
        },
      });
    } finally {
      // The staging copy is plaintext even when the archive is encrypted, so it
      // does not get to outlive the request.
      rmSync(staging, { recursive: true, force: true });
    }
  }

  if (url.pathname === "/api/export/open" && req.method === "POST") {
    let body: { path?: unknown };
    try { body = (await req.json()) as { path?: unknown }; }
    catch { return jsonResponse({ error: "Invalid JSON" }, 400, req, config); }
    if (typeof body.path !== "string" || !body.path) {
      return jsonResponse({ error: "A path is required." }, 400, req, config);
    }
    const result = await openInVsCode(body.path);
    return jsonResponse(result, result.ok ? 200 : 409, req, config);
  }

  return null;
}

/** Create the staging directory helper's parent, used by callers that stage first. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
