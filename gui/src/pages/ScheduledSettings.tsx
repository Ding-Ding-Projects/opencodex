/**
 * Scheduled settings — create, edit and delete rules that switch language,
 * theme, density, seed colour and fonts on a schedule.
 *
 * The engine (matching, precedence, remote resolution, the generation guard)
 * lives in `gui/src/scheduling/`; this page is purely the editor. It reads and
 * writes rules through `useSettingsDrafts()` (`scheduleRules`/
 * `setScheduleRules`), which persists them immediately — a schedule rule is
 * metadata about settings, not a setting itself, so it is not part of the
 * Save/Discard draft flow the rest of this screen's sibling pages use. Every
 * create, edit and delete is recorded in the local Version history, exactly
 * like any other settings change.
 */

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Card, Chip, Dialog, Empty, Field, Segmented, SelectField, TextInput, Toggle } from "../shell/m3-ui";
import { LOCALES, useT } from "../i18n/shared";
import type { TKey } from "../i18n/shared";
import { useSettingsDrafts } from "../settings-drafts-context";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm } from "../shell/confirm-context";
import { recordRevision } from "../shell/revisions";
import { timezoneInfo } from "../scheduling/match";
import {
  LABEL_MAX, PRIORITY_MAX, PRIORITY_MIN, REFRESH_MINUTES_DEFAULT, REFRESH_MINUTES_MAX, REFRESH_MINUTES_MIN,
  newRuleId,
} from "../scheduling/schema";
import { ALL_WEEKDAYS } from "../scheduling/types";
import type { ScheduleRule, ScheduleSourceKind, ScheduleValues, Weekday } from "../scheduling/types";
import { clearHaToken, haTokenConfigured, storeHaToken } from "../scheduling/api-client";
import { GUI_BUNDLED_FAMILIES, GUI_GENERIC_FAMILIES } from "../theme/fonts";
import { IconClock } from "../icons";

interface ScheduledSettingsProps {
  apiBase: string;
}

const WEEKDAY_KEYS: Record<Weekday, TKey> = {
  0: "schedule.weekdaySun", 1: "schedule.weekdayMon", 2: "schedule.weekdayTue",
  3: "schedule.weekdayWed", 4: "schedule.weekdayThu", 5: "schedule.weekdayFri", 6: "schedule.weekdaySat",
};

const FONT_STACKS = [...GUI_BUNDLED_FAMILIES, ...GUI_GENERIC_FAMILIES].map(f => ({ family: f.family, stack: f.stack }));

const UNSET = "";

/** The form's own shape — every field is a string so a native `<select>`/`<input>` can own it directly. */
interface RuleForm {
  label: string;
  enabled: boolean;
  priority: string;
  daysMode: "everyday" | "custom";
  customDays: Weekday[];
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  sourceKind: ScheduleSourceKind;
  theme: string;
  seed: string;
  density: string;
  fontStack: string;
  fontScale: string;
  fontWeight: string;
  locale: string;
  funnyEn: string;
  funnyYue: string;
  apiUrl: string;
  refreshMinutes: string;
  haBaseUrl: string;
  haEntityId: string;
  haTokenInput: string;
}

function valuesFromForm(f: RuleForm): ScheduleValues {
  const out: ScheduleValues = {};
  if (f.theme) out.theme = f.theme as ScheduleValues["theme"];
  if (f.seed) out.seed = f.seed;
  if (f.density) out.density = Number(f.density) as ScheduleValues["density"];
  if (f.fontStack) out.fontStack = f.fontStack;
  if (f.fontScale) out.fontScale = Number(f.fontScale);
  if (f.fontWeight) out.fontWeight = Number(f.fontWeight);
  if (f.locale) out.locale = f.locale as ScheduleValues["locale"];
  if (f.funnyEn) out.funnyEn = Number(f.funnyEn) as ScheduleValues["funnyEn"];
  if (f.funnyYue) out.funnyYue = Number(f.funnyYue) as ScheduleValues["funnyYue"];
  return out;
}

