import { useEffect, useRef, type CSSProperties } from "react";
import { IconAlert, IconCheck, IconCopy, IconKey, IconRegex, IconSearch, IconTrash } from "../icons";
import { useI18n } from "../i18n/shared";
import { Button, Card, Chip, TextInput } from "../shell/m3-ui";
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

/**
 * Code block for the reveal-once key and the curl samples. Inline because the
 * legacy `.api-code` rule is still wired to the pre-M3 token names; every value
 * here is an `--m3-*` role token so the block re-themes with the rest of the app.
 */
const CODE_BLOCK: CSSProperties = {
  display: "block",
  margin: 0,
  padding: "var(--sp-3)",
  borderRadius: "var(--r-m)",
  background: "var(--m3-surface-container-highest)",
  color: "var(--m3-on-surface)",
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
  lineHeight: 1.6,
  overflowX: "auto",
};

/** Per-model test verdict: M3 metrics, functional status colour from the class. */
const TEST_NOTE: CSSProperties = { margin: "4px 0 0", fontSize: "var(--t-label-m)" };

/** Prototype's destructive-dialog medallion: 56px error-tone circle, centred. */
const DIALOG_MEDALLION: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 56,
  height: 56,
  margin: "0 auto var(--sp-3)",
  borderRadius: 999,
  background: "var(--m3-error-container)",
  color: "var(--m3-on-error-container)",
};

const DIALOG_TITLE: CSSProperties = {
  margin: "0 0 var(--sp-2)",
  textAlign: "center",
  fontSize: "var(--t-headline-s)",
  fontWeight: 500,
};

/** The auth notes read as body text, not as the legacy list rule's muted labels. */
const AUTH_NOTE: CSSProperties = {
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-body-s)",
  lineHeight: 1.7,
};

