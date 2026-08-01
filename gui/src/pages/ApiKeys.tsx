import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BulkBar from "../shell/BulkBar";
import {
  invert as invertSelection, selectAll as selectAllIds, selectRange, toggle as toggleSelection,
} from "../shell/bulk-selection";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { copyTextToClipboard } from "../oauth-health-display";
import { useI18n, LOCALES } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { useConfirm } from "../shell/confirm-context";
import { recordRevision } from "../shell/revisions";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import {
  classifyExternalModel,
  externalModelId,
  type ExternalModelRow,
} from "../api-access-models";
import {
  DEFAULT_ENDPOINTS,
  deriveApiEndpoints,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTestState,
} from "./api-keys-utils";
import {
  ApiKeysAuthPanel,
  ApiKeysEndpointsPanel,
  ApiKeysManagePanel,
  ApiKeysModelsPanel,
  ApiKeysUsagePanel,
} from "./api-keys-panels";

/** The two header names the subtitle names inline, as M3 code chips. */
const INLINE_CODE = {
  padding: "1px 6px",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-highest)",
  color: "var(--m3-on-surface)",
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
} as const;

interface KeysResponse {
  keys?: ApiKeyEntry[];
  endpoint?: string;
  baseUrl?: string;
  responsesEndpoint?: string;
  chatCompletionsEndpoint?: string;
  messagesEndpoint?: string;
  modelsEndpoint?: string;
  claudeCodeEnabled?: boolean;
}

