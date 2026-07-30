import { Trans } from "../i18n/provider";
import type { TFn } from "../i18n/shared";
import { Card, Empty } from "../shell/m3-ui";
import type { ProviderInfo } from "./dashboard-shared";

export function DashboardProvidersSection({
  t,
  providers,
}: {
  t: TFn;
  providers: ProviderInfo[];
}) {
  return (
    <Card title={t("dash.activeProviders")} subtitle={String(providers.length)}>
      {providers.length === 0 ? (
        <Empty title={<Trans k="dash.noProviders" cmd="ocx init" />} />
      ) : (
        <div className="dash-table-wrap">
          <table className="m3-table">
            <thead>
              <tr>
                <th scope="col">{t("dash.col.name")}</th>
                <th scope="col">{t("dash.col.adapter")}</th>
                <th scope="col">{t("dash.col.baseUrl")}</th>
                <th scope="col">{t("dash.col.model")}</th>
              </tr>
            </thead>
            <tbody>
              {providers.map(p => {
                // Status is a functional data colour, so the dot also carries its
                // own name: colour alone would leave "needs setup" invisible to a
                // screen reader and to anyone who cannot separate the two hues.
                const status = t(p.hasApiKey ? "pws.status.ready" : "pws.status.needsSetup");
                return (
                  <tr key={p.name}>
                    <td className="font-semibold">
                      <span className="m3-row" style={{ gap: 8 }}>
                        <span className={`dot ${p.hasApiKey ? "dot-green" : "dot-amber"}`} role="img" aria-label={status} />
                        {p.name}
                      </span>
                    </td>
                    <td><span className="m3-chip">{p.adapter}</span></td>
                    <td className="dash-cell-url">{p.baseUrl}</td>
                    <td className="muted">{p.defaultModel ?? "—"}</td>
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
