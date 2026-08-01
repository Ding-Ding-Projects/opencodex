/**
 * The export dialog: pick formats, pick an archive, optionally open it in VS Code.
 *
 * The design constraint that shapes all of it: **the user is told what will be
 * lost before they commit, not after.** Fidelity is computed server-side against
 * the real rows — CSV is lossless for a flat dataset and lossy for a nested one,
 * so a client guessing from the format name would be wrong exactly when it
 * mattered. Selecting a lossy format shows what it drops, in words, immediately.
 *
 * Two other things it refuses to do quietly:
 *
 *  - **Offer an encrypted 7z on a machine that cannot produce one.** Availability
 *    is reported by the server and the option is disabled with the reason
 *    attached, rather than failing at the last step after the password is typed.
 *  - **Let "encrypted" mean half-encrypted.** Filename encryption is on by
 *    default and turning it off states, on screen, that the names stay readable.
 *
 * A blocking dialog is correct here: this is a decision with irreversible
 * consequences on disk, which is exactly the carve-out the notification rules
 * keep modals for.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, Field, SelectField, Toggle } from "../shell/m3-ui";
import { useT } from "../i18n/shared";

interface FormatCapability {
  format: string;
  label: string;
  extension: string;
  mime: string;
  level: "full" | "lossy" | "impossible";
  losses: string[];
}

interface DatasetCapability {
  id: string;
  label: string;
  rowCount: number;
  formats: FormatCapability[];
}

interface Capabilities {
  datasets: DatasetCapability[];
  archives: {
    zip: { available: boolean; notes: string[] };
    sevenZip: { available: boolean; notes: string[]; blocked?: string };
  };
  vsCode: { available: boolean; label: string | null; downloadUrl: string | null };
}

export interface ExportDialogProps {
  /** Passed in like every other component here rather than imported: `API_BASE`
   *  is App's own constant and is not exported. */
  apiBase: string;
  dataset: string;
  onClose: () => void;
}

const SEVENZIP_METHODS = ["LZMA2", "LZMA", "PPMd", "BZip2", "Deflate", "Copy"];
const SEVENZIP_LEVELS = ["0", "1", "3", "5", "7", "9"];

