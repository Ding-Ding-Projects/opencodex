/**
 * A path text box with the native Browse control the shared guided-forms rule
 * requires of every path field: *"Every path text box carries a native browse
 * control -- browse-for-folder, browse-for-file, or both together when the
 * field can legitimately hold either -- beside the free-text entry."*
 *
 * Before this existed there was no `showOpenDialog` anywhere in the tree, and
 * `PdfTools.tsx` carried a comment saying so. The converter and PDF screens
 * told the user to their face: *"Type the full path to a file already on this
 * machine. No page in this app has a native file-browse dialog yet."* Honest
 * about the gap, and still asking somebody to hand-type
 * `C:\Users\...\Documents\file`.
 *
 * ## Typed and browsed values are the same value
 *
 * Both go through `onChange`, unchanged. A browsed path is not trusted more
 * than a typed one and is not validated less: whatever validation the owning
 * screen applies, it applies to both, because the two are indistinguishable by
 * the time they leave here. That is the guided-forms rule's other half -- free
 * text stays available for whatever a picker cannot anticipate.
 *
 * ## When there is no shell to ask
 *
 * In a browser -- the dev server, the docs site, the phone remote -- there is
 * no `window.opencodexDesktop.dialog`, and nothing can open a native dialog.
 * The Browse button is then NOT rendered, rather than rendered disabled or
 * rendered inert. A control that looks like it works and does not is the exact
 * defect these rules forbid everywhere else, and a disabled button with no
 * explanation reads as broken rather than as unavailable. The field keeps
 * working as ordinary free text, which is what it was before this component
 * existed.
 */
import { useCallback, useId, useState } from "react";
import { IconFolderOpen } from "../icons";
import { useI18n } from "../i18n";

export type PathInputMode = "file" | "directory" | "save";

export function PathInput({
  value,
  onChange,
  mode = "file",
  placeholder,
  id,
  className = "m3-input",
  disabled,
  ariaLabel,
  dialogTitle,
}: {
  value: string;
  onChange: (next: string) => void;
  /** What the Browse button opens. Also picks its label. */
  mode?: PathInputMode;
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  /** Use when no visible <label> is associated with the field. */
  ariaLabel?: string;
  /** Shown in the native dialog's own title bar. Falls back to the button label. */
  dialogTitle?: string;
}) {
  const { t } = useI18n();
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bridge = typeof window === "undefined" ? undefined : window.opencodexDesktop?.dialog;

  const label = mode === "directory" ? t("path.browseFolder") : t("path.browseFile");

  const browse = useCallback(async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.openPath({
        mode,
        title: dialogTitle ?? label,
        // Start where the field already points, so a second Browse does not
        // send the user back to their home directory.
        defaultPath: value || undefined,
      });
      // Cancelling is a normal outcome, not a failure: leave the field exactly
      // as it was and say nothing.
      if (res.canceled) return;
      if (!res.ok) { setError(res.error || t("path.browseFailed")); return; }
      if (res.path) onChange(res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [bridge, busy, dialogTitle, label, mode, onChange, t, value]);

  return (
    <div className="m3-pathinput">
      <div className="m3-pathinput__row">
        <input
          id={inputId}
          className={className}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          spellCheck={false}
          autoComplete="off"
        />
        {bridge && (
          <button
            type="button"
            className="m3-btn m3-btn--outlined m3-pathinput__browse"
            onClick={() => void browse()}
            disabled={disabled || busy}
            // Its own accessible name, distinct from the field's -- a screen
            // reader landing on it should hear what it opens, not the label of
            // the box beside it.
            aria-label={label}
            aria-controls={inputId}
          >
            <IconFolderOpen width={16} height={16} aria-hidden="true" />
            {busy ? t("path.browsing") : label}
          </button>
        )}
      </div>
      {error && <div className="m3-pathinput__error" role="alert">{error}</div>}
    </div>
  );
}
