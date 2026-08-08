import { IconCheck, IconPlus, IconX } from "../icons";
import { RegexBuilderButton } from "../components/RegexBuilderButton";
import type { RegexSearchState } from "../regex-search";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { useI18n } from "../i18n/shared";
import {
  externalModelId,
  gatewayInboundProtocols,
  type ExternalModelRow,
} from "../api-access-models";
import {
  formatCreatedDate,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type CopilotDesktopProfile,
  type ModelTestState,
} from "./api-keys-utils";

export function ApiKeysCopilotPanel({
  profile,
  profileLoadFailed,
  integrationKey,
  creating,
  newKeyVisible,
  localeTag,
  onGenerate,
  onManage,
}: {
  profile: CopilotDesktopProfile | null;
  profileLoadFailed: boolean;
  integrationKey: ApiKeyEntry | null;
  creating: boolean;
  newKeyVisible: boolean;
  localeTag?: string;
  onGenerate: () => void;
  onManage: () => void;
}) {
  const { t } = useI18n();
  const endpointCopy = useCopyFeedback<string>();
  const baseUrl = profile?.baseUrl ?? "http://127.0.0.1:10100/v1";
  const modelsEndpoint = profile?.modelsEndpoint ?? `${baseUrl}/models`;
  const chatEndpoint = profile?.chatCompletionsEndpoint ?? `${baseUrl}/chat/completions`;
  const last = profile?.lastRequest;
  const observedAt = last ? new Date(last.at).toLocaleString(localeTag) : null;
  const readyCount = profile?.models.filter(model => model.ready).length ?? 0;
  const status = last
    ? t("api.copilotStatusObserved", { status: last.status, time: observedAt ?? last.at })
    : integrationKey
      ? t("api.copilotStatusWaiting")
      : t("api.copilotStatusReady");
  const copyLabel = (value: string) => {
    const outcome = endpointCopy.outcomeFor(value);
    return outcome === "copied" ? t("api.copied") : outcome === "unavailable" ? t("api.copyUnavailable") : t("api.copy");
  };

  return (
    <section className="panel api-panel api-copilot-panel" aria-labelledby="api-copilot-title" aria-busy={!profile && !profileLoadFailed}>
      <div className="api-panel-head">
        <div>
          <p className="api-copilot-eyebrow">{t("api.copilotEyebrow")}</p>
          <h3 id="api-copilot-title" className="panel-title">{t("api.copilotTitle")}</h3>
        </div>
        <span className={`api-readiness-badge${profileLoadFailed ? " api-readiness-badge--error" : ""}`} role="status" aria-live="polite">
          {profileLoadFailed ? t("api.copilotStatusUnavailable") : status}
        </span>
      </div>
      <p className="muted small">{t("api.copilotSubtitle")}</p>
      <p className="muted small">{t("api.copilotVerifiedClient")}</p>
      <p className="api-copilot-note">{t("api.copilotInboundDistinction")}</p>
      <ol className="api-copilot-rail">
        <li>
          <div><span>{t("api.copilotBaseUrl")}</span><code>{baseUrl}</code></div>
          <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.copilotCopyBaseUrl")} onClick={() => endpointCopy.copy(baseUrl, baseUrl)}><span aria-live="polite">{copyLabel(baseUrl)}</span></button>
        </li>
        <li>
          <div><span>{t("api.copilotWireApi")}</span><code>completions</code></div>
        </li>
        <li>
          <div><span>{t("api.copilotModelsEndpoint")}</span><code>{modelsEndpoint}</code></div>
          <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.copilotCopyModelsEndpoint")} onClick={() => endpointCopy.copy(modelsEndpoint, modelsEndpoint)}><span aria-live="polite">{copyLabel(modelsEndpoint)}</span></button>
        </li>
        <li>
          <div><span>{t("api.copilotChatEndpoint")}</span><code>{chatEndpoint}</code></div>
          <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.copilotCopyChatEndpoint")} onClick={() => endpointCopy.copy(chatEndpoint, chatEndpoint)}><span aria-live="polite">{copyLabel(chatEndpoint)}</span></button>
        </li>
      </ol>
      <p className="api-copilot-note">{t("api.copilotOptionalKey")}</p>
      <p className="muted small">{t("api.copilotCustomHeaders")}</p>
      <div className="api-copilot-actions">
        {integrationKey ? (
          <button type="button" className="btn btn-ghost" onClick={onManage}>{t("api.copilotManageKey")}</button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onGenerate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.copilotGenerateKey")}
          </button>
        )}
        {integrationKey && <code className="api-key-prefix">{integrationKey.prefix}</code>}
        {newKeyVisible && <span className="muted small" role="status">{t("api.copilotRevealAbove")}</span>}
      </div>
      <div className="api-copilot-summary" role="status" aria-live="polite">
        <span>{t("api.copilotReadyModels", { count: readyCount })}</span>
        <span>{t("api.copilotProviderCount", { count: profile?.providers.length ?? 0 })}</span>
      </div>
      <div className="api-copilot-warning" role="note">
        <strong>{t("api.copilotDirectTitle")}</strong>
        <span>{t("api.copilotDirectWarning")}</span>
      </div>
      <p className="muted small">{t("api.copilotSidecars")}</p>
    </section>
  );
}

export function ApiKeysEndpointsPanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel">
      <h3 className="panel-title">{t("api.endpointsTitle")}</h3>
      <div className="api-endpoints">
        <div>
          <span className="muted small">{t("api.baseUrl")}</span>
          <code className="api-code api-code-inline">{endpoints.baseUrl}</code>
        </div>
        <div>
          <span className="muted small">{t("api.responsesEndpoint")}</span>
          <code className="api-code api-code-inline">{endpoints.responses}</code>
        </div>
        <div>
          <span className="muted small">{t("api.chatCompletionsEndpoint")}</span>
          <code className="api-code api-code-inline">{endpoints.chatCompletions}</code>
        </div>
        {claudeCodeEnabled && (
          <div>
            <span className="muted small">{t("api.messagesEndpoint")}</span>
            <code className="api-code api-code-inline">{endpoints.messages}</code>
          </div>
        )}
        <div>
          <span className="muted small">{t("api.modelsEndpoint")}</span>
          <code className="api-code api-code-inline">{endpoints.models}</code>
        </div>
      </div>
      <p className="muted small">{t("api.endpointNote")}</p>
    </div>
  );
}

export function ApiKeysAuthPanel({ claudeCodeEnabled }: { claudeCodeEnabled: boolean }) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel" style={{ marginTop: "1rem" }}>
      <h3 className="panel-title">{t("api.authTitle")}</h3>
      <ul className="api-auth-list muted small">
        <li>{t("api.authChatCompletions")}</li>
        <li>{t("api.authResponses")}</li>
        {claudeCodeEnabled && <li>{t("api.authMessages")}</li>}
        <li>{t("api.authLoopback")}</li>
      </ul>
      <p className="muted small">{t("api.authBaseUrlNote")}</p>
    </div>
  );
}

