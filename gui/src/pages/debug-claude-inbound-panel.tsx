import { useI18n } from "../i18n/shared";
import { Card } from "../shell/m3-ui";
import type { ClaudeInboundEntry } from "./debug-shared";
import { formatClaudeInboundTime } from "./debug-shared";

export function DebugClaudeInboundPanel({ entries }: { entries: ClaudeInboundEntry[] }) {
  const { t } = useI18n();

  return (
    <Card title={t("debug.claudeInbound.title")} subtitle={t("debug.claudeInbound.sub")}>
      {entries.length === 0 ? (
        <div style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
          {t("debug.claudeInbound.empty")}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="m3-table">
            <thead>
              <tr>
                <th scope="col">{t("debug.claudeInbound.time")}</th>
                <th scope="col">{t("debug.claudeInbound.endpoint")}</th>
                <th scope="col">{t("debug.claudeInbound.model")}</th>
                <th scope="col">{t("debug.claudeInbound.thinking")}</th>
                <th scope="col">{t("debug.claudeInbound.effort")}</th>
                <th scope="col">{t("debug.claudeInbound.beta")}</th>
                <th scope="col">{t("debug.claudeInbound.metadata")}</th>
                <th scope="col">{t("debug.claudeInbound.system")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td className="muted mono">{formatClaudeInboundTime(entry.at)}</td>
                  <td className="mono">{entry.endpoint}</td>
                  <td className="mono" title={entry.resolvedModel}>
                    {entry.model}
                    {entry.resolvedModel && entry.resolvedModel !== entry.model && (
                      <span className="muted"> → {entry.resolvedModel}</span>
                    )}
                  </td>
                  <td className="mono">
                    {entry.thinkingType ?? "-"}
                    {entry.thinkingBudgetTokens !== undefined && <span className="muted"> ({entry.thinkingBudgetTokens})</span>}
                  </td>
                  <td className="mono">{entry.outputConfigEffort ?? "-"}</td>
                  <td className="mono" title={entry.anthropicBeta} style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.anthropicBeta ?? "-"}</td>
                  <td className="mono" title={entry.metadataKeys?.join(", ")}>
                    {entry.hasMetadataUserId ? `user_id ${entry.userIdTag ?? ""}` : t("debug.claudeInbound.none")}
                  </td>
                  <td className="mono">{entry.hasSystem ? entry.systemTag ?? "yes" : t("debug.claudeInbound.none")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
