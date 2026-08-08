import { Trans } from "../i18n/provider";
import type { TFn } from "../i18n/shared";
import { Card, Empty } from "../shell/m3-ui";
import { providerStatusPresentation, type ProviderInfo } from "./dashboard-shared";

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
                const status = providerStatusPresentation(p, t);
                return (
                  <tr key={p.name} data-configuration-reason={p.configurationReason}>
                    <td className="font-semibold">
                      <span className="m3-row" style={{ gap: 8 }}>
                        <span className={`dot ${status.dotClass}`} role="img" aria-label={status.label} />
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
