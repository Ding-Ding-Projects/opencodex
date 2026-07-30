import { useCallback, useEffect, useMemo, useState } from "react";
import ComboWorkspace from "../components/ComboWorkspace";
import {
  type ComboItem,
  comboModelId,
  groupCombos,
  parseComboList,
  toPutBody,
} from "../combo-workspace-data";
import { hideRedundantChatGptForwardProviders } from "../provider-workspace/catalog";
import { useNotifications } from "../shell/notifications-context";
import { recordRevision } from "../shell/revisions";
import { useT } from "../i18n/shared";

type ProviderOption = {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};
type ModelOption = { provider: string; id: string; namespaced?: string; reasoningEfforts?: string[] };
type ProviderDto = {
  adapter: string;
  baseUrl: string;
  disabled?: boolean;
  defaultModel?: string;
  authMode?: string;
};
type ConfigDto = { providers?: Record<string, ProviderDto> };

function responseError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

function responseSucceeded(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as { success?: unknown }).success === true;
}

export default function Combos({ apiBase }: { apiBase: string }) {
  const t = useT();
  // Load/save/remove outcomes are informational, so they are snackbars rather
  // than a banner that pushes the workspace down; only the remove decision is
  // still blocking, and that dialog lives in ComboWorkspace.
  const { notify } = useNotifications();
  const [combos, setCombos] = useState<ComboItem[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [cataloguedComboIds, setCataloguedComboIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const sections = useMemo(() => groupCombos(combos), [combos]);

  const fetchAll = useCallback(async () => {
    try {
      const [combosRes, configRes, modelsRes] = await Promise.all([
        fetch(`${apiBase}/api/combos`),
        fetch(`${apiBase}/api/config`),
        fetch(`${apiBase}/api/models`),
      ]);
      if (!combosRes.ok || !configRes.ok || !modelsRes.ok) {
        throw new Error("combo workspace load failed");
      }
      const combosJson = await combosRes.json();
      const configJson = await configRes.json() as ConfigDto;
      // /api/models returns a bare array (not { models: [...] }).
      const modelsRaw = await modelsRes.json() as unknown;
      const modelRows = Array.isArray(modelsRaw)
        ? modelsRaw
        : Array.isArray((modelsRaw as { models?: unknown })?.models)
          ? (modelsRaw as { models: unknown[] }).models
          : [];

      setCombos(parseComboList(combosJson));

      const allProviders = configJson.providers ?? {};
      // Collapse canonical forward aliases only in the new-member picker. Validation keeps
      // every configured provider id, including legacy chatgpt members already in a combo.
      const visibleProviders = hideRedundantChatGptForwardProviders(allProviders);
      setProviders(
        Object.entries(allProviders).map(([name, p]) => ({
          name,
          disabled: !!p.disabled,
          hiddenFromPicker: !Object.hasOwn(visibleProviders, name),
          authMode: p.authMode,
          adapter: p.adapter,
          baseUrl: p.baseUrl,
        })),
      );

      const fromApi: ModelOption[] = [];
      const catalogued = new Set<string>();
      for (const row of modelRows) {
        if (!row || typeof row !== "object") continue;
        const m = row as {
          provider?: unknown;
          id?: unknown;
          namespaced?: unknown;
          disabled?: unknown;
          reasoningEfforts?: unknown;
        };
        if (typeof m.provider !== "string" || typeof m.id !== "string") continue;
        const provider = m.provider.trim();
        const id = m.id.trim();
        if (!provider || !id) continue;
        if (provider === "combo") {
          catalogued.add(id);
          continue; // combos cannot nest other combos as targets
        }
        if (m.disabled === true) continue;
        const reasoningEfforts = Array.isArray(m.reasoningEfforts)
          ? m.reasoningEfforts.filter((effort): effort is string => typeof effort === "string")
          : undefined;
        fromApi.push({
          provider,
          id,
          namespaced: typeof m.namespaced === "string" ? m.namespaced : undefined,
          ...(reasoningEfforts ? { reasoningEfforts } : {}),
        });
      }
      setCataloguedComboIds(catalogued);

      // Ensure each provider's defaultModel appears even if catalog fetch lagged.
      for (const [name, p] of Object.entries(configJson.providers ?? {})) {
        const dm = typeof p.defaultModel === "string" ? p.defaultModel.trim() : "";
        if (!dm || p.disabled) continue;
        if (!fromApi.some((m) => m.provider === name && m.id === dm)) {
          fromApi.push({ provider: name, id: dm, namespaced: `${name}/${dm}` });
        }
      }

      setModels(fromApi);
    } catch {
      notify({ tone: "error", title: t("cws.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [apiBase, notify, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAll]);

  const saveCombo = async (item: ComboItem, isCreate: boolean, renameFrom?: string) => {
    // Captured before the refetch: a rename retires the old id, so this is the
    // only moment the pre-edit record is still reachable for the revision log.
    const before = combos.find((c) => c.id === (renameFrom ?? item.id));
    try {
      const res = await fetch(`${apiBase}/api/combos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPutBody(item, renameFrom ? { renameFrom } : {})),
      });
      const data = res.ok
        ? await res.json() as unknown
        : await res.json().catch(() => null) as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.saveFailed");
        notify({ tone: "error", title: err });
        return { ok: false as const, error: err };
      }
      await fetchAll();
      const summary = renameFrom
        ? t("cws.renamed", { from: comboModelId(renameFrom), to: item.model })
        : isCreate ? t("cws.created", { model: item.model }) : t("cws.saved");
      recordRevision({
        scope: "combo",
        label: item.model,
        summary,
        ...(before ? { before: JSON.stringify(before) } : {}),
      });
      notify({ tone: "success", title: summary });
      return { ok: true as const };
    } catch {
      const err = t("cws.saveFailed");
      notify({ tone: "error", title: err });
      return { ok: false as const, error: err };
    }
  };

  const removeCombo = async (id: string) => {
    const before = combos.find((c) => c.id === id);
    try {
      const res = await fetch(`${apiBase}/api/combos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = res.ok
        ? await res.json() as unknown
        : await res.json().catch(() => null) as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.removeFailed");
        notify({ tone: "error", title: err });
        return { ok: false as const, error: err };
      }
      await fetchAll();
      const summary = t("cws.removed", { id });
      // Without `before` the deletion could not be undone from Version history.
      recordRevision({
        scope: "combo",
        label: before?.model ?? comboModelId(id),
        summary,
        ...(before ? { before: JSON.stringify(before) } : {}),
      });
      notify({ tone: "success", title: summary });
      return { ok: true as const };
    } catch {
      const err = t("cws.removeFailed");
      notify({ tone: "error", title: err });
      return { ok: false as const, error: err };
    }
  };

  if (loading && combos.length === 0) {
    return (
      <div className="combos-workspace-shell">
        <div className="m3-empty" role="status">{t("cws.loading")}</div>
      </div>
    );
  }

  return (
    <div className="combos-workspace-shell">
      {/* The prototype leads the Combos screen with the blurb and the three-count
          strip ABOVE the rail/detail split, so both stay visible while a combo is
          selected. They used to live inside OverviewPanel, which only renders when
          nothing is selected — hence they vanished the moment you opened a combo. */}
      <div className="combos-workspace-shell-banner">
        <p className="m3-page-lead">{t("cws.overviewBlurb")}</p>
        <div className="cwi-count-strip">
          <div className="cwi-count-pill">
            <strong>{combos.length}</strong><span>{t("cws.count.total")}</span>
          </div>
          <div className="cwi-count-pill">
            <strong>{sections.failover.length}</strong><span>{t("cws.count.failover")}</span>
          </div>
          <div className="cwi-count-pill">
            <strong>{sections.roundRobin.length}</strong><span>{t("cws.count.roundRobin")}</span>
          </div>
        </div>
      </div>
      <div className="combos-workspace-shell-body">
        <ComboWorkspace
          combos={combos}
          providers={providers}
          models={models}
          cataloguedComboIds={cataloguedComboIds}
          loading={loading}
          onRefresh={() => { void fetchAll(); }}
          onSave={saveCombo}
          onRemove={removeCombo}
          onAdd={() => setAdding(true)}
          adding={adding}
          onCloseAdd={() => setAdding(false)}
          onCreated={() => { void fetchAll(); }}
        />
      </div>
    </div>
  );
}