function emptyForm(): RuleForm {
  return {
    label: "", enabled: true, priority: "0", daysMode: "everyday", customDays: [],
    startDate: "", endDate: "", startTime: "", endTime: "",
    sourceKind: "local",
    theme: UNSET, seed: UNSET, density: UNSET, fontStack: UNSET, fontScale: UNSET, fontWeight: UNSET,
    locale: UNSET, funnyEn: UNSET, funnyYue: UNSET,
    apiUrl: "", refreshMinutes: String(REFRESH_MINUTES_DEFAULT),
    haBaseUrl: "", haEntityId: "", haTokenInput: "",
  };
}

function formFromRule(rule: ScheduleRule): RuleForm {
  const base = emptyForm();
  const values: ScheduleValues = rule.source.kind === "api" ? {} : rule.source.values;
  return {
    ...base,
    label: rule.label,
    enabled: rule.enabled,
    priority: String(rule.priority),
    daysMode: rule.days === "everyday" ? "everyday" : "custom",
    customDays: rule.days === "everyday" ? [] : rule.days,
    startDate: rule.startDate ?? "",
    endDate: rule.endDate ?? "",
    startTime: rule.startTime ?? "",
    endTime: rule.endTime ?? "",
    sourceKind: rule.source.kind,
    theme: values.theme ?? UNSET,
    seed: values.seed ?? UNSET,
    density: values.density ? String(values.density) : UNSET,
    fontStack: values.fontStack ?? UNSET,
    fontScale: values.fontScale ? String(values.fontScale) : UNSET,
    fontWeight: values.fontWeight ? String(values.fontWeight) : UNSET,
    locale: values.locale ?? UNSET,
    funnyEn: values.funnyEn ? String(values.funnyEn) : UNSET,
    funnyYue: values.funnyYue ? String(values.funnyYue) : UNSET,
    apiUrl: rule.source.kind === "api" ? rule.source.url : "",
    refreshMinutes: rule.source.kind !== "local" ? String(rule.source.refreshMinutes) : String(REFRESH_MINUTES_DEFAULT),
    haBaseUrl: rule.source.kind === "homeAssistant" ? rule.source.baseUrl : "",
    haEntityId: rule.source.kind === "homeAssistant" ? rule.source.entityId : "",
    haTokenInput: "",
  };
}

function ruleSummary(rule: ScheduleRule, t: ReturnType<typeof useT>): string {
  const days = rule.days === "everyday" ? t("schedule.daysEveryday") : rule.days.map(d => t(WEEKDAY_KEYS[d])).join(" ");
  const time = rule.startTime || rule.endTime ? `${rule.startTime ?? "00:00"}–${rule.endTime ?? "24:00"}` : "";
  return [days, time].filter(Boolean).join(" · ");
}

