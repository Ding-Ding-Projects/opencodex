/**
 * The app-logo customization card: shipped presets plus a local custom-image
 * upload, per the universal "app-logo customization surface" contract.
 *
 * Structure mirrors `LanguageVoice.tsx`'s `VocabularyCard` deliberately — a
 * semantic file picker with explicit no-file/loading/invalid/loaded/replace/
 * clear states — extended with the editor step this contract additionally
 * requires: fit, background, focal point and crop, each of them a *real*
 * control that changes what `convertLogoImage` actually draws, never a
 * decorative preview bolted on afterward. See `theme/app-logo.ts` for the
 * validation/conversion pipeline this card drives, and its header comment for
 * why the store lives outside `Prefs` and outside React entirely.
 */

import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Card, Chip, Field, TextInput } from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../../shell/settings-search";
import { ColorField } from "./ColorPicker";
import { IconSearch } from "../../icons";
import { useT } from "../../i18n/shared";
import { useNotifications } from "../../shell/notifications-context";
import {
  CUSTOM_SOURCE_ID,
  DEFAULT_FOCAL,
  LOGO_MAX_DIMENSION,
  LOGO_MAX_FILE_BYTES,
  LOGO_OUTPUT_SIZES,
  LOGO_PRESETS,
  SHIPPED_LOGO_PRESET_ID,
  clampCropBox,
  computeDestRect,
  convertLogoImage,
  findPreset,
  maxSquareSize,
  presetImageSrc,
  probeImageBytes,
  reportLogoConversionFailure,
  reportLogoRejection,
  type FocalPoint,
  type LogoConversionFailureReason,
  type LogoConversionOptions,
  type LogoFit,
  type LogoProbeOk,
  type LogoProbeRejectReason,
  type PixelCropBox,
} from "../../theme/app-logo";
import { useAppLogo } from "../../theme/use-app-logo";
import type { TFn, TKey } from "../../i18n/shared";

/* -------------------------------------------------------------- search ---- */

/** Local, not shared: mirrors `Appearance.tsx`'s own `makeMatcher`, for the
 *  reason that file gives — this screen reports a bare "no match" rather
 *  than the compiler's own message, so it wants a boolean where the shared
 *  matcher returns a string. */
function makeMatcher(query: string, useRegex: boolean, flags: string): { test: (text: string) => boolean; invalid: boolean } {
  const matcher = settingsMatcher(query, useRegex, flags);
  return { test: matcher.test, invalid: matcher.error !== null };
}

/* --------------------------------------------------------- reason copy ---- */

const PROBE_REASON_KEY: Record<LogoProbeRejectReason, TKey> = {
  "empty-file": "appearance.logoReasonEmptyFile",
  "too-large": "appearance.logoReasonTooLarge",
  "unsupported-format": "appearance.logoReasonUnsupportedFormat",
  "malformed-header": "appearance.logoReasonMalformedHeader",
  "zero-dimension": "appearance.logoReasonZeroDimension",
  "dimensions-too-large": "appearance.logoReasonDimensionsTooLarge",
  "pixels-too-large": "appearance.logoReasonPixelsTooLarge",
  "animated-not-supported": "appearance.logoReasonAnimatedNotSupported",
};

function probeReasonVars(reason: LogoProbeRejectReason): Record<string, string | number> | undefined {
  if (reason === "too-large") return { limit: Math.round(LOGO_MAX_FILE_BYTES / 1024 / 1024) };
  if (reason === "dimensions-too-large") return { limit: LOGO_MAX_DIMENSION };
  return undefined;
}

function describeProbeRejection(t: TFn, reason: LogoProbeRejectReason): string {
  return t(PROBE_REASON_KEY[reason], probeReasonVars(reason));
}

const CONVERSION_REASON_KEY: Record<LogoConversionFailureReason, TKey> = {
  "no-raster-surface": "appearance.logoConvReasonNoRasterSurface",
  "decode-failed": "appearance.logoConvReasonDecodeFailed",
  "decode-mismatch": "appearance.logoConvReasonDecodeMismatch",
  "encode-failed": "appearance.logoConvReasonEncodeFailed",
  "round-trip-failed": "appearance.logoConvReasonRoundTripFailed",
  "output-too-large": "appearance.logoConvReasonOutputTooLarge",
};