export default function ExportDialog({ apiBase, dataset, onClose }: ExportDialogProps) {
  const t = useT();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<string[]>(["json"]);
  const [archive, setArchive] = useState<"" | "zip" | "7z">("");
  const [openAfter, setOpenAfter] = useState(false);

  // 7z knobs. Defaults match 7-Zip's own normal settings, except the one that
  // does not — see `encryptHeaders`.
  const [method, setMethod] = useState("LZMA2");
  const [level, setLevel] = useState("5");
  const [dictionarySize, setDictionarySize] = useState("");
  const [solid, setSolid] = useState(true);
  const [volumeSize, setVolumeSize] = useState("");
  const [password, setPassword] = useState("");
  const [encryptHeaders, setEncryptHeaders] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/export/capabilities?dataset=${encodeURIComponent(dataset)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json() as Capabilities;
        if (!cancelled) setCaps(body);
      } catch {
        if (!cancelled) setError(t("export.capsFailed"));
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, dataset, t]);

  const info = caps?.datasets.find(entry => entry.id === dataset) ?? null;

  /* What the current selection will cost, gathered rather than shown per row —
     a list of five identical "types are not carried" lines is noise, and the
     point is the set of distinct losses. */
  const losses = useMemo(() => {
    if (!info) return [];
    const chosen = info.formats.filter(format => selected.includes(format.format));
    return [...new Set(chosen.flatMap(format => format.losses.map(loss => `${format.label}: ${loss}`)))];
  }, [info, selected]);

  const sevenZipBlocked = !!caps && !caps.archives.sevenZip.available;
  const toggleFormat = useCallback((format: string) => {
    setSelected(current =>
      current.includes(format) ? current.filter(entry => entry !== format) : [...current, format]);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        dataset,
        formats: selected,
        ...(archive ? { archive } : {}),
        ...(openAfter ? { openInVsCode: true } : {}),
      };
      if (archive === "7z") {
        payload.sevenZip = {
          method,
          level: Number(level),
          ...(dictionarySize ? { dictionarySize } : {}),
          solid,
          ...(volumeSize ? { volumeSize } : {}),
          ...(password ? { password, encryptHeaders } : {}),
        };
      }
      const res = await fetch(`${apiBase}/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || t("export.httpError", { status: res.status }));
      }

      const contentType = res.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json")) {
        // The open-in-VS-Code path answers with JSON rather than a body to save.
        const body = await res.json() as { vsCode?: { ok: boolean; message: string } };
        if (body.vsCode && !body.vsCode.ok) setError(body.vsCode.message);
        else onClose();
        return;
      }

      // The server names the file, so the extension always matches what it
      // actually wrote. The fallback is the dataset id alone rather than a
      // guessed extension — a wrong extension is worse than none, because the
      // OS then opens it with the wrong application.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const named = /filename="([^"]+)"/.exec(disposition)?.[1] ?? dataset;
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = named;
      anchor.click();
      URL.revokeObjectURL(href);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, archive, dataset, dictionarySize, encryptHeaders, level, method, onClose, openAfter, password, selected, solid, t, volumeSize]);

  return (
    <Dialog
      onClose={onClose}
      title={t("export.title", { label: info?.label ?? dataset })}
      description={info ? t("export.rows", { count: info.rowCount }) : undefined}
      width={640}
      actions={
        <>
          <Button variant="text" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => void run()} disabled={busy || !selected.length}>
            {busy ? t("export.working") : t("export.run")}
          </Button>
        </>
      }
    >
      {error && <p role="alert" className="m3-banner m3-banner--error">{error}</p>}

      <Field label={t("export.formats")} hint={t("export.formatsHint")}>
        <div className="m3-chiprow">
          {info?.formats.map(format => (
            <button
              key={format.format}
              type="button"
              className={`m3-chip${selected.includes(format.format) ? " selected" : ""}`}
              aria-pressed={selected.includes(format.format)}
              onClick={() => toggleFormat(format.format)}
            >
              {format.label}
              {format.level !== "full" && <span aria-hidden="true"> ·</span>}
            </button>
          ))}
        </div>
      </Field>

      {/* Before the button, not after the download. */}
      {losses.length > 0 && (
        <div role="status" className="m3-banner m3-banner--warn">
          <strong>{t("export.willLose")}</strong>
          <ul>{losses.map(loss => <li key={loss}>{loss}</li>)}</ul>
        </div>
      )}

      <Field label={t("export.archive")}>
        <SelectField
          value={archive}
          onChange={value => setArchive(value as "" | "zip" | "7z")}
          options={[
            { value: "", label: t("export.archiveNone") },
            { value: "zip", label: t("export.zip") },
            // Disabled rather than hidden: a missing option looks like the app
            // does not do 7z, when the truth is this machine cannot right now.
            { value: "7z", label: sevenZipBlocked ? t("export.sevenZipUnavailable") : "7z" },
          ]}
        />
      </Field>

      {archive === "7z" && sevenZipBlocked && (
        <p role="alert" className="m3-banner m3-banner--error">{caps?.archives.sevenZip.blocked}</p>
      )}

      {archive === "7z" && !sevenZipBlocked && (
        <>
          <Field label={t("export.method")}>
            <SelectField value={method} onChange={setMethod}
              options={SEVENZIP_METHODS.map(value => ({ value, label: value }))} />
          </Field>
          <Field label={t("export.level")} hint={t("export.levelHint")}>
            <SelectField value={level} onChange={setLevel}
              options={SEVENZIP_LEVELS.map(value => ({ value, label: value === "0" ? t("export.levelStore") : value }))} />
          </Field>
          <Field label={t("export.dictionary")} hint={t("export.dictionaryHint")}>
            <input className="m3-input" value={dictionarySize} placeholder="64m"
              onChange={event => setDictionarySize(event.target.value)} />
          </Field>
          <Field label={t("export.solid")} hint={t("export.solidHint")}>
            <Toggle on={solid} onChange={setSolid} label={t("export.solid")} />
          </Field>
          <Field label={t("export.volume")} hint={t("export.volumeHint")}>
            <input className="m3-input" value={volumeSize} placeholder="100m"
              onChange={event => setVolumeSize(event.target.value)} />
          </Field>
          <Field label={t("export.password")} hint={t("export.passwordHint")}>
            <input className="m3-input" type="password" value={password} autoComplete="new-password"
              onChange={event => setPassword(event.target.value)} />
          </Field>
          {password && (
            <>
              <Field label={t("export.encryptHeaders")} hint={t("export.encryptHeadersHint")}>
                <Toggle on={encryptHeaders} onChange={setEncryptHeaders} label={t("export.encryptHeaders")} />
              </Field>
              {/* Said plainly, on screen, at the moment it stops being true. */}
              {!encryptHeaders && (
                <p role="alert" className="m3-banner m3-banner--warn">{t("export.headersReadable")}</p>
              )}
            </>
          )}
        </>
      )}

      <Field label={t("export.openAfter")} hint={
        caps?.vsCode.available ? t("export.openAfterHint") : t("export.vsCodeMissing")
      }>
        <Toggle on={openAfter} onChange={setOpenAfter} label={t("export.openAfter")}
          disabled={!caps?.vsCode.available} />
      </Field>
    </Dialog>
  );
}
