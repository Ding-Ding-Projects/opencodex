/**
 * Appearance — theme, density, seed colour, typography, and the per-element
 * editors. Everything writes through `usePrefs()`, so the whole shell retints
 * live; nothing here needs a reload or a save button.
 */

import { useState } from "react";
import { Button, Card, Chip, Field, Segmented, Slider, TextInput, Toggle } from "../shell/m3-ui";
import { useT } from "../i18n/shared";
import { ELEMENT_TARGETS, usePrefs } from "../theme/prefs-context";
import { FONT_CHOICES, SEED_SWATCHES, type DensityLevel, type ThemeMode } from "../theme/m3";
import { recordRevision } from "../shell/revisions";
import { useNotifications } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export default function Appearance() {
  const t = useT();
  const { prefs, setPrefs, setElementStyle, resetElementStyle, resetAppearance } = usePrefs();
  const { notify } = useNotifications();
  const [seedText, setSeedText] = useState(prefs.seed);
  const [target, setTarget] = useState<string>(ELEMENT_TARGETS[0].id);

  const commitSeed = (value: string) => {
    setSeedText(value);
    if (HEX.test(value)) setPrefs({ seed: value });
  };

  const el = prefs.elementStyles[target] ?? {};

  const onReset = () => {
    recordRevision({ scope: "settings", label: t("appearance.title"), summary: t("appearance.resetRecorded") });
    resetAppearance();
    notify({ tone: "info", title: t("appearance.resetDone") });
  };

  return (
    <>
      <Card
        title={t("appearance.themeTitle")}
        subtitle={t("appearance.themeSub")}
        actions={<Button variant="text" onClick={onReset}>{t("appearance.reset")}</Button>}
      >
        <Segmented<ThemeMode>
          label={t("theme.label")}
          value={prefs.theme}
          onChange={theme => setPrefs({ theme })}
          options={[
            { value: "light", label: t("theme.light") },
            { value: "dark", label: t("theme.dark") },
            { value: "system", label: t("theme.system") },
          ]}
        />
      </Card>

      <Card title={t("appearance.seedTitle")} subtitle={t("appearance.seedSub")}>
        <div className="m3-row">
          <input
            type="color"
            value={HEX.test(seedText) ? seedText : prefs.seed}
            onChange={e => commitSeed(e.target.value)}
            aria-label={t("appearance.seedPicker")}
            style={{ width: 56, height: 44, border: "none", background: "none", cursor: "pointer" }}
          />
          <TextInput
            value={seedText}
            onChange={e => commitSeed(e.target.value)}
            aria-label={t("appearance.seedHex")}
            aria-invalid={!HEX.test(seedText)}
            spellCheck={false}
            style={{ width: 160, fontFamily: "var(--mono)" }}
          />
          {!HEX.test(seedText) && <span style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("appearance.seedInvalid")}</span>}
        </div>
        <div className="m3-row" style={{ marginTop: "var(--sp-3)", gap: 8 }}>
          {SEED_SWATCHES.map(hex => (
            <button
              key={hex}
              type="button"
              onClick={() => commitSeed(hex)}
              aria-label={hex}
              aria-pressed={prefs.seed.toLowerCase() === hex.toLowerCase()}
              title={hex}
              style={{
                width: 44, height: 44, borderRadius: "var(--r-pill)", cursor: "pointer",
                background: hex,
                border: prefs.seed.toLowerCase() === hex.toLowerCase()
                  ? "3px solid var(--m3-on-surface)"
                  : "1px solid var(--m3-outline-variant)",
              }}
            />
          ))}
        </div>
      </Card>

      <Card title={t("appearance.densityTitle")} subtitle={t("appearance.densitySub")}>
        <Slider
          id="ocx-density"
          label={t("appearance.density")}
          min={1}
          max={5}
          value={prefs.density}
          valueLabel={String(prefs.density)}
          onChange={v => setPrefs({ density: v as DensityLevel })}
        />
      </Card>

      <Card title={t("appearance.typeTitle")} subtitle={t("appearance.typeSub")}>
        <Field label={t("appearance.fontFamily")}>
          <div className="m3-row" style={{ gap: 8 }}>
            {FONT_CHOICES.map(font => (
              <Chip key={font.id} selected={prefs.fontId === font.id} onClick={() => setPrefs({ fontId: font.id })}>
                <span style={{ fontFamily: font.stack }}>{font.label}</span>
              </Chip>
            ))}
          </div>
        </Field>
        <Slider
          id="ocx-fontscale"
          label={t("appearance.fontScale")}
          min={0.8}
          max={1.6}
          step={0.05}
          value={prefs.fontScale}
          valueLabel={`${Math.round(prefs.fontScale * 100)}%`}
          onChange={fontScale => setPrefs({ fontScale })}
        />
        <Slider
          id="ocx-fontweight"
          label={t("appearance.fontWeight")}
          min={300}
          max={700}
          step={100}
          value={prefs.fontWeight}
          valueLabel={String(prefs.fontWeight)}
          onChange={fontWeight => setPrefs({ fontWeight })}
        />

        <div style={{ marginTop: "var(--sp-4)", padding: "var(--pad-card)", borderRadius: "var(--r-m)", background: "var(--m3-surface-container)" }}>
          <div style={{ fontSize: "var(--t-headline-s)", fontWeight: 500 }}>{t("appearance.previewHeadline")}</div>
          <p style={{ margin: "8px 0 0", fontSize: "var(--t-body-m)", color: "var(--m3-on-surface-variant)" }}>
            {t("appearance.previewBody")}
          </p>
          <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="filled">{t("appearance.previewPrimary")}</Button>
            <Button variant="tonal">{t("appearance.previewTonal")}</Button>
            <Button variant="outlined">{t("appearance.previewOutlined")}</Button>
          </div>
        </div>
      </Card>

      <Card title={t("appearance.elementsTitle")} subtitle={t("appearance.elementsSub")}>
        <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)" }}>
          {ELEMENT_TARGETS.map(item => (
            <Chip key={item.id} selected={target === item.id} onClick={() => setTarget(item.id)}>
              {t(item.tkey as TKey)}
            </Chip>
          ))}
        </div>

        <div className="m3-grid">
          <Field label={t("appearance.elBg")}>
            <div className="m3-row">
              <input type="color" value={el.bg ?? "#ffffff"} onChange={e => setElementStyle(target, { bg: e.target.value })}
                aria-label={t("appearance.elBg")} style={{ width: 48, height: 40, border: "none", background: "none", cursor: "pointer" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>{el.bg ?? t("appearance.elInherit")}</span>
            </div>
          </Field>
          <Field label={t("appearance.elColor")}>
            <div className="m3-row">
              <input type="color" value={el.color ?? "#000000"} onChange={e => setElementStyle(target, { color: e.target.value })}
                aria-label={t("appearance.elColor")} style={{ width: 48, height: 40, border: "none", background: "none", cursor: "pointer" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>{el.color ?? t("appearance.elInherit")}</span>
            </div>
          </Field>
          <Slider id={`el-${target}-radius`} label={t("appearance.elRadius")} min={0} max={32}
            value={el.radius ?? 12} valueLabel={t("appearance.pxValue", { n: String(el.radius ?? 12) })}
            onChange={radius => setElementStyle(target, { radius })} />
          <Slider id={`el-${target}-pad`} label={t("appearance.elPad")} min={0} max={40}
            value={el.pad ?? 12} valueLabel={t("appearance.pxValue", { n: String(el.pad ?? 12) })}
            onChange={pad => setElementStyle(target, { pad })} />
        </div>

        <Button variant="text" onClick={() => resetElementStyle(target)}>{t("appearance.elReset")}</Button>
      </Card>

      <Card title={t("dimsum.toggle")} subtitle={t("dimsum.toggleHint")}>
        <div className="m3-row m3-row--split">
          <span>{t("dimsum.toggle")}</span>
          <Toggle
            on={prefs.dimsum}
            onChange={dimsum => setPrefs({ dimsum })}
            label={t("dimsum.toggle")}
          />
        </div>
      </Card>

      <Card title={t("appearance.motionTitle")} subtitle={t("appearance.motionSub")}>
        <div className="m3-row m3-row--split">
          <span>{t("appearance.reducedMotion")}</span>
          <Toggle
            on={typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches}
            onChange={() => notify({ tone: "info", title: t("appearance.reducedMotionOsOnly") })}
            label={t("appearance.reducedMotion")}
            disabled
          />
        </div>
      </Card>
    </>
  );
}
