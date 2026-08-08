import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { Button, Dialog, TextInput } from "../shell/m3-ui";
import { buildRemoteEndpoint, DEFAULT_REMOTE_PORT } from "../remote-connection";

type Props = {
  open: boolean;
  onClose: () => void;
  onConnect: (url: string) => void;
};

export default function RemoteConnectionDialog({ open, onClose, onConnect }: Props) {
  const t = useT();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_REMOTE_PORT));
  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setHost("");
      setPort(String(DEFAULT_REMOTE_PORT));
      window.setTimeout(() => hostRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const result = buildRemoteEndpoint(host, port);
  const error = result.ok ? null : result.error === "host" ? t("remote.hostInvalid") : t("remote.portInvalid");

  return (
    <Dialog
      title={t("remote.connectTitle")}
      description={t("remote.connectDescription")}
      onClose={onClose}
      dismissOnScrim={false}
      actions={
        <>
          <Button variant="text" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="filled"
            disabled={!result.ok}
            onClick={() => { if (result.ok) onConnect(result.url); }}
          >
            {t("remote.connect")}
          </Button>
        </>
      }
    >
      <div className="m3-stack" style={{ gap: "var(--sp-3)" }}>
        <p className="m3-field-hint">{t("remote.manualHint")}</p>
        <div className="m3-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="m3-field" style={{ flex: "1 1 240px" }}>
            <label className="m3-field-label" htmlFor="ocx-remote-host">{t("remote.host")}</label>
            <TextInput
              ref={hostRef}
              id="ocx-remote-host"
              value={host}
              onChange={event => setHost(event.target.value)}
              placeholder={t("remote.hostPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!host && !result.ok && error === t("remote.hostInvalid")}
            />
          </div>
          <div className="m3-field" style={{ flex: "0 1 160px" }}>
            <label className="m3-field-label" htmlFor="ocx-remote-port">{t("remote.port")}</label>
            <TextInput
              id="ocx-remote-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={event => setPort(event.target.value)}
              aria-invalid={!!port && !result.ok && error === t("remote.portInvalid")}
            />
          </div>
        </div>
        {error && (host || port !== String(DEFAULT_REMOTE_PORT)) && (
          <p role="alert" style={{ color: "var(--m3-error)", margin: 0 }}>{error}</p>
        )}
        {result.ok && <code style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{result.url}</code>}
      </div>
    </Dialog>
  );
}
EOF