function describeConversionFailure(t: TFn, reason: LogoConversionFailureReason): string {
  return t(CONVERSION_REASON_KEY[reason]);
}

const FIT_LABEL_KEY: Record<LogoFit, TKey> = {
  contain: "appearance.logoFitContain",
  fill: "appearance.logoFitFill",
  crop: "appearance.logoFitCrop",
};

/* ---------------------------------------------------------- edit session -- */

interface EditSession {
  readonly bytes: Uint8Array;
  readonly probe: LogoProbeOk;
  /** An object URL over the picked `File`, for the CSS-only live preview
   *  below — never persisted, and revoked the moment the session closes. */
  readonly previewUrl: string;
  readonly fit: LogoFit;
  readonly background: string | null;
  readonly focal: FocalPoint;
  readonly cropBox: PixelCropBox | null;
}

/* -------------------------------------------------------- final preview --- */

const CHECKER: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, #8884 25%, transparent 25%, transparent 75%, #8884 75%)," +
    "linear-gradient(45deg, #8884 25%, transparent 25%, transparent 75%, #8884 75%)",
  backgroundSize: "10px 10px",
  backgroundPosition: "0 0, 5px 5px",
};

/**
 * What the mark will actually look like at one target size — the same
 * `computeSourceRect`/`computeDestRect` math `convertLogoImage` uses to draw
 * the authoritative canvas output, applied here as CSS instead so the
 * preview updates instantly without waiting on a real encode. The two are
 * guaranteed to agree because they share the one geometry module rather than
 * two independent implementations of "what contain means".
 */
function FinalPreview({
  session, effectiveCrop, displaySize, trueSize, showSafeArea, label, t,
}: {
  session: EditSession;
  effectiveCrop: PixelCropBox;
  /** The on-screen pixel size this preview renders at. */
  displaySize: number;
  /** The real output size it represents, shown as a caption. */
  trueSize: number;
  showSafeArea: boolean;
  label: string;
  t: TFn;
}) {
  const source = { width: session.probe.width, height: session.probe.height };
  let imgStyle: React.CSSProperties;
  if (session.fit === "fill") {
    imgStyle = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill" };
  } else if (session.fit === "crop") {
    const scale = displaySize / effectiveCrop.size;
    imgStyle = {
      position: "absolute",
      left: -effectiveCrop.x * scale,
      top: -effectiveCrop.y * scale,
      width: source.width * scale,
      height: source.height * scale,
      maxWidth: "none",
    };
  } else {
    const dest = computeDestRect("contain", { x: 0, y: 0, w: source.width, h: source.height }, displaySize);
    imgStyle = { position: "absolute", left: dest.x, top: dest.y, width: dest.w, height: dest.h };
  }
  return (
    <figure style={{ margin: 0, display: "grid", justifyItems: "center", gap: 4 }}>
      <div
        style={{
          position: "relative",
          width: displaySize,
          height: displaySize,
          overflow: "hidden",
          borderRadius: "var(--r-m)",
          border: "1px solid var(--m3-outline-variant)",
          background: session.background ?? undefined,
          ...(session.background ? undefined : CHECKER),
        }}
      >
        <img src={session.previewUrl} alt="" aria-hidden="true" style={imgStyle} />
        {showSafeArea && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: `${displaySize * 0.17}px`,
              borderRadius: "50%",
              border: "1.5px dashed var(--m3-error)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      <figcaption style={{ fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)" }}>
        {label} · {t("appearance.pxValue", { n: String(trueSize) })}
      </figcaption>
    </figure>
  );
}

/* --------------------------------------------------------- crop selector -- */

const CROP_PREVIEW_SIZE = 220;

