/**
 * "Is it running?" — with a button that answers it.
 *
 * The dashboard's offline screen said *"Cannot connect to proxy. Is it running?
 * Run `ocx start`."* That names the fix and then leaves the user to go and
 * perform it, which inside the desktop shell is the worst place to be told: this
 * window IS the app, there is no terminal in front of anyone, and "open a
 * terminal and type this" is the exact experience the desktop build exists to
 * remove. The information was correct and completely unhelpful.
 *
 * ## Why it only appears in the desktop shell
 *
 * A browser tab cannot start a local process, and a button that cannot work is
 * worse than no button — it turns a solvable problem into one the user believes
 * they have already tried. In a browser this renders nothing and the banner
 * keeps naming the command, which is genuinely the only thing that helps there.
 *
 * ## Why it reports what actually happened
 *
 * The bridge resolves only once `/healthz` answers, so "Started" here means the
 * port is open rather than that a process was spawned. Those are different
 * claims, and the gap between them is exactly where a green light lies: a proxy
 * that exits three seconds into startup would otherwise be reported as running.
 * A failure shows the reason verbatim and leaves the command visible, because
 * the fallback has to survive the button failing.
 */

import { useState } from "react";

import { Button } from "../shell/m3-ui";
import { IconPlay, IconRefresh } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";

export function StartProxyButton({ onStarted }: { onStarted?: () => void }) {
  const t = useT();
  const { notify } = useNotifications();
  const [busy, setBusy] = useState(false);
  const bridge = window.opencodexDesktop?.proxy;

  // Nothing to offer in a browser. The banner's `ocx start` line stands alone.
  if (!bridge) return null;

  const start = async () => {
    setBusy(true);
    try {
      const result = await bridge.start();
      if (result.ok) {
        notify({
          tone: "success",
          title: t("dash.proxyStarted"),
          // "Adopted" is worth distinguishing: the proxy was already up and this
          // window simply had not noticed, which is a different thing to have
          // happened and changes nothing about what the user should do next.
          body: result.adopted
            ? t("dash.proxyAdopted", { port: String(result.port) })
            : t("dash.proxyStartedBody", { port: String(result.port) }),
        });
        onStarted?.();
      } else {
        notify({ tone: "error", title: t("dash.proxyStartFailed"), body: result.error });
      }
    } catch (error) {
      notify({ tone: "error", title: t("dash.proxyStartFailed"), body: String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="filled" onClick={() => void start()} disabled={busy}>
      {busy ? <IconRefresh aria-hidden="true" /> : <IconPlay aria-hidden="true" />}
      {busy ? t("dash.proxyStarting") : t("dash.startProxy")}
    </Button>
  );
}
