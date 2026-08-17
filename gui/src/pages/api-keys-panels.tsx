import type { CSSProperties, ReactNode } from "react";
import { IconAlert, IconCheck, IconCopy, IconKey, IconSearch, IconTrash } from "../icons";
import { useI18n } from "../i18n/shared";
import { Button, Card, Chip, Dialog, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
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
  type CopilotDesktopProfile,
  type ModelTestState,
} from "./api-keys-utils";

export function ApiKeysCopilotPanel({
  profile,
  profileLoadFailed,
  integrationKey,
  creating,
  newKeyVisible,
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
  const readyCount = profile?.models.filter(model => model.ready).length ?? 0;
  return (
    <section className="api-panel api-copilot-panel" aria-busy={!profile && !profileLoadFailed}>
      <p className="api-copilot-eyebrow">{t("api.copilotEyebrow")}</p>
      <h3 className="panel-title">{t("api.copilotTitle")}</h3>
      <p className="muted small">{t("api.copilotSubtitle")}</p>
      <p className="api-copilot-note">{t("api.copilotOptionalKey")}</p>
      <div className="api-copilot-actions">
        {integrationKey ? (
          <Button variant="text" onClick={onManage}>{t("api.copilotManageKey")}</Button>
        ) : (
          <Button onClick={onGenerate} disabled={creating}>{creating ? t("api.generating") : t("api.copilotGenerateKey")}</Button>
        )}
        {newKeyVisible && <span className="muted small" role="status">{t("api.copyThisKeyNow")} · {t("api.copilotRevealAbove")}</span>}
      </div>
      <div className="api-copilot-summary" role="status">
        <span>{t("api.copilotReadyModels", { count: readyCount })}</span>
        <span>{profileLoadFailed ? t("api.copilotStatusUnavailable") : "completions"}</span>
      </div>
      <div className="api-copilot-warning" role="note">
        <strong>{t("api.copilotDirectTitle")}</strong>
        <span>{t("api.copilotDirectWarning")}</span>
      </div>
      <p className="muted small">{t("api.copilotSidecars")}</p>
    </section>
  );
}

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
  selected,
  onToggleSelect,
  bulkBar,
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
  /** Ids currently ticked. Owned by the page so the bar and rows cannot disagree. */
  selected: Set<string>;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  /** The bar itself, rendered above the table by the page that owns the actions. */
  bulkBar?: ReactNode;
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
        {bulkBar}
        {keys.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="m3-table">
              <thead>
                <tr><th scope="col"><span className="m3-visually-hidden">{t("bulk.region")}</span></th><th>{t("api.colName")}</th><th>{t("api.colKey")}</th><th>{t("api.colCreated")}</th><th></th></tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id}>
                    <td>
                      {/* Shift-click extends from the last row touched, which is
                          what every file manager does and therefore what people
                          expect without being told. */}
                      <input
                        type="checkbox"
                        className="m3-checkbox"
                        checked={selected.has(k.id)}
                        aria-label={t("api.selectAria", { label: k.name })}
                        onClick={event => onToggleSelect(k.id, (event as unknown as { shiftKey: boolean }).shiftKey)}
                        onChange={() => { /* click handles it, so shiftKey is available */ }}
                      />
                    </td>
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

  return (
    <Dialog
      // Escape, the scrim and Cancel all land here — the same three routes the
      // hand-rolled overlay wired up separately. Nothing typed is at stake, so
      // the scrim stays dismissable.
      onClose={onCancel}
      // The medallion has to read before the sentence, so the heading is
      // rendered below rather than through `title`, and Dialog is pointed at
      // its id instead.
      labelledBy="api-key-delete-title"
      actions={
        <>
          <Button variant="text" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={onConfirm}>{t("api.deleteConfirmAction")}</Button>
        </>
      }
    >
      {/* The prototype's destructive dialog opens on an error-tone medallion
          above a centred title, so the stakes read before the sentence does. */}
      <div style={DIALOG_MEDALLION} aria-hidden="true"><IconTrash width={26} height={26} /></div>
      <h3 id="api-key-delete-title" style={DIALOG_TITLE}>{t("api.deleteAria")}</h3>
      {/* The name the user recognises; the body below names the prefix that dies. */}
      <div className="m3-card" style={{ margin: "var(--sp-2) 0" }}>
        <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{entry.name}</strong>
      </div>
      <p className="m3-dialog__desc">{t("api.deleteConfirmBody", { prefix: entry.prefix })}</p>
      <div className="dash-notice m3-row" style={{ marginTop: "var(--sp-2)" }}>
        <IconAlert width={16} height={16} aria-hidden="true" /> {t("codexAuth.irreversible")}
      </div>
    </Dialog>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  modelQueryError,
  useRegex,
  modelFlags,
  copyOutcomeFor,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onUseRegexChange,
  onModelFlagsChange,
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
  /** The flags the page compiles this query with; the chip row below edits them. */
  modelFlags: string;
  copyOutcomeFor: (modelId: string) => CopyOutcome | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onUseRegexChange: (next: boolean) => void;
  onModelFlagsChange: (next: string) => void;
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
          aria-describedby={
            useRegex ? "api-models-regex-error api-models-flags-state" : "api-models-regex-error"
          }
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => onUseRegexChange(!useRegex)} title={t("search.regexHint")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        {/* No `sample`: this panel is handed the models the query already kept, and
            seeding the builder with those would test a new pattern against the old
            pattern's survivors. An empty box is honest; a misleading one is not. */}
        <RegexBuilderButton
          value={modelQuery}
          // Both halves of what the builder composed. Taking the pattern and
          // leaving the flags behind is what made the popover's flag chips
          // decorative from this field's point of view: they changed the match
          // list in the panel and nothing in the catalog underneath it.
          onApply={(pattern, appliedFlags) => { onModelQueryChange(pattern); onModelFlagsChange(appliedFlags); }}
          onDraftChange={(pattern, draftFlags) => { onModelQueryChange(pattern); onModelFlagsChange(draftFlags); }}
          regex={useRegex}
          onRegexChange={onUseRegexChange}
          flags={modelFlags}
          label="Regex"
          dialogLabel="Model-search regex builder"
        />
      </div>
      <p
        id="api-models-regex-error"
        role="alert"
        style={{ minHeight: 20, margin: "4px 0 var(--sp-3)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}
      >
        {modelQueryError ? `${t("regex.invalid")}: ${modelQueryError}` : ""}
      </p>
      <SearchFlagsRow
        regex={useRegex}
        flags={modelFlags}
        onFlagsChange={onModelFlagsChange}
        id="api-models-flags-state"
      />
      {modelsLoading ? (
        <p className="m3-empty">{t("api.modelsLoading")}</p>
      ) : modelsLoadFailed && filteredModels.length === 0 ? (
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
                        {model.copilot?.ready === false && (
                          <span style={{ color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
                            {model.copilot.reason === "cursor-native-execution-unavailable"
                              ? "Cursor native local execution must be disabled"
                              : model.copilot.reason}
                          </span>
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
                          disabled={testState === "testing" || model.copilot?.ready === false}
                          title={model.copilot?.ready === false ? t("api.testUnavailable") : undefined}
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
