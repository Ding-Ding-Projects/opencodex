import { IconCheck, IconPlus, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import { Button, Card, TextInput } from "../shell/m3-ui";
import type { CopyOutcome } from "../components/use-copy-feedback";
import {
  externalModelId,
  gatewayInboundProtocols,
  type ExternalModelRow,
} from "../api-access-models";
import {
  formatCreatedDate,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTestState,
} from "./api-keys-utils";

/** Monospace value cell shared by the endpoint and key tables. */
const CODE_CELL = { fontFamily: "var(--mono)", overflowWrap: "anywhere" } as const;

export function ApiKeysEndpointsPanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  const rows: { label: string; value: string }[] = [
    { label: t("api.baseUrl"), value: endpoints.baseUrl },
    { label: t("api.responsesEndpoint"), value: endpoints.responses },
    { label: t("api.chatCompletionsEndpoint"), value: endpoints.chatCompletions },
    ...(claudeCodeEnabled ? [{ label: t("api.messagesEndpoint"), value: endpoints.messages }] : []),
    { label: t("api.modelsEndpoint"), value: endpoints.models },
  ];
  return (
    <Card title={t("api.endpointsTitle")} subtitle={t("api.endpointNote")}>
      <div className="api-endpoints" style={{ overflowX: "auto" }}>
        <table className="m3-table">
          <tbody>
            {rows.map(row => (
              <tr key={row.label}>
                <th scope="row" style={{ width: 200 }}>{row.label}</th>
                <td><code style={CODE_CELL}>{row.value}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ApiKeysAuthPanel({ claudeCodeEnabled }: { claudeCodeEnabled: boolean }) {
  const { t } = useI18n();
  return (
    <Card title={t("api.authTitle")} subtitle={t("api.authBaseUrlNote")}>
      <ul className="api-auth-list">
        <li>{t("api.authChatCompletions")}</li>
        <li>{t("api.authResponses")}</li>
        {claudeCodeEnabled && <li>{t("api.authMessages")}</li>}
        <li>{t("api.authLoopback")}</li>
      </ul>
    </Card>
  );
}

export function ApiKeysManagePanel({
  keys,
  keysLoadFailed,
  newName,
  creating,
  newKey,
  copyOutcome,
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
  copyOutcome: CopyOutcome | null;
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
      {/* Reveal-once: the secret lives only in this card until it is dismissed. */}
      {newKey && (
        <Card
          title={t("api.newKeyTitle")}
          subtitle={t("api.newKeyNote")}
          actions={<Button variant="text" onClick={onDismissNewKey}>{t("api.dismiss")}</Button>}
          style={{
            background: "var(--m3-primary-container)",
            color: "var(--m3-on-primary-container)",
          }}
        >
          <div className="api-form-row">
            <code className="api-code" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <Button variant="tonal" onClick={onCopyKey}>
              {copyOutcome === "copied"
                ? <><IconCheck aria-hidden="true" /> {t("api.copied")}</>
                : copyOutcome === "unavailable"
                  ? t("prov.linkCopyUnavailable")
                  : t("api.copy")}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t("api.generateTitle")}>
        <div className="api-form-row">
          <TextInput
            id="api-key-name"
            type="text"
            placeholder={t("api.keyNamePlaceholder")}
            aria-label={t("api.keyNamePlaceholder")}
            value={newName}
            onChange={e => onNewNameChange(e.target.value)}
            style={{ flex: "1 1 220px", width: "auto" }}
          />
          <Button onClick={onCreate} disabled={creating}>
            <IconPlus aria-hidden="true" /> {creating ? t("api.generating") : t("api.generate")}
          </Button>
        </div>
      </Card>

      <Card title={t("api.activeKeys", { count: keys.length })}>
        {keys.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="m3-table">
              <thead>
                <tr><th>{t("api.colName")}</th><th>{t("api.colKey")}</th><th>{t("api.colCreated")}</th><th></th></tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td><code style={CODE_CELL}>{k.prefix}</code></td>
                    <td>{formatCreatedDate(k.createdAt, localeTag)}</td>
                    <td>
                      {confirmDelete === k.id ? (
                        <span className="api-actions">
                          <Button variant="danger" onClick={() => onDelete(k.id)}>{t("api.confirm")}</Button>
                          <Button variant="text" onClick={onCancelDelete}>{t("common.cancel")}</Button>
                        </span>
                      ) : (
                        <Button
                          variant="text"
                          aria-label={t("api.deleteAria")}
                          style={{ minWidth: 44, color: "var(--m3-error)" }}
                          onClick={() => onConfirmDelete(k.id)}
                        >
                          <IconX aria-hidden="true" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m3-empty">{keysLoadFailed ? t("api.keysLoadFailed") : t("api.noKeys")}</p>
        )}
      </Card>
    </>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  copyOutcomeFor,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onCopyModelId,
  onTestModel,
  sourceLabel,
  protocolLabel,
}: {
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  modelQuery: string;
  copyOutcomeFor: (modelId: string) => CopyOutcome | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow) => void;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: string) => string;
}) {
  const { t } = useI18n();
  return (
    <Card
      title={t("api.modelsTitle")}
      subtitle={t("api.modelsSubtitle")}
      actions={<span className="m3-chip" aria-hidden="true">{t("api.modelsCount", { count: filteredModels.length })}</span>}
    >
      <div className="m3-row" style={{ marginBottom: "var(--sp-3)" }}>
        <TextInput
          type="search"
          value={modelQuery}
          onChange={event => onModelQueryChange(event.target.value)}
          placeholder={t("api.modelsSearch")}
          aria-label={t("api.modelsSearch")}
          style={{ flex: "1 1 240px", width: "auto" }}
        />
      </div>
      {modelsLoading ? (
        <p className="m3-empty">{t("api.modelsLoading")}</p>
      ) : modelsLoadFailed ? (
        <p className="m3-empty">{t("api.modelsLoadFailed")}</p>
      ) : filteredModels.length === 0 ? (
        <p className="m3-empty">{t("api.modelsEmpty")}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="m3-table">
            <thead>
              <tr>
                <th>{t("api.colModel")}</th>
                <th>{t("api.colSource")}</th>
                <th>{t("api.colProtocols")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map(model => {
                const modelId = externalModelId(model);
                const testState = modelTests[modelId]?.state ?? "idle";
                const copyOutcome = copyOutcomeFor(modelId);
                return (
                  <tr key={modelId}>
                    <td>
                      <div className="api-model-cell">
                        <code style={CODE_CELL}>{modelId}</code>
                        {model.displayName !== model.id && (
                          <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{model.displayName}</span>
                        )}
                      </div>
                    </td>
                    <td>{sourceLabel(model)}</td>
                    <td>{gatewayInboundProtocols(claudeCodeEnabled).map(protocolLabel).join(", ")}</td>
                    <td>
                      <div className="api-model-actions">
                        <Button variant="text" onClick={() => { onCopyModelId(modelId); }}>
                          {copyOutcome === "copied"
                            ? t("api.modelCopied")
                            : copyOutcome === "unavailable"
                              ? t("prov.linkCopyUnavailable")
                              : t("api.copyModelId")}
                        </Button>
                        <Button
                          variant="outlined"
                          disabled={testState === "testing"}
                          onClick={() => { onTestModel(model); }}
                        >
                          {testState === "testing" ? t("api.testingModel") : t("api.testModel")}
                        </Button>
                      </div>
                      {testState === "ok" && (
                        <p className="api-test-note api-test-note--ok">{t("api.testSucceeded")}</p>
                      )}
                      {testState === "error" && (
                        <p className="api-test-note api-test-note--error">{modelTests[modelId]?.detail ?? t("api.testFailed")}</p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
      <Card title={t("api.usageChatTitle")}>
        <pre className="api-code">{`curl ${endpoints.chatCompletions} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
      </Card>

      <Card title={t("api.usageResponsesTitle")}>
        <pre className="api-code">{`curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": ${sampleInput}
  }'`}</pre>
      </Card>

      {claudeCodeEnabled && (
        <Card title={t("api.usageMessagesTitle")}>
          <pre className="api-code">{`curl ${endpoints.messages} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
        </Card>
      )}
    </>
  );
}