export default function ScheduledSettings({ apiBase }: ScheduledSettingsProps) {
  const t = useT();
  const { notify } = useNotifications();
  const confirm = useConfirm();
  const drafts = useSettingsDrafts();
  const rules = drafts.scheduleRules;

  const [editing, setEditing] = useState<{ id: string | null; form: RuleForm } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [haConfigured, setHaConfigured] = useState(false);

  const { tz, offset } = useMemo(() => timezoneInfo(), []);
  const activeRule = rules.find(r => r.id === drafts.scheduleActiveRuleId) ?? null;
  const editingId = editing?.id;
  const editingSourceKind = editing?.form.sourceKind;

  useEffect(() => {
    if (editingSourceKind !== "homeAssistant" || !editingId) {
      // This resets derived async status when the editor leaves Home Assistant.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHaConfigured(false);
      return;
    }
    let cancelled = false;
    void haTokenConfigured(apiBase, editingId).then(configured => { if (!cancelled) setHaConfigured(configured); });
    return () => { cancelled = true; };
  }, [apiBase, editingId, editingSourceKind]);

  const openCreate = () => { setError(null); setEditing({ id: null, form: emptyForm() }); };
  const openEdit = (rule: ScheduleRule) => { setError(null); setEditing({ id: rule.id, form: formFromRule(rule) }); };
  const close = () => setEditing(null);

  const patch = (p: Partial<RuleForm>) => setEditing(prev => (prev ? { ...prev, form: { ...prev.form, ...p } } : prev));

  const toggleCustomDay = (day: Weekday) => {
    setEditing(prev => {
      if (!prev) return prev;
      const has = prev.form.customDays.includes(day);
      const next = has ? prev.form.customDays.filter(d => d !== day) : [...prev.form.customDays, day].sort((a, b) => a - b);
      return { ...prev, form: { ...prev.form, customDays: next } };
    });
  };

  const save = async () => {
    if (!editing) return;
    const { form } = editing;
    const label = form.label.trim().slice(0, LABEL_MAX);
    if (!label) { setError(t("schedule.validationLabel")); return; }
    if (form.daysMode === "custom" && form.customDays.length === 0) { setError(t("schedule.validationDays")); return; }
    if (form.sourceKind === "api") {
      const okUrl = /^https:\/\//.test(form.apiUrl) || /^http:\/\/(127\.0\.0\.1|localhost)/.test(form.apiUrl);
      if (!okUrl) { setError(t("schedule.validationUrl")); return; }
    }
    if (form.sourceKind === "homeAssistant") {
      const okUrl = /^https:\/\//.test(form.haBaseUrl) || /^http:\/\/(127\.0\.0\.1|localhost)/.test(form.haBaseUrl);
      if (!okUrl || !/^[a-z_]+\.[a-z0-9_]+$/i.test(form.haEntityId)) { setError(t("schedule.validationHaFields")); return; }
    }

    setSaving(true);
    setError(null);
    const id = editing.id ?? newRuleId();
    const isNew = editing.id === null;
    const priority = Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.trunc(Number(form.priority) || 0)));
    const refreshMinutes = Math.min(REFRESH_MINUTES_MAX, Math.max(REFRESH_MINUTES_MIN, Math.trunc(Number(form.refreshMinutes) || REFRESH_MINUTES_DEFAULT)));

    if (form.sourceKind === "homeAssistant" && form.haTokenInput.trim()) {
      const stored = await storeHaToken(apiBase, id, form.haTokenInput.trim());
      if (!stored.ok) {
        setSaving(false);
        setError(stored.error);
        return;
      }
    }

    const source: ScheduleRule["source"] = form.sourceKind === "local"
      ? { kind: "local", values: valuesFromForm(form) }
      : form.sourceKind === "api"
        ? { kind: "api", url: form.apiUrl.trim(), refreshMinutes }
        : { kind: "homeAssistant", baseUrl: form.haBaseUrl.trim(), entityId: form.haEntityId.trim(), tokenRef: id, values: valuesFromForm(form), refreshMinutes };

    const rule: ScheduleRule = {
      id,
      createdAt: isNew ? Date.now() : (rules.find(r => r.id === id)?.createdAt ?? Date.now()),
      label,
      enabled: form.enabled,
      priority,
      days: form.daysMode === "everyday" ? "everyday" : form.customDays,
      ...(form.startDate ? { startDate: form.startDate } : {}),
      ...(form.endDate ? { endDate: form.endDate } : {}),
      ...(form.startTime ? { startTime: form.startTime } : {}),
      ...(form.endTime ? { endTime: form.endTime } : {}),
      source,
    };

    const next = isNew ? [...rules, rule] : rules.map(r => (r.id === id ? rule : r));
    drafts.setScheduleRules(next);
    recordRevision({
      scope: "settings",
      label: t("schedule.title"),
      summary: t("schedule.savedNotice") + " " + label,
      before: JSON.stringify(rules.find(r => r.id === id) ?? null),
    });
    notify({ tone: "success", title: t("schedule.savedNotice") });
    setSaving(false);
    setEditing(null);
  };

  const remove = async (rule: ScheduleRule) => {
    const confirmed = await confirm({
      title: t("schedule.deleteConfirmTitle", { label: rule.label }),
      body: t("schedule.deleteConfirmBody"),
      confirmLabel: t("schedule.delete"),
      tone: "danger",
    });
    if (!confirmed) return;
    if (rule.source.kind === "homeAssistant") void clearHaToken(apiBase, rule.source.tokenRef);
    drafts.setScheduleRules(rules.filter(r => r.id !== rule.id));
    recordRevision({ scope: "settings", label: t("schedule.title"), summary: t("schedule.deletedNotice") + " " + rule.label, before: JSON.stringify(rule) });
    notify({ tone: "success", title: t("schedule.deletedNotice") });
  };

  const densityOptions = [
    { value: UNSET, label: t("schedule.valueUnset") },
    ...[1, 2, 3, 4, 5].map(n => ({ value: String(n), label: String(n) })),
  ];
  const funnyOptions = [
    { value: UNSET, label: t("schedule.valueUnset") },
    ...[1, 2, 3, 4, 5].map(n => ({ value: String(n), label: String(n) })),
  ];
  const themeOptions = [
    { value: UNSET, label: t("schedule.valueUnset") },
    { value: "system", label: t("theme.system") },
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
  ];
  const localeOptions = [
    { value: UNSET, label: t("schedule.valueUnset") },
    ...LOCALES.map(l => ({ value: l.code, label: l.name })),
  ];
  const fontOptions = [
    { value: UNSET, label: t("schedule.valueUnset") },
    ...FONT_STACKS.map(f => ({ value: f.stack, label: f.family })),
  ];

  return (
    <>
      <p className="m3-page-lead">{t("schedule.subtitle")}</p>
      <div className="m3-stack">
      <Card title={t("schedule.title")} actions={<Button onClick={openCreate}><IconClock aria-hidden /> {t("schedule.addRule")}</Button>}>
        <p className="m3-field-hint">{t("schedule.timezoneNote", { tz, offset })}</p>
        <p className="m3-field-hint">{t("schedule.precedenceNote")}</p>
        {activeRule
          ? <Banner tone="info" title={t("schedule.activeBanner", { label: activeRule.label })} />
          : <Banner tone="info" title={t("schedule.noActiveOverride")} />}
      </Card>

      {rules.length === 0 && (
        <Empty title={t("schedule.emptyTitle")}>{t("schedule.emptyBody")}</Empty>
      )}

      {rules.map(rule => (
        <Card
          key={rule.id}
          title={rule.label}
          subtitle={ruleSummary(rule, t)}
          actions={(
            <>
              {rule.id === drafts.scheduleActiveRuleId && <Chip selected>{t("schedule.statusMatching")}</Chip>}
              <Toggle
                on={rule.enabled}
                label={t("schedule.enabled")}
                onChange={next => {
                  const updated = { ...rule, enabled: next };
                  drafts.setScheduleRules(rules.map(r => (r.id === rule.id ? updated : r)));
                  recordRevision({ scope: "settings", label: t("schedule.title"), summary: `${rule.label}: ${t(next ? "startup.enabled" : "startup.disabled")}`, before: JSON.stringify(rule) });
                }}
              />
              <Button variant="text" onClick={() => openEdit(rule)}>{t("common.edit")}</Button>
              <Button variant="danger" onClick={() => void remove(rule)}>{t("schedule.delete")}</Button>
            </>
          )}
        >
          <p className="m3-field-hint">
            {rule.source.kind === "local" && t("schedule.sourceLocal")}
            {rule.source.kind === "api" && `${t("schedule.sourceApi")} — ${rule.source.url}`}
            {rule.source.kind === "homeAssistant" && `${t("schedule.sourceHomeAssistant")} — ${rule.source.entityId}`}
            {" · "}{t("schedule.priority")}: {rule.priority}
          </p>
        </Card>
      ))}

      {editing && (
        <Dialog
          open
          onClose={close}
          title={editing.id ? editing.form.label || t("schedule.ruleLabel") : t("schedule.addRule")}
          width={640}
          actions={(
            <>
              <Button variant="text" onClick={close}>{t("common.cancel")}</Button>
              <Button onClick={() => void save()} disabled={saving}>{t("schedule.save")}</Button>
            </>
          )}
        >
          {error && <Banner tone="error" title={error} />}

          <Field label={t("schedule.ruleLabel")} id="schedule-label">
            <TextInput id="schedule-label" value={editing.form.label} placeholder={t("schedule.ruleLabelPlaceholder")}
              maxLength={LABEL_MAX} onChange={e => patch({ label: e.target.value })} />
          </Field>

          <Field label={t("schedule.priority")} hint={t("schedule.priorityHint")} id="schedule-priority">
            <TextInput id="schedule-priority" type="number" value={editing.form.priority}
              min={PRIORITY_MIN} max={PRIORITY_MAX} onChange={e => patch({ priority: e.target.value })} />
          </Field>

          <Field label={t("schedule.enabled")}>
            <Toggle on={editing.form.enabled} label={t("schedule.enabled")} onChange={enabled => patch({ enabled })} />
          </Field>

          <Field label={t("schedule.days")}>
            <Segmented
              value={editing.form.daysMode}
              label={t("schedule.days")}
              onChange={daysMode => patch({ daysMode })}
              options={[
                { value: "everyday", label: t("schedule.daysEveryday") },
                { value: "custom", label: t("schedule.days") },
              ]}
            />
            {editing.form.daysMode === "custom" && (
              <div className="m3-row" style={{ gap: 8, flexWrap: "wrap" }} role="group" aria-label={t("schedule.days")}>
                {ALL_WEEKDAYS.map(day => (
                  <Chip key={day} selected={editing.form.customDays.includes(day)} onClick={() => toggleCustomDay(day)}>
                    {t(WEEKDAY_KEYS[day])}
                  </Chip>
                ))}
              </div>
            )}
          </Field>

          <Field label={t("schedule.startDate")} id="schedule-start-date">
            <TextInput id="schedule-start-date" type="date" value={editing.form.startDate} onChange={e => patch({ startDate: e.target.value })} />
          </Field>
          <Field label={t("schedule.endDate")} id="schedule-end-date">
            <TextInput id="schedule-end-date" type="date" value={editing.form.endDate} onChange={e => patch({ endDate: e.target.value })} />
          </Field>
          <Field label={t("schedule.startTime")} id="schedule-start-time">
            <TextInput id="schedule-start-time" type="time" value={editing.form.startTime} onChange={e => patch({ startTime: e.target.value })} />
          </Field>
          <Field label={t("schedule.endTime")} hint={t("schedule.timeHint")} id="schedule-end-time">
            <TextInput id="schedule-end-time" type="time" value={editing.form.endTime} onChange={e => patch({ endTime: e.target.value })} />
          </Field>

          <Field label={t("schedule.source")}>
            <SelectField
              value={editing.form.sourceKind}
              onChange={value => patch({ sourceKind: value as ScheduleSourceKind })}
              options={[
                { value: "local", label: t("schedule.sourceLocal") },
                { value: "api", label: t("schedule.sourceApi") },
                { value: "homeAssistant", label: t("schedule.sourceHomeAssistant") },
              ]}
              label={t("schedule.source")}
            />
          </Field>

          {(editing.form.sourceKind === "local" || editing.form.sourceKind === "homeAssistant") && (
            <Card title={t("schedule.localValuesTitle")}>
              <Field label={t("theme.label")} id="schedule-theme">
                <SelectField id="schedule-theme" value={editing.form.theme} onChange={theme => patch({ theme })} options={themeOptions} label={t("theme.label")} />
              </Field>
              <Field label={t("appearance.seedTitle")} id="schedule-seed">
                <TextInput id="schedule-seed" value={editing.form.seed} placeholder="#2F6B4F" onChange={e => patch({ seed: e.target.value })} />
              </Field>
              <Field label={t("appearance.densityTitle")} id="schedule-density">
                <SelectField id="schedule-density" value={editing.form.density} onChange={density => patch({ density })} options={densityOptions} label={t("appearance.densityTitle")} />
              </Field>
              <Field label={t("appearance.fontFamily")} id="schedule-font">
                <SelectField id="schedule-font" value={editing.form.fontStack} onChange={fontStack => patch({ fontStack })} options={fontOptions} label={t("appearance.fontFamily")} />
              </Field>
              <Field label={t("appearance.fontScale")} id="schedule-font-scale">
                <TextInput id="schedule-font-scale" type="number" step="0.05" min={0.8} max={1.6} value={editing.form.fontScale} onChange={e => patch({ fontScale: e.target.value })} />
              </Field>
              <Field label={t("appearance.fontWeight")} id="schedule-font-weight">
                <TextInput id="schedule-font-weight" type="number" step="100" min={300} max={700} value={editing.form.fontWeight} onChange={e => patch({ fontWeight: e.target.value })} />
              </Field>
              <Field label={t("lang.label")} id="schedule-locale">
                <SelectField id="schedule-locale" value={editing.form.locale} onChange={locale => patch({ locale })} options={localeOptions} label={t("lang.label")} />
              </Field>
              <Field label={t("lang.funnyEn")} id="schedule-funny-en">
                <SelectField id="schedule-funny-en" value={editing.form.funnyEn} onChange={funnyEn => patch({ funnyEn })} options={funnyOptions} label={t("lang.funnyEn")} />
              </Field>
              <Field label={t("lang.funnyYue")} id="schedule-funny-yue">
                <SelectField id="schedule-funny-yue" value={editing.form.funnyYue} onChange={funnyYue => patch({ funnyYue })} options={funnyOptions} label={t("lang.funnyYue")} />
              </Field>
            </Card>
          )}

          {editing.form.sourceKind === "api" && (
            <>
              <Field label={t("schedule.apiUrl")} hint={t("schedule.apiUrlHint")} id="schedule-api-url">
                <TextInput id="schedule-api-url" value={editing.form.apiUrl} placeholder="https://example.com/opencodex-schedule.json" onChange={e => patch({ apiUrl: e.target.value })} />
              </Field>
              <Field label={t("schedule.refreshMinutes")} id="schedule-refresh-api">
                <TextInput id="schedule-refresh-api" type="number" min={REFRESH_MINUTES_MIN} max={REFRESH_MINUTES_MAX} value={editing.form.refreshMinutes} onChange={e => patch({ refreshMinutes: e.target.value })} />
              </Field>
            </>
          )}

          {editing.form.sourceKind === "homeAssistant" && (
            <>
              <Field label={t("schedule.haBaseUrl")} id="schedule-ha-url">
                <TextInput id="schedule-ha-url" value={editing.form.haBaseUrl} placeholder="https://homeassistant.local:8123" onChange={e => patch({ haBaseUrl: e.target.value })} />
              </Field>
              <Field label={t("schedule.haEntityId")} hint={t("schedule.haEntityIdHint")} id="schedule-ha-entity">
                <TextInput id="schedule-ha-entity" value={editing.form.haEntityId} placeholder="input_boolean.evening_mode" onChange={e => patch({ haEntityId: e.target.value })} />
              </Field>
              <Field label={t("schedule.refreshMinutes")} id="schedule-refresh-ha">
                <TextInput id="schedule-refresh-ha" type="number" min={REFRESH_MINUTES_MIN} max={REFRESH_MINUTES_MAX} value={editing.form.refreshMinutes} onChange={e => patch({ refreshMinutes: e.target.value })} />
              </Field>
              <Field label={t("schedule.haToken")} hint={t("schedule.haTokenHint")} id="schedule-ha-token">
                <TextInput id="schedule-ha-token" type="password" autoComplete="off" value={editing.form.haTokenInput}
                  placeholder={t("schedule.haTokenPlaceholder")} onChange={e => patch({ haTokenInput: e.target.value })} />
                <p className="m3-field-hint">{haConfigured ? t("schedule.haTokenConfigured") : t("schedule.haTokenMissing")}</p>
                {haConfigured && editing.id && (
                  <Button variant="text" onClick={() => {
                    void clearHaToken(apiBase, editing.id!).then(() => setHaConfigured(false));
                  }}>{t("schedule.haTokenClear")}</Button>
                )}
              </Field>
            </>
          )}
        </Dialog>
      )}
      </div>
    </>
  );
}
