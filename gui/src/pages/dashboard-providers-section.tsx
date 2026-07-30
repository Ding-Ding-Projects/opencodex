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
              {providers.map(p => (
                <tr key={p.name}>
                  <td className="font-semibold">{p.name}</td>
                  <td><span className="m3-chip">{p.adapter}</span></td>
                  <td className="dash-cell-url">{p.baseUrl}</td>
                  <td className="muted">{p.defaultModel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