export function ApiKeysEndpointsPanel({
  endpoints,
  claudeCodeEnabled,
  onCopy,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
  onCopy: (value: string) => void;
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
      <div style={{ overflowX: "auto" }}>
        <table className="m3-table">
          <tbody>
            {rows.map(row => (
              <tr key={row.label}>
                <th scope="row" style={{ width: 200 }}>{row.label}</th>
                <td><code style={CODE_CELL}>{row.value}</code></td>
                <td style={{ width: 48 }}>
                  {/* Three identical "Copy" buttons in one table is a screen-reader
                      dead end; each one names the endpoint it copies. */}
                  <button
                    type="button"
                    className="m3-icon-btn"
                    aria-label={t("api.copyValueAria", { label: row.label })}
                    onClick={() => onCopy(row.value)}
                  >
                    <IconCopy aria-hidden="true" />
                  </button>
                </td>
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
  const notes = [
    t("api.authChatCompletions"),
    t("api.authResponses"),
    ...(claudeCodeEnabled ? [t("api.authMessages")] : []),
    t("api.authLoopback"),
  ];
  return (
    <Card title={t("api.authTitle")} subtitle={t("api.authBaseUrlNote")}>
      {/* `display: block` re-states the default: the legacy `.api-auth-list` rule
          makes this a grid, which blockifies the items and drops the markers. */}
      <ul className="api-auth-list" style={{ display: "block", margin: 0, paddingLeft: 20 }}>
        {notes.map(note => <li key={note} style={AUTH_NOTE}>{note}</li>)}
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
  onCopyPrefix,
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
  onCopyPrefix: (prefix: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  // Deleting a key is a decision, not an announcement: it gets the blocking
  // dialog the prototype shows, with the key it kills named in it.
  const pendingDelete = confirmDelete ? keys.find(k => k.id === confirmDelete) ?? null : null;

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
          <div className="m3-row">
            <code style={{ ...CODE_BLOCK, flex: "1 1 240px", minWidth: 0, wordBreak: "break-all" }}>{newKey}</code>
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
        <div className="m3-row">
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
            <IconKey aria-hidden="true" /> {creating ? t("api.generating") : t("api.generate")}
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
                    {/* A row header, so the two icon-only buttons below are announced
                        against the key they act on rather than as three bare "Copy"s. */}
                    <th scope="row" style={{ color: "var(--m3-on-surface)", fontSize: "var(--t-body-m)" }}>{k.name}</th>
                    <td><code style={CODE_CELL}>{k.prefix}</code></td>
                    <td style={{ fontFamily: "var(--mono)" }}>{formatCreatedDate(k.createdAt, localeTag)}</td>
                    <td>
                      <span className="m3-row" style={{ justifyContent: "flex-end", gap: 0 }}>
                        <button
                          type="button"
                          className="m3-icon-btn"
                          aria-label={t("api.copyValueAria", { label: k.name })}
                          onClick={() => onCopyPrefix(k.prefix)}
                        >
                          <IconCopy aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="m3-icon-btn"
                          aria-label={t("api.deleteAria")}
                          style={{ color: "var(--m3-error)" }}
                          onClick={() => onConfirmDelete(k.id)}
                        >
                          <IconTrash aria-hidden="true" />
                        </button>
                      </span>
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

      {pendingDelete && (
        <ApiKeysDeleteDialog
          entry={pendingDelete}
          onCancel={onCancelDelete}
          onConfirm={() => onDelete(pendingDelete.id)}
        />
      )}
    </>
  );
}

/**
 * Permanent-delete gate. The dialog names the key, states what stops working the
 * moment it is confirmed, and says plainly that it cannot be undone — the three
 * facts the funny-level rule keeps fixed at every voice setting.
 */
function ApiKeysDeleteDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: ApiKeyEntry;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="api-key-delete-title"
      onCancel={event => { event.preventDefault(); onCancel(); }}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onCancel} />
      <div className="modal-card" onClick={event => event.stopPropagation()} role="document">
        {/* The prototype's destructive dialog opens on an error-tone medallion
            above a centred title, so the stakes read before the sentence does. */}
        <div style={DIALOG_MEDALLION} aria-hidden="true"><IconTrash width={26} height={26} /></div>
        <h3 id="api-key-delete-title" style={DIALOG_TITLE}>{t("api.deleteAria")}</h3>
        {/* The name the user recognises; the body below names the prefix that dies. */}
        <div className="m3-card" style={{ margin: "var(--sp-2) 0" }}>
          <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{entry.name}</strong>
        </div>
        <p className="modal-desc">{t("api.deleteConfirmBody", { prefix: entry.prefix })}</p>
        <div className="dash-notice m3-row" style={{ marginTop: "var(--sp-2)" }}>
          <IconAlert width={16} height={16} aria-hidden="true" /> {t("codexAuth.irreversible")}
        </div>
        <div className="modal-actions">
          <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("api.deleteConfirmAction")}</Button>
        </div>
      </div>
    </dialog>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  modelQueryError,
  useRegex,
  copyOutcomeFor,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onUseRegexChange,
  onCopyModelId,
  onTestModel,
  sourceLabel,
  protocolLabel,
}: {
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  modelQuery: string;
  modelQueryError: string | null;
  useRegex: boolean;
  copyOutcomeFor: (modelId: string) => CopyOutcome | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onUseRegexChange: (next: boolean) => void;
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
      <div className="m3-row" role="search">
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={modelQuery}
          onChange={event => onModelQueryChange(event.target.value)}
          placeholder={t("api.modelsSearch")}
          aria-label={t("api.modelsSearch")}
          aria-invalid={!!modelQueryError}
          aria-describedby="api-models-regex-error"
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => onUseRegexChange(!useRegex)} title={t("search.regexHint")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <a className="m3-icon-btn" href="#regex" title={t("nav.regex")} aria-label={t("search.openBuilder")}>
          <IconRegex width={20} height={20} aria-hidden="true" />
        </a>
      </div>
      <p
        id="api-models-regex-error"
        role="alert"
        style={{ minHeight: 20, margin: "4px 0 var(--sp-3)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}
      >
        {modelQueryError ? `${t("regex.invalid")}: ${modelQueryError}` : ""}
      </p>
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
                      <div className="m3-stack">
                        <code style={CODE_CELL}>{modelId}</code>
                        {model.displayName !== model.id && (
                          <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{model.displayName}</span>
                        )}
                      </div>
                    </td>
                    <td>{sourceLabel(model)}</td>
                    <td>{gatewayInboundProtocols(claudeCodeEnabled).map(protocolLabel).join(", ")}</td>
                    <td>
                      <div className="m3-row">
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
                      {/* The `--ok`/`--error` classes keep the functional status colours;
                          the size comes from the M3 scale, not the legacy label token. */}
                      {testState === "ok" && (
                        <p className="api-test-note api-test-note--ok" style={TEST_NOTE}>{t("api.testSucceeded")}</p>
                      )}
                      {testState === "error" && (
                        <p className="api-test-note api-test-note--error" style={TEST_NOTE}>{modelTests[modelId]?.detail ?? t("api.testFailed")}</p>
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
        <pre style={CODE_BLOCK}>{`curl ${endpoints.chatCompletions} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
      </Card>

      <Card title={t("api.usageResponsesTitle")}>
        <pre style={CODE_BLOCK}>{`curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": ${sampleInput}
  }'`}</pre>
      </Card>

      {claudeCodeEnabled && (
        <Card title={t("api.usageMessagesTitle")}>
          <pre style={CODE_BLOCK}>{`curl ${endpoints.messages} \\
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