export function ApiKeysManagePanel({
  keys,
  keysLoadFailed,
  newName,
  creating,
  newKey,
  copied,
  confirmDelete,
  localeTag,
  onNewNameChange,
  onCreate,
  onDismissNewKey,
  onCopyKey,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  keys: ApiKeyEntry[];
  keysLoadFailed: boolean;
  newName: string;
  creating: boolean;
  newKey: string | null;
  copied: boolean;
  confirmDelete: string | null;
  localeTag?: string;
  onNewNameChange: (value: string) => void;
  onCreate: () => void;
  onDismissNewKey: () => void;
  onCopyKey: () => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      {newKey && (
        <div className="panel api-panel panel-accent" style={{ marginTop: "1rem" }}>
          <h3 className="panel-title">{t("api.newKeyTitle")}</h3>
          <p className="muted small">{t("api.newKeyNote")}</p>
          <div className="api-form-row">
            <code className="api-code" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCopyKey}>
              {copied ? <><IconCheck /> {t("api.copied")}</> : t("api.copy")}
            </button>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={onDismissNewKey}>
            {t("api.dismiss")}
          </button>
        </div>
      )}

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.generateTitle")}</h3>
        <div className="api-form-row">
          <input
            id="api-key-name"
            type="text"
            placeholder={t("api.keyNamePlaceholder")}
            aria-label={t("api.keyNamePlaceholder")}
            value={newName}
            onChange={e => onNewNameChange(e.target.value)}
            className="input"
          />
          <button type="button" className="btn btn-primary" onClick={onCreate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
          </button>
        </div>
      </div>

      <div id="api-active-keys" className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.activeKeys", { count: keys.length })}</h3>
        {keys.length > 0 ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>{t("api.colName")}</th><th>{t("api.colPurpose")}</th><th>{t("api.colKey")}</th><th>{t("api.colCreated")}</th><th></th></tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>{k.purpose === "github-copilot-desktop" ? t("api.copilotKeyPurpose") : t("api.genericKeyPurpose")}</td>
                    <td><code>{k.prefix}</code></td>
                    <td>{formatCreatedDate(k.createdAt, localeTag)}</td>
                    <td>
                      {confirmDelete === k.id ? (
                        <span className="api-actions">
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(k.id)}>{t("api.confirm")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelDelete}>{t("common.cancel")}</button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.deleteAria")} onClick={() => onConfirmDelete(k.id)}><IconX /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : keysLoadFailed ? (
          <p className="muted">{t("api.keysLoadFailed")}</p>
        ) : (
          <p className="muted">{t("api.noKeys")}</p>
        )}
      </div>
    </>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  modelRegex,
  copiedModelId,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onModelRegexChange,
  onCopyModelId,
  onTestModel,
  sourceLabel,
  protocolLabel,
}: {
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  modelQuery: string;
  modelRegex: RegexSearchState;
  copiedModelId: string | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onModelRegexChange: (value: RegexSearchState) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow) => void;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: string) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel" style={{ marginTop: "1rem" }}>
      <div className="api-panel-head">
        <h3 className="panel-title">{t("api.modelsTitle")}</h3>
        <span className="muted mono text-label">{t("api.modelsCount", { count: filteredModels.length })}</span>
      </div>
      <p className="muted small">{t("api.modelsSubtitle")}</p>
      <div className="api-model-search-row">
        <input
          type="search"
          className="input"
          value={modelQuery}
          onChange={event => onModelQueryChange(event.target.value)}
          placeholder={t("api.modelsSearch")}
          aria-label={t("api.modelsSearch")}
        />
        <RegexBuilderButton query={modelQuery} state={modelRegex} onStateChange={onModelRegexChange} />
      </div>
      {modelsLoadFailed && (
        <p className="api-test-note api-test-note--error" role="alert">{t("api.modelsLoadFailed")}</p>
      )}
      {modelsLoading && filteredModels.length === 0 ? (
        <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsLoading")}</p>
      ) : filteredModels.length === 0 ? (
        <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsEmpty")}</p>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("api.colModel")}</th>
                <th>{t("api.colSource")}</th>
                <th>{t("api.colReadiness")}</th>
                <th>{t("api.colCapabilities")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map(model => {
                const modelId = externalModelId(model);
                const testState = modelTests[modelId]?.state ?? "idle";
                return (
                  <tr key={modelId}>
                    <td>
                      <div className="api-model-cell">
                        <code>{modelId}</code>
                        {model.displayName !== model.id && <span className="muted small">{model.displayName}</span>}
                      </div>
                    </td>
                    <td>
                      <div>{sourceLabel(model)}</div>
                      <span className="muted small">{gatewayInboundProtocols(claudeCodeEnabled).map(protocolLabel).join(", ")}</span>
                    </td>
                    <td>
                      <span className={`api-capability-chip${model.copilot?.ready ? " api-capability-chip--ok" : " api-capability-chip--off"}`}>
                        {model.copilot?.ready ? t("api.capabilityReady") : t("api.capabilityUnavailable")}
                      </span>
                      {!model.copilot?.ready && <p className="muted small api-model-reason">{t(`api.reason.${model.copilot?.reason ?? "unresolved-route"}` as Parameters<typeof t>[0])}</p>}
                    </td>
                    <td>
                      <div className="api-capability-list">
                        {([
                          ["chat", t("api.capabilityChat")],
                          ["tools", t("api.capabilityAgent")],
                          ["images", t("api.capabilityImages")],
                          ["reasoning", t("api.capabilityReasoning")],
                          ["structuredOutput", t("api.capabilityStructured")],
                        ] as const).map(([key, label]) => (
                          <span key={key} className={`api-capability-chip${model.copilot?.capabilities[key] === "supported" ? " api-capability-chip--ok" : " api-capability-chip--off"}`}>
                            {label}: {model.copilot?.capabilities[key] === "supported" ? t("api.capabilityYes") : t("api.capabilityNo")}
                          </span>
                        ))}
                        {(model.copilot?.sidecars.length ?? 0) > 0 && <span className="api-capability-chip">{t("api.capabilitySidecar")}</span>}
                      </div>
                    </td>
                    <td>
                      <div className="api-model-actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onCopyModelId(modelId); }}>
                          {copiedModelId === modelId ? t("api.modelCopied") : t("api.copyModelId")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={testState === "testing" || model.copilot?.ready === false}
                          title={model.copilot?.ready === false ? t("api.testUnavailable") : undefined}
                          onClick={() => { onTestModel(model); }}
                        >
                          {testState === "testing" ? t("api.testingModel") : t("api.testModel")}
                        </button>
                      </div>
                      {testState === "ok" && <p className="muted small api-test-note api-test-note--ok">{t("api.testSucceeded")}</p>}
                      {testState === "error" && <p className="muted small api-test-note api-test-note--error">{modelTests[modelId]?.detail ?? t("api.testFailed")}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ApiKeysUsagePanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  const sampleInput = JSON.stringify(t("api.usageSampleInput"));

  return (
    <>
      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageChatTitle")}</h3>
        <pre className="api-code">{`curl ${endpoints.chatCompletions} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageResponsesTitle")}</h3>
        <pre className="api-code">{`curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": ${sampleInput}
  }'`}</pre>
      </div>

      {claudeCodeEnabled && (
        <div className="panel api-panel" style={{ marginTop: "1rem" }}>
          <h3 className="panel-title">{t("api.usageMessagesTitle")}</h3>
          <pre className="api-code">{`curl ${endpoints.messages} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
        </div>
      )}
    </>
  );
}
