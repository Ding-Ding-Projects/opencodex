import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "../ui";
import { useI18n, LOCALES } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import {
  externalModelId,
  type ExternalModelRow,
} from "../api-access-models";
import { compileBoundedRegex, type RegexSearchState } from "../regex-search";
import {
  DEFAULT_ENDPOINTS,
  deriveApiEndpoints,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type CopilotDesktopProfile,
  type ModelTestState,
} from "./api-keys-utils";
import {
  ApiKeysAuthPanel,
  ApiKeysCopilotPanel,
  ApiKeysEndpointsPanel,
  ApiKeysManagePanel,
  ApiKeysModelsPanel,
  ApiKeysUsagePanel,
} from "./api-keys-panels";

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
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [copilotProfile, setCopilotProfile] = useState<CopilotDesktopProfile | null>(null);
  const [copilotLoadFailed, setCopilotLoadFailed] = useState(false);
  const [endpoints, setEndpoints] = useState<ApiEndpointInfo>(DEFAULT_ENDPOINTS);
  const [claudeCodeEnabled, setClaudeCodeEnabled] = useState(true);
  const [keysLoadFailed, setKeysLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [models, setModels] = useState<ExternalModelRow[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelRegex, setModelRegex] = useState<RegexSearchState>({ enabled: false, pattern: "", flags: "i" });
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<Record<string, { state: ModelTestState; detail?: string }>>({});
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const creatingRef = useRef(false);

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

  const fetchCopilotProfile = useCallback(async () => {
    setModelsLoading(true);
    setModelsLoadFailed(false);
    try {
      const res = await fetch(`${apiBase}/api/copilot-desktop`);
      const profile = await readJsonIfOk<CopilotDesktopProfile>(res);
      if (!profile || !Array.isArray(profile.models)) {
        setCopilotLoadFailed(true);
        setModelsLoadFailed(true);
        return;
      }
      setCopilotProfile(profile);
      setCopilotLoadFailed(false);
      setModels(profile.models.map(model => ({
        id: model.id,
        displayName: model.id,
        provider: model.provider,
        native: model.provider === "openai" && !model.id.includes("/"),
        custom: model.provider !== "openai" && model.provider !== "combo",
        copilot: {
          ready: model.ready,
          reason: model.reason,
          adapter: model.adapter,
          capabilities: model.capabilities,
          sidecars: model.sidecars,
          directModeExcluded: model.directModeExcluded,
        },
      })).sort((a, b) => externalModelId(a).localeCompare(externalModelId(b))));
    } catch {
      setCopilotLoadFailed(true);
      setModelsLoadFailed(true);
    } finally {
      setModelsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchKeys();
      void fetchCopilotProfile();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchCopilotProfile, fetchKeys]);

  const filteredModels = useMemo(() => {
    const regex = compileBoundedRegex(modelRegex);
    const query = modelQuery.trim().toLowerCase();
    if (modelRegex.enabled && !regex) return [];
    if (!modelRegex.enabled && !query) return models;
    return models.filter(model => {
      const searchable = [
        externalModelId(model),
        model.displayName,
        model.provider,
        model.copilot?.reason ?? "",
        model.copilot?.adapter ?? "",
        ...Object.entries(model.copilot?.capabilities ?? {}).map(([name, value]) => `${name} ${value}`),
      ].join(" ");
      return regex ? regex.test(searchable) : searchable.toLowerCase().includes(query);
    });
  }, [modelQuery, modelRegex, models]);

  const handleCreate = async (name?: string, purpose?: ApiKeyEntry["purpose"]): Promise<boolean> => {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    try {
      const effectiveName = name ?? newName;
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: effectiveName || "default", ...(purpose ? { purpose } : {}) }),
      });
      const data = await readJsonOrThrow<CreateKeyResponse>(res, t("api.createFailed"));
      if (typeof data?.key !== "string" || data.key.length === 0) {
        setActionError(t("api.createFailed"));
        return false;
      }
      setNewKey(data.key);
      setNewName("");
      void fetchKeys();
      if (purpose === "github-copilot-desktop") void fetchCopilotProfile();
      return true;
    } catch {
      setActionError(t("api.createFailed"));
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setActionError(null);
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
      setConfirmDelete(null);
      void fetchKeys();
    } catch {
      setActionError(t("api.deleteFailed"));
    }
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedModelId(modelId);
      window.setTimeout(() => setCopiedModelId(current => (current === modelId ? null : current)), 2000);
    } catch {
      /* clipboard unavailable */
    }
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
    <section className="api-page">
      <div className="page-head">
        <h2>{t("api.title")}</h2>
      </div>
      <p className="page-sub">
        {subtitleParts[0]}
        <code>Authorization: Bearer ocx_...</code>
        {subtitleParts[1]}
        <code>x-opencodex-api-key</code>
        {subtitleParts[2]}
      </p>

      {(keysLoadFailed || actionError) && (
        <Notice tone="err">{actionError ?? t("api.keysLoadFailed")}</Notice>
      )}

      <ApiKeysCopilotPanel
        profile={copilotProfile}
        profileLoadFailed={copilotLoadFailed}
        integrationKey={keys.find(key => key.purpose === "github-copilot-desktop") ?? null}
        creating={creating}
        newKeyVisible={newKey !== null}
        localeTag={localeTag}
        onGenerate={() => { void handleCreate(t("api.copilotKeyName"), "github-copilot-desktop"); }}
        onManage={() => document.getElementById("api-active-keys")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      />
      <ApiKeysEndpointsPanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
      <ApiKeysAuthPanel claudeCodeEnabled={claudeCodeEnabled} />
      <ApiKeysManagePanel
        keys={keys}
        keysLoadFailed={keysLoadFailed}
        newName={newName}
        creating={creating}
        newKey={newKey}
        copied={copied}
        confirmDelete={confirmDelete}
        localeTag={localeTag}
        onNewNameChange={setNewName}
        onCreate={() => { void handleCreate(); }}
        onDismissNewKey={() => setNewKey(null)}
        onCopyKey={copyKey}
        onConfirmDelete={setConfirmDelete}
        onCancelDelete={() => setConfirmDelete(null)}
        onDelete={(id) => { void handleDelete(id); }}
      />
      <ApiKeysModelsPanel
        filteredModels={filteredModels}
        modelsLoading={modelsLoading}
        modelsLoadFailed={modelsLoadFailed}
        modelQuery={modelQuery}
        modelRegex={modelRegex}
        copiedModelId={copiedModelId}
        modelTests={modelTests}
        claudeCodeEnabled={claudeCodeEnabled}
        onModelQueryChange={(value) => {
          setModelQuery(value);
          setModelRegex(current => ({ ...current, pattern: value }));
        }}
        onModelRegexChange={(next) => {
          setModelRegex(next);
          setModelQuery(next.pattern);
        }}
        onCopyModelId={(modelId) => { void copyModelId(modelId); }}
        onTestModel={(model) => { void testModel(model); }}
        sourceLabel={sourceLabel}
        protocolLabel={protocolLabel}
      />
      <ApiKeysUsagePanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
    </section>
  );
}
