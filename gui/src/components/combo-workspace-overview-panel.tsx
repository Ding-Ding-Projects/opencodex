import type { ComboItem } from "../combo-workspace-data";
import { buildComboAttention } from "../combo-workspace-data";
import { IconAlert, IconChevron, IconPlus } from "../icons";
import { useT } from "../i18n/shared";
import { Button, Card } from "../shell/m3-ui";
import { attentionCopy } from "./combo-workspace-attention";

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
  const attention = buildComboAttention(combos, { cataloguedComboIds });

  return (
    <div className="combos-workspace-overview">
      <div className="combos-workspace-overview-head">
        <h2 className="combos-workspace-overview-title">{t("cws.overviewTitle")}</h2>
        <Button variant="filled" onClick={onAdd}>
          <IconPlus aria-hidden="true" /> {t("cws.add")}
        </Button>
      </div>
      {/* The blurb and the count strip moved up to the page banner in Combos.tsx,
          where the prototype puts them — repeating them here would double them up. */}

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
