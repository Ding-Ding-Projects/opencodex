import type { ComboItem } from "../combo-workspace-data";
import { buildComboAttention, groupCombos } from "../combo-workspace-data";
import { IconAlert, IconChevron, IconPlus } from "../icons";
import { useT, type TFn } from "../i18n/shared";
import { Button, Card } from "../shell/m3-ui";

function attentionCopy(
  reason: "empty-targets" | "few-targets" | "catalog-omitted",
  t: TFn,
): string {
  if (reason === "empty-targets") return t("cws.attention.empty");
  if (reason === "catalog-omitted") return t("cws.attention.catalogOmitted");
  return t("cws.attention.few");
}

export function OverviewPanel({
  combos,
  cataloguedComboIds,
  onSelect,
  onAdd,
}: {
  combos: ComboItem[];
  cataloguedComboIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const sections = groupCombos(combos);
  const attention = buildComboAttention(combos, { cataloguedComboIds });

  return (
    <div className="combos-workspace-overview">
      <div className="combos-workspace-overview-head">
        <h2 className="combos-workspace-overview-title">{t("cws.overviewTitle")}</h2>
        <Button variant="filled" onClick={onAdd}>
          <IconPlus aria-hidden="true" /> {t("cws.add")}
        </Button>
      </div>
      <p className="cwi-overview-blurb">{t("cws.overviewBlurb")}</p>
      <div className="cwi-count-strip">
        <div className="cwi-count-pill"><strong>{combos.length}</strong><span>{t("cws.count.total")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.failover.length}</strong><span>{t("cws.count.failover")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.roundRobin.length}</strong><span>{t("cws.count.roundRobin")}</span></div>
      </div>

      <Card title={t("cws.howTitle")}>
        <p className="m3-card-sub" style={{ margin: 0 }}>{t("cws.howBody")}</p>
      </Card>

      {attention.length > 0 && (
        <Card title={t("cws.attentionTitle")}>
          <div className="cwi-attention-list">
            {attention.map((item) => (
              <button
                key={`${item.id}:${item.reason}`}
                type="button"
                className="cwi-attention-row"
                onClick={() => onSelect(item.id)}
              >
                <IconAlert width={18} height={18} aria-hidden="true" />
                <span className="cwi-attention-model">{item.model}</span>
                <span>{attentionCopy(item.reason, t)}</span>
                <IconChevron width={18} height={18} style={{ marginLeft: "auto", flex: "0 0 auto" }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
