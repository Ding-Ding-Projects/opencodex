/**
 * One-press launching of the agent CLIs and their desktop apps.
 *
 * Backed by /api/launch, which reports what is actually installed on the machine
 * rather than assuming. A target that is not installed is shown as such with a
 * link to get it, instead of a button that fails on click — the failure would
 * otherwise look like a bug in the dashboard rather than a missing program.
 *
 * The click sends only a catalog id. No path and no argument travels from here to
 * a process, which is what keeps a "launch this program" button from being a
 * remote code execution surface on an exposed dashboard.
 */

import { useState } from "react";
import { Button, Card, Empty } from "../shell/m3-ui";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";

interface LaunchTarget {
  id: string;
  label: string;
  kind: "cli" | "desktop";
  available: boolean;
  installUrl: string;
}

export default function LaunchCard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [busyId, setBusyId] = useState<string | null>(null);

  const targets = useKeyedClientResource(
    `ocx-launch:${apiBase}`,
    [],
    async (signal): Promise<LaunchTarget[] | null> => {
      const res = await fetch(`${apiBase}/api/launch`, { signal });
      const data = await readJsonIfOk<{ targets?: LaunchTarget[] }>(res);
      // null (not []) distinguishes "the request failed" from "nothing installed",
      // so the empty state cannot masquerade as a successful read.
      return data && Array.isArray(data.targets) ? data.targets : null;
    },
  );

  const launch = async (target: LaunchTarget) => {
    setBusyId(target.id);
    notify({ tone: "info", title: t("launch.opening", { label: target.label }) });
    try {
      const res = await fetch(`${apiBase}/api/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        notify({ tone: "error", title: t("launch.failed", { label: target.label }), body: body?.error });
        return;
      }
      notify({ tone: "success", title: t("launch.opened", { label: target.label }) });
    } catch {
      notify({ tone: "error", title: t("launch.failed", { label: target.label }) });
    } finally {
      setBusyId(null);
    }
  };

  const rows = targets.data;
  const installed = rows?.filter(row => row.available) ?? [];

  return (
    <Card title={t("launch.title")} subtitle={t("launch.sub")}>
      {rows === null ? (
        <p style={{ color: "var(--m3-error)" }}>{t("launch.loadFailed")}</p>
      ) : rows === undefined ? (
        <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
      ) : installed.length === 0 ? (
        <Empty title={t("launch.emptyTitle")}>{t("launch.emptyBody")}</Empty>
      ) : (
        <div className="m3-launch-grid">
          {rows.map(target => (
            <div key={target.id} className="m3-launch-item">
              <div className="m3-launch-meta">
                <span className="m3-launch-label">{target.label}</span>
                <span className="m3-launch-kind">
                  {t(target.kind === "cli" ? "launch.cli" : "launch.desktop")}
                  {!target.available && ` · ${t("launch.notInstalled")}`}
                </span>
              </div>
              {target.available ? (
                <Button
                  variant="tonal"
                  onClick={() => void launch(target)}
                  disabled={busyId === target.id}
                  aria-label={`${t("launch.open")} ${target.label}`}
                >
                  {t("launch.open")}
                </Button>
              ) : (
                <a
                  className="m3-btn m3-btn--text"
                  href={target.installUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`${t("launch.install")} ${target.label}`}
                >
                  {t("launch.install")}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