interface CreateKeyResponse {
  key?: unknown;
}

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const { notify } = useNotifications();
  /* Shadows the global `confirm` deliberately, as the other pages here do — and
     the shadowing is the point. Without this import, `confirm({ title, ... })`
     silently resolved to the DOM's `confirm(message: string)`, which accepts one
     string, ignores an object, and returns immediately. A destructive bulk
     action would have run with no dialog at all. */
  const confirm = useConfirm();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [endpoints, setEndpoints] = useState<ApiEndpointInfo>(DEFAULT_ENDPOINTS);
  const [claudeCodeEnabled, setClaudeCodeEnabled] = useState(true);
  const [keysLoadFailed, setKeysLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [models, setModels] = useState<ExternalModelRow[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [modelTests, setModelTests] = useState<Record<string, { state: ModelTestState; detail?: string }>>({});
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /* Bulk selection. Held here rather than in the panel so the bar and the rows
     read the same set — two copies of a selection is how a bar comes to say 5
     while 4 rows are ticked. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelBulk = useRef(false);
  const lastTouched = useRef<string | null>(null);
  const creatingRef = useRef(false);
  // One copy protocol for the reveal-once key and every model ID; the scope is
  // the copied text itself, so a second click reads as idle on the first target.
  const { outcomeFor: copyOutcomeFor, copy } = useCopyFeedback<string>();

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`);
      const data = await readJsonIfOk<KeysResponse>(res);
      if (!data) {
        // Keep last-good keys/endpoints/Claude setting; only mark the refresh failed.
        setKeysLoadFailed(true);
        return;
      }
      const derived = deriveApiEndpoints(data.endpoint ?? "");
      setKeys(data.keys ?? []);
      setEndpoints({
        baseUrl: data.baseUrl ?? derived.baseUrl,
        responses: data.responsesEndpoint ?? data.endpoint ?? DEFAULT_ENDPOINTS.responses,
        chatCompletions: data.chatCompletionsEndpoint ?? derived.chatCompletions,
        messages: data.messagesEndpoint ?? derived.messages,
        models: data.modelsEndpoint ?? derived.models,
      });
      setClaudeCodeEnabled(data.claudeCodeEnabled !== false);
      setKeysLoadFailed(false);
    } catch {
      setKeysLoadFailed(true);
    }
  }, [apiBase]);

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsLoadFailed(false);
    try {
      const res = await fetch(`${apiBase}/v1/models`);
      if (!res.ok) {
        setModels([]);
        setModelsLoadFailed(true);
        return;
      }
      const data = await res.json() as unknown;
      const rawRows = Array.isArray(data)
        ? data
        : (typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
          ? (data as { data: unknown[] }).data
          : null);
      if (!rawRows) {
        setModels([]);
        setModelsLoadFailed(true);
        return;
      }
      const rows = rawRows
        .filter((row): row is { id: string; owned_by?: string } => (
          typeof row === "object"
          && row !== null
          && typeof (row as { id?: unknown }).id === "string"
        ))
        .map(row => classifyExternalModel(row))
        .sort((a, b) => externalModelId(a).localeCompare(externalModelId(b)));
      setModels(rows);
    } catch {
      setModels([]);
      setModelsLoadFailed(true);
    } finally {
      setModelsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchKeys();
      void fetchModels();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeys, fetchModels]);

  /**
   * Catalog search: plain text by default, `.*` as an explicit opt-in. The
   * pattern is capped at 400 characters and evaluated locally with no `g` flag,
   * so a pasted novel can never become a catastrophic-backtracking payload and
   * no lastIndex state leaks between rows.
   */
  const { filteredModels, modelQueryError } = useMemo(() => {
    const query = modelQuery.trim();
    if (!query) return { filteredModels: models, modelQueryError: null as string | null };
    const fields = (model: ExternalModelRow) => [externalModelId(model), model.displayName, model.provider];
    if (useRegex) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(query.slice(0, 400), "i");
      } catch (error) {
        return {
          filteredModels: [] as ExternalModelRow[],
          modelQueryError: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        filteredModels: models.filter(model => fields(model).some(field => pattern.test(field))),
        modelQueryError: null as string | null,
      };
    }
    const needle = query.toLowerCase();
    return {
      filteredModels: models.filter(model => fields(model).some(field => field.toLowerCase().includes(needle))),
      modelQueryError: null as string | null,
    };
  }, [modelQuery, models, useRegex]);

  const handleCreate = async (name?: string): Promise<boolean> => {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    try {
      const effectiveName = name ?? newName;
      const keyLabel = effectiveName || "default";
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyLabel }),
      });
      const data = await readJsonOrThrow<CreateKeyResponse>(res, t("api.createFailed"));
      if (typeof data?.key !== "string" || data.key.length === 0) {
        setActionError(t("api.createFailed"));
        return false;
      }
      setNewKey(data.key);
      setNewName("");
      // The secret itself is never recorded — a revision log is not a key store.
      // Past tense, because a revision records what happened, not what a card says.
      recordRevision({ scope: "key", label: keyLabel, summary: t("api.keyCreated") });
      notify({ tone: "success", title: t("api.keyCreated"), body: keyLabel });
      void fetchKeys();
      return true;
    } catch {
      setActionError(t("api.createFailed"));
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };


  /* Shift-click extends from the last row touched. Adds rather than replaces, so
     a second range keeps the first — what every file manager does. The rules
     live in `shell/bulk-selection` so this list and the Combos rail cannot drift
     into two different ideas of what a shift-click means. */
  const toggleSelect = useCallback((id: string, shiftKey: boolean) => {
    const order = keys.map(k => k.id);
    setSelected(current => (shiftKey && lastTouched.current
      ? selectRange(current, order, lastTouched.current, id)
      : toggleSelection(current, id)));
    lastTouched.current = id;
  }, [keys]);

  /**
   * Revoke every selected key, one at a time, reporting what actually happened.
   *
   * Sequential rather than parallel: each delete writes the config, and the
   * revision history is meant to read as a list of decisions rather than a race.
   * The count in the confirmation is the count that will be attempted — there is
   * nothing to exclude here, since any key the user can see, they can revoke.
   */
  const bulkRevoke = useCallback(async (ids: string[]) => {
    const ok = await confirm({
      title: t("bulk.deleteKeys"),
      body: t("bulk.confirmDeleteKeys", { count: ids.length }),
      confirmLabel: t("bulk.deleteKeys"),
      tone: "danger",
    });
    if (!ok) return;

    cancelBulk.current = false;
    setBulkProgress({ done: 0, total: ids.length });
    let succeeded = 0;
    let failed = 0;
    for (const [index, id] of ids.entries()) {
      if (cancelBulk.current) break;
      try {
        const res = await fetch(`${apiBase}/api/keys`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (res.ok) succeeded += 1; else failed += 1;
      } catch { failed += 1; }
      setBulkProgress({ done: index + 1, total: ids.length });
    }
    setBulkProgress(null);
    setSelected(new Set());
    await fetchKeys();

    // Never "Done" when it was not. A run that failed at item thirty did
    // twenty-nine things, and saying otherwise is false in the direction that
    // costs the most to discover later.
    const remaining = ids.length - succeeded - failed;
    if (cancelBulk.current && remaining > 0) {
      notify({ tone: "warn", title: t("bulk.deleteKeys"), body: t("bulk.cancelled", { action: t("bulk.deleteKeys"), succeeded, remaining }) });
    } else if (failed) {
      notify({ tone: "error", title: t("bulk.deleteKeys"), body: t("bulk.doneSome", { action: t("bulk.deleteKeys"), succeeded, failed }) });
    } else {
      notify({ tone: "warn", title: t("bulk.deleteKeys"), body: t("bulk.doneAll", { action: t("bulk.deleteKeys"), succeeded }) });
    }
  }, [apiBase, confirm, fetchKeys, notify, t]);

  const handleDelete = async (id: string) => {
    setActionError(null);
    const deleted = keys.find(k => k.id === id);
    // Closed either way: the failure banner sits on the page, and a still-open
    // modal would cover the only sentence explaining why the key is still there.
    setConfirmDelete(null);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setActionError(t("api.deleteFailed"));
        return;
      }
      // The prefix is the only handle left once the row is gone; keeping it makes
      // the history entry identifiable without storing the secret.
      recordRevision({
        scope: "key",
        label: deleted?.name ?? id,
        summary: t("api.keyDeleted"),
        before: deleted ? JSON.stringify({ name: deleted.name, prefix: deleted.prefix }) : undefined,
      });
      // The row vanishing is not an acknowledgement; the snackbar says what went.
      notify({ tone: "warn", title: t("api.keyDeleted"), body: deleted?.name ?? id });
      void fetchKeys();
    } catch {
      setActionError(t("api.deleteFailed"));
    }
  };

  const copyKey = () => {
    if (newKey) copy(newKey, newKey);
  };

  const copyModelId = (modelId: string) => {
    copy(modelId, modelId);
  };

  // Icon-only copy buttons have no label to flip, so their acknowledgement is a
  // snackbar rather than the inline `useCopyFeedback` swap the text buttons use.
  const copyToClipboard = (value: string) => {
    void copyTextToClipboard(value).then(ok => {
      if (ok) notify({ tone: "success", title: t("api.copied"), body: value });
      else notify({ tone: "error", title: t("prov.linkCopyUnavailable") });
    });
  };

  const sourceLabel = (model: ExternalModelRow): string => {
    if (model.native) return t("api.sourceNative");
    if (model.provider === "combo") return t("api.sourceCombo");
    if (model.custom) return t("api.sourceCustom");
    return model.provider;
  };

  const protocolLabel = (protocol: string): string => {
    if (protocol === "responses") return t("api.protocolResponses");
    if (protocol === "messages") return t("api.protocolMessages");
    return t("api.protocolChatCompletions");
  };

  const testModel = async (model: ExternalModelRow) => {
    const modelId = externalModelId(model);
    setModelTests(current => ({ ...current, [modelId]: { state: "testing" } }));
    try {
      const res = await fetch(endpoints.chatCompletions, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        setModelTests(current => ({
          ...current,
          [modelId]: { state: "error", detail: detail.slice(0, 160) || String(res.status) },
        }));
        return;
      }
      setModelTests(current => ({ ...current, [modelId]: { state: "ok" } }));
    } catch (error) {
      setModelTests(current => ({
        ...current,
        [modelId]: { state: "error", detail: error instanceof Error ? error.message : t("api.testFailed") },
      }));
    }
  };

  // Subtitle carries two inline <code> chips; split the localized string on both tokens.
  const subtitleParts = t("api.subtitle").split(/\{authHeader\}|\{altHeader\}/);

  return (
    <>
      {/* The app bar carries the page title; the screen opens on its subtitle. */}
      <p className="m3-page-lead" style={{ marginBottom: "var(--sp-4)" }}>
        {subtitleParts[0]}
        <code style={INLINE_CODE}>Authorization: Bearer ocx_...</code>
        {subtitleParts[1]}
        <code style={INLINE_CODE}>x-opencodex-api-key</code>
        {subtitleParts[2]}
      </p>

      {/* Load and mutation failures stay on the page: a snackbar that auto-hides
          would leave a stale key list looking authoritative. */}
      {(keysLoadFailed || actionError) && (
        <p className="dash-notice" role="alert" style={{ margin: "0 0 var(--sp-4)" }}>
          {actionError ?? t("api.keysLoadFailed")}
        </p>
      )}

      <ApiKeysEndpointsPanel
        endpoints={endpoints}
        claudeCodeEnabled={claudeCodeEnabled}
        onCopy={copyToClipboard}
      />
      <ApiKeysAuthPanel claudeCodeEnabled={claudeCodeEnabled} />
      <ApiKeysManagePanel
        selected={selected}
        onToggleSelect={toggleSelect}
        bulkBar={(
          <BulkBar
            items={keys.map(k => ({ id: k.id, label: k.name }))}
            selected={selected}
            /* "all" and not "page": this table is not paginated and carries no
               filter, so every key the user can see is every key there is. */
            scope="all"
            onSelectAll={() => setSelected(selectAllIds(keys.map(k => k.id)))}
            onSelectNone={() => setSelected(new Set())}
            onInvert={() => setSelected(current => invertSelection(current, keys.map(k => k.id)))}
            progress={bulkProgress ? { ...bulkProgress, onCancel: () => { cancelBulk.current = true; } } : null}
            actions={[{ id: "revoke", label: t("bulk.deleteKeys"), destructive: true, run: ids => void bulkRevoke(ids) }]}
          />
        )}
        keys={keys}
        keysLoadFailed={keysLoadFailed}
        newName={newName}
        creating={creating}
        newKey={newKey}
        copyOutcome={newKey ? copyOutcomeFor(newKey) : null}
        confirmDelete={confirmDelete}
        localeTag={localeTag}
        onNewNameChange={setNewName}
        onCreate={() => { void handleCreate(); }}
        onDismissNewKey={() => setNewKey(null)}
        onCopyKey={copyKey}
        onCopyPrefix={copyToClipboard}
        onConfirmDelete={setConfirmDelete}
        onCancelDelete={() => setConfirmDelete(null)}
        onDelete={(id) => { void handleDelete(id); }}
      />
      <ApiKeysModelsPanel
        filteredModels={filteredModels}
        modelsLoading={modelsLoading}
        modelsLoadFailed={modelsLoadFailed}
        modelQuery={modelQuery}
        modelQueryError={modelQueryError}
        useRegex={useRegex}
        copyOutcomeFor={copyOutcomeFor}
        modelTests={modelTests}
        claudeCodeEnabled={claudeCodeEnabled}
        onModelQueryChange={setModelQuery}
        onUseRegexChange={setUseRegex}
        onCopyModelId={copyModelId}
        onTestModel={(model) => { void testModel(model); }}
        sourceLabel={sourceLabel}
        protocolLabel={protocolLabel}
      />
      <ApiKeysUsagePanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
    </>
  );
}
