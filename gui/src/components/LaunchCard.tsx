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
  /** True when this machine has a package manager that can install the target. */
  installable?: boolean;
  /** True when an official package exists for this platform at all. */
  hasInstallRoute?: boolean;
}

interface InstallJob {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
  log: string[];
  error?: string;
  verified?: boolean;
  note?: string;
}

/**
 * Follow a running install to completion, reporting each poll.
 *
 * Lives outside the component so the loop can advance a local binding: inside a
 * component that binding would be captured by the state updater, which is
 * exactly the stale-closure shape the hook rules forbid.
 */
async function followInstall(
  apiBase: string,
  start: InstallJob,
  onUpdate: (job: InstallJob) => void,
): Promise<InstallJob> {
  let current = start;
  while (current.state === "running") {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const res = await fetch(`${apiBase}/api/launch/install/${encodeURIComponent(current.id)}`);
    const next = await readJsonIfOk<{ job?: InstallJob }>(res);
    if (!next?.job) break;
    current = next.job;
    onUpdate(current);
  }
  return current;
}

export default function LaunchCard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Record<string, InstallJob>>({});

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

  /**
   * Install a target and follow the job to completion.
   *
   * Polled rather than streamed: an install is a handful of status lines over
   * tens of seconds, and a poll cannot leave a socket open against a dashboard
   * that may be reachable from another device.
   */
  const install = async (target: LaunchTarget) => {
    setBusyId(target.id);
    try {
      const res = await fetch(`${apiBase}/api/launch/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      const body = await res.json().catch(() => null) as
        { ok?: boolean; job?: InstallJob; error?: string; manual?: boolean; installUrl?: string } | null;

      if (!body?.ok) {
        // No automatic route: fall back to the page rather than dead-ending.
        if (body?.manual && body.installUrl) {
          notify({ tone: "info", title: t("launch.installManual"), body: body.error });
          window.open(body.installUrl, "_blank", "noreferrer,noopener");
          return;
        }
        notify({ tone: "error", title: t("launch.installFailed", { label: target.label }), body: body?.error });
        return;
      }

      const started = body.job!;
      setInstalling(prev => ({ ...prev, [target.id]: started }));
      notify({ tone: "info", title: t("launch.installing", { label: target.label }) });

      const job = await followInstall(apiBase, started, next => {
        setInstalling(prev => ({ ...prev, [target.id]: next }));
      });

      if (job.state === "done") {
        notify({
          tone: "success",
          title: t("launch.installed", { label: target.label }),
          body: job.verified ? undefined : t("launch.installRestart"),
        });
        // Re-probe: the target should now report as available.
        void targets.refresh();
      } else {
        notify({ tone: "error", title: t("launch.installFailed", { label: target.label }), body: job.error });
      }
    } catch {
      notify({ tone: "error", title: t("launch.installFailed", { label: target.label }) });
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
              ) : target.installable ? (
                <Button
                  variant="tonal"
                  onClick={() => void install(target)}
                  disabled={busyId === target.id}
                  aria-label={`${t("launch.install")} ${target.label}`}
                >
                  {busyId === target.id ? t("launch.installing", { label: target.label }) : t("launch.install")}
                </Button>
              ) : (
                // No package manager here, or no official package at all: the page
                // is the honest offer, and the title says which of the two it is.
                <a
                  className="m3-btn m3-btn--text"
                  href={target.installUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={target.hasInstallRoute === false ? t("launch.installManual") : undefined}
                  aria-label={`${t("launch.installOpenPage")} — ${target.label}`}
                >
                  {t("launch.installOpenPage")}
                </a>
              )}
              {installing[target.id] && installing[target.id].log.length > 0 && (
                <details className="m3-launch-log">
                  <summary>{t("launch.installLog")}</summary>
                  <pre aria-live="polite">{installing[target.id].log.slice(-12).join("\n")}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