function CropSelector({
  session, effectiveCrop, onCropChange, t,
}: {
  session: EditSession;
  effectiveCrop: PixelCropBox;
  onCropChange: (box: PixelCropBox) => void;
  t: TFn;
}) {
  const source = { width: session.probe.width, height: session.probe.height };
  const contain = computeDestRect("contain", { x: 0, y: 0, w: source.width, h: source.height }, CROP_PREVIEW_SIZE);
  const scale = contain.w / source.width;
  const overlay = {
    x: contain.x + effectiveCrop.x * scale,
    y: contain.y + effectiveCrop.y * scale,
    size: effectiveCrop.size * scale,
  };
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; startBox: PixelCropBox } | null>(null);

  const applyDelta = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxSource = (clientX - drag.startX) / scale;
    const dySource = (clientY - drag.startY) / scale;
    const next: PixelCropBox = drag.mode === "move"
      ? { x: drag.startBox.x + dxSource, y: drag.startBox.y + dySource, size: drag.startBox.size }
      : { x: drag.startBox.x, y: drag.startBox.y, size: drag.startBox.size + Math.max(dxSource, dySource) };
    onCropChange(clampCropBox(next, source));
  };

  // Plain event handlers rather than a `beginDrag(mode) => (event) => …`
  // factory: the factory shape reads `dragRef.current` from inside a
  // function *returned by* another function, which the refs lint rule
  // cannot statically prove never runs during render — even though calling
  // `beginDrag("move")` in JSX only ever produces the closure, never invokes
  // it. Two concrete handlers sidestep the ambiguity entirely.
  const onMoveHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode: "move", startX: event.clientX, startY: event.clientY, startBox: effectiveCrop };
  };
  const onResizeHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode: "resize", startX: event.clientX, startY: event.clientY, startBox: effectiveCrop };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) applyDelta(event.clientX, event.clientY);
  };
  const endDrag = () => { dragRef.current = null; };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 16 : 4;
    let next = effectiveCrop;
    if (event.key === "ArrowLeft") next = { ...next, x: next.x - step };
    else if (event.key === "ArrowRight") next = { ...next, x: next.x + step };
    else if (event.key === "ArrowUp") next = { ...next, y: next.y - step };
    else if (event.key === "ArrowDown") next = { ...next, y: next.y + step };
    else if (event.key === "+" || event.key === "=" || event.key === "PageUp") next = { ...next, size: next.size + step };
    else if (event.key === "-" || event.key === "PageDown") next = { ...next, size: next.size - step };
    else return;
    event.preventDefault();
    onCropChange(clampCropBox(next, source));
  };

  return (
    <div
      style={{
        position: "relative",
        width: CROP_PREVIEW_SIZE,
        height: CROP_PREVIEW_SIZE,
        borderRadius: "var(--r-m)",
        border: "1px solid var(--m3-outline-variant)",
        background: "var(--m3-surface-container-highest)",
        overflow: "hidden",
      }}
    >
      <img
        src={session.previewUrl}
        alt=""
        aria-hidden="true"
        style={{ position: "absolute", left: contain.x, top: contain.y, width: contain.w, height: contain.h }}
      />
      <div
        role="group"
        tabIndex={0}
        aria-label={t("appearance.logoCropBoxAria")}
        onPointerDown={onMoveHandleDown}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        style={{
          position: "absolute",
          left: overlay.x,
          top: overlay.y,
          width: overlay.size,
          height: overlay.size,
          border: "2px solid var(--m3-primary)",
          background: "color-mix(in srgb, var(--m3-primary) 20%, transparent)",
          cursor: "move",
          touchAction: "none",
        }}
      >
        <div
          onPointerDown={onResizeHandleDown}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-hidden="true"
          style={{
            position: "absolute",
            right: -6,
            bottom: -6,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--m3-primary)",
            cursor: "nwse-resize",
            touchAction: "none",
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the editor - */

function LogoEditor({ session, setSession, onUse, onCancel, busy, t }: {
  session: EditSession;
  setSession: (updater: (previous: EditSession) => EditSession) => void;
  onUse: () => void;
  onCancel: () => void;
  busy: boolean;
  t: TFn;
}) {
  const source = { width: session.probe.width, height: session.probe.height };
  const effectiveCrop = session.cropBox ?? {
    x: Math.min(Math.max(session.focal.x * source.width - maxSquareSize(source) / 2, 0), Math.max(0, source.width - maxSquareSize(source))),
    y: Math.min(Math.max(session.focal.y * source.height - maxSquareSize(source) / 2, 0), Math.max(0, source.height - maxSquareSize(source))),
    size: maxSquareSize(source),
  };

  return (
    <div className="m3-field" style={{ marginTop: "var(--sp-3)", borderTop: "1px solid var(--m3-outline-variant)", paddingTop: "var(--sp-3)" }}>
      <span className="m3-field-label">{t("appearance.logoEditorTitle")}</span>

      <Field label={t("appearance.logoFitLabel")} hint={t("appearance.logoFitHint")}>
        <div className="m3-row" role="radiogroup" aria-label={t("appearance.logoFitLabel")} style={{ gap: 8 }}>
          {(["contain", "fill", "crop"] as const).map(fit => (
            <button
              key={fit}
              type="button"
              role="radio"
              aria-checked={session.fit === fit}
              className={`m3-chip${session.fit === fit ? " selected" : ""}`}
              onClick={() => setSession(previous => ({ ...previous, fit }))}
            >
              {t(FIT_LABEL_KEY[fit])}
            </button>
          ))}
        </div>
      </Field>

      <ColorField
        label={t("appearance.logoBackgroundLabel")}
        hint={t("appearance.logoBackgroundHint")}
        value={session.background ?? undefined}
        onChange={value => setSession(previous => ({ ...previous, background: value ?? null }))}
      />

      {session.fit === "crop" && (
        <>
          {session.cropBox === null ? (
            <Field label={t("appearance.logoFocalLabel")} hint={t("appearance.logoFocalHint")}>
              <div className="m3-grid">
                <label className="m3-field">
                  <span className="m3-field-label">{t("appearance.logoFocalX")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={session.focal.x}
                    aria-label={t("appearance.logoFocalX")}
                    onChange={event => setSession(previous => ({ ...previous, focal: { ...previous.focal, x: Number(event.target.value) } }))}
                  />
                </label>
                <label className="m3-field">
                  <span className="m3-field-label">{t("appearance.logoFocalY")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={session.focal.y}
                    aria-label={t("appearance.logoFocalY")}
                    onChange={event => setSession(previous => ({ ...previous, focal: { ...previous.focal, y: Number(event.target.value) } }))}
                  />
                </label>
              </div>
            </Field>
          ) : (
            <div className="m3-row" style={{ gap: 8, alignItems: "center" }}>
              <p className="m3-field-hint" style={{ margin: 0 }}>{t("appearance.logoCropCustomHint")}</p>
              <Button variant="text" onClick={() => setSession(previous => ({ ...previous, cropBox: null }))}>
                {t("appearance.logoRecenterFocal")}
              </Button>
            </div>
          )}

          <Field label={t("appearance.logoCropLabel")} hint={t("appearance.logoCropHint")}>
            <div className="m3-row" style={{ gap: "var(--sp-3)", alignItems: "flex-start", flexWrap: "wrap" }}>
              <CropSelector
                session={session}
                effectiveCrop={effectiveCrop}
                onCropChange={box => setSession(previous => ({ ...previous, cropBox: box }))}
                t={t}
              />
              <div className="m3-grid" style={{ gap: 8, minWidth: 160 }}>
                {([
                  ["x", t("appearance.logoCropX")],
                  ["y", t("appearance.logoCropY")],
                  ["size", t("appearance.logoCropSize")],
                ] as const).map(([field, label]) => (
                  <label key={field} className="m3-field">
                    <span className="m3-field-label">{label}</span>
                    <TextInput
                      type="number"
                      min={0}
                      value={Math.round(effectiveCrop[field])}
                      onChange={event => {
                        const n = Number(event.target.value);
                        if (!Number.isFinite(n)) return;
                        setSession(previous => ({ ...previous, cropBox: clampCropBox({ ...effectiveCrop, [field]: n }, source) }));
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          </Field>
        </>
      )}

      <Field label={t("appearance.logoPreviewLabel")}>
        <div className="m3-row" style={{ gap: "var(--sp-3)", flexWrap: "wrap" }}>
          {LOGO_OUTPUT_SIZES.map(size => (
            <FinalPreview
              key={size}
              session={session}
              effectiveCrop={effectiveCrop}
              displaySize={Math.min(size, 96)}
              trueSize={size}
              showSafeArea
              label={t("appearance.logoSafeArea")}
              t={t}
            />
          ))}
        </div>
        <p className="m3-field-hint">{t("appearance.logoSafeAreaHint")}</p>
      </Field>

      <div className="m3-row" style={{ gap: 8, marginTop: "var(--sp-2)" }}>
        <Button variant="filled" disabled={busy} onClick={onUse}>{t("appearance.logoUseImage")}</Button>
        <Button variant="text" disabled={busy} onClick={onCancel}>{t("appearance.logoCancelEdit")}</Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- the main card -- */

export function AppLogoPicker() {
  const t = useT();
  const { notify } = useNotifications();
  const logo = useAppLogo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<EditSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);

  // Revoke the preview object URL whenever the session that owns it closes or
  // is replaced — it is never persisted, so nothing else will ever release it.
  useEffect(() => () => { if (session) URL.revokeObjectURL(session.previewUrl); }, [session]);

  const matcher = makeMatcher(query, useRegex, flags);
  const presetLabels = LOGO_PRESETS.map(p => t(p.tkey as TKey));
  const visiblePresets = LOGO_PRESETS.filter(p => matcher.test(t(p.tkey as TKey)));

  const closeSession = () => setSession(null);

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      if (file.size === 0) {
        reportLogoRejection("empty-file");
        notify({ tone: "error", title: t("appearance.logoInvalidNotice"), body: describeProbeRejection(t, "empty-file") });
        return;
      }
      if (file.size > LOGO_MAX_FILE_BYTES) {
        reportLogoRejection("too-large");
        notify({ tone: "error", title: t("appearance.logoInvalidNotice"), body: describeProbeRejection(t, "too-large") });
        return;
      }
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const probe = probeImageBytes(bytes);
      if (!probe.ok) {
        reportLogoRejection(probe.reason);
        notify({ tone: "error", title: t("appearance.logoInvalidNotice"), body: describeProbeRejection(t, probe.reason) });
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      setSession({ bytes, probe, previewUrl, fit: "contain", background: null, focal: DEFAULT_FOCAL, cropBox: null });
    } finally {
      setBusy(false);
    }
  };

  const onUse = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const opts: LogoConversionOptions = { fit: session.fit, background: session.background, focal: session.focal, cropBox: session.cropBox };
      const result = await convertLogoImage(session.bytes, session.probe, opts);
      if (!result.ok) {
        reportLogoConversionFailure(result.reason);
        notify({
          tone: "error",
          title: t("appearance.logoConversionFailedNotice"),
          body: t("appearance.logoConversionFailedNoticeBody", { reason: describeConversionFailure(t, result.reason) }),
        });
        return;
      }
      logo.applyCustom(result.asset);
      notify({
        tone: "success",
        title: t("appearance.logoLoadedNotice"),
        body: t("appearance.logoLoadedNoticeBody", { width: result.asset.sourceWidth, height: result.asset.sourceHeight }),
      });
      closeSession();
    } finally {
      setBusy(false);
    }
  };

  const onSelectPreset = (id: string) => {
    logo.selectPreset(id);
    const preset = findPreset(id);
    notify({ tone: "success", title: t("appearance.logoPresetNotice", { name: preset ? t(preset.tkey as TKey) : id }) });
  };

  const onReset = () => {
    logo.reset();
    notify({ tone: "info", title: t("appearance.logoResetNotice") });
  };

  const activePreset = logo.applied.sourceId !== CUSTOM_SOURCE_ID ? findPreset(logo.applied.sourceId) : null;
  const statusText = busy
    ? t("appearance.logoStateLoading")
    : logo.lastConversionFailure
      ? t("appearance.logoStateConversionFailed", { reason: describeConversionFailure(t, logo.lastConversionFailure) })
      : logo.lastRejection
        ? t("appearance.logoStateInvalid", { reason: describeProbeRejection(t, logo.lastRejection) })
        : logo.applied.sourceId === CUSTOM_SOURCE_ID && logo.applied.custom
          ? t("appearance.logoStateActive", {
              width: logo.applied.custom.sourceWidth,
              height: logo.applied.custom.sourceHeight,
              format: logo.applied.custom.format.toUpperCase(),
              fit: t(FIT_LABEL_KEY[logo.applied.custom.fit]),
            })
          : t("appearance.logoStateNone", { name: activePreset ? t(activePreset.tkey as TKey) : SHIPPED_LOGO_PRESET_ID });

  return (
    <Card title={t("appearance.logoTitle")} subtitle={t("appearance.logoSub")}>
      <p style={{ margin: "0 0 var(--sp-3)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
        {t("appearance.logoPrivacyHint")}
      </p>

      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-2)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("appearance.logoSearch")}
          aria-label={t("appearance.logoSearch")}
          aria-invalid={matcher.invalid}
          aria-describedby={useRegex ? "applogo-regex-flags-state" : undefined}
          style={{ flex: "1 1 200px", width: "auto", minWidth: 0, maxWidth: 360 }}
        />
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("regex.regexMode")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          sample={presetLabels.join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <SearchFlagsRow regex={useRegex} flags={flags} onFlagsChange={setFlags} id="applogo-regex-flags-state" />
      <p role="status" style={{ minHeight: 20, margin: "0 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
        {matcher.invalid ? t("regex.invalid") : query && visiblePresets.length === 0 ? t("appearance.logoNoMatch") : ""}
      </p>

      <div
        role="radiogroup"
        aria-label={t("appearance.logoPresetsGroup")}
        className="m3-row"
        style={{ gap: 12, flexWrap: "wrap", marginBottom: "var(--sp-3)" }}
      >
        {visiblePresets.map(preset => {
          const checked = logo.applied.sourceId === preset.id && logo.applied.sourceId !== CUSTOM_SOURCE_ID;
          const label = t(preset.tkey as TKey);
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={label}
              title={label}
              onClick={() => onSelectPreset(preset.id)}
              style={{
                display: "grid",
                justifyItems: "center",
                gap: 4,
                padding: 8,
                width: 88,
                borderRadius: "var(--r-m)",
                border: checked ? "2px solid var(--m3-primary)" : "1px solid var(--m3-outline-variant)",
                background: "var(--m3-surface-container-lowest)",
                cursor: "pointer",
              }}
            >
              <img src={presetImageSrc(preset)} alt="" aria-hidden="true" width={48} height={48} style={{ borderRadius: "var(--r-s)" }} />
              <span style={{ fontSize: "var(--t-label-s)", textAlign: "center" }}>{label}</span>
              {checked && <span style={{ fontSize: "var(--t-label-s)", color: "var(--m3-primary)" }}>{t("appearance.logoCurrentBadge")}</span>}
            </button>
          );
        })}
      </div>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={event => void onPick(event)} />

      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-2)" }}>
        <Button variant="outlined" disabled={busy || !!session} onClick={() => fileRef.current?.click()}>
          {logo.applied.sourceId === CUSTOM_SOURCE_ID ? t("appearance.logoReplaceLabel") : t("appearance.logoUploadLabel")}
        </Button>
        {logo.applied.sourceId !== SHIPPED_LOGO_PRESET_ID && (
          <Button variant="outlined" disabled={busy} onClick={onReset}>{t("appearance.logoResetLabel")}</Button>
        )}
      </div>

      {!session && (
        <p role="status" style={{ margin: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
          {statusText}
        </p>
      )}

      {session && (
        <LogoEditor session={session} setSession={updater => setSession(previous => (previous ? updater(previous) : previous))} onUse={() => void onUse()} onCancel={closeSession} busy={busy} t={t} />
      )}
    </Card>
  );
}
