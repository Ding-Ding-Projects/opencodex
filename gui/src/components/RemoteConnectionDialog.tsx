import { useId, useState, type FormEvent } from "react";
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
  const [hostTouched, setHostTouched] = useState(false);
  const [portTouched, setPortTouched] = useState(false);
  const formId = useId();
  const hostErrorId = useId();
  const portErrorId = useId();

  if (!open) return null;

  const result = buildRemoteEndpoint(host, port);
  const hostInvalid = !result.ok && result.error !== "port";
  const portInvalid = !result.ok && result.error === "port";
  const hostError = !result.ok && result.error === "ipv4-leading-zero"
    ? t("remote.ipv4LeadingZero")
    : t("remote.hostInvalid");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setHostTouched(true);
    setPortTouched(true);
    if (result.ok) onConnect(result.url);
  };

  return (
    <Dialog
      title={t("remote.connectTitle")}
      description={t("remote.connectDescription")}
      onClose={onClose}
      dismissOnScrim={false}
      actions={
        <>
          <Button type="button" variant="text" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            form={formId}
            variant="filled"
            disabled={!result.ok}
          >
            {t("remote.connect")}
          </Button>
        </>
      }
    >
      <form id={formId} className="m3-stack" style={{ gap: "var(--sp-3)" }} onSubmit={submit} noValidate>
        <p className="m3-field-hint">{t("remote.manualHint")}</p>
        <p className="m3-field-hint">{t("remote.directHint")}</p>
        <div className="m3-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="m3-field" style={{ flex: "1 1 240px" }}>
            <label className="m3-field-label" htmlFor="ocx-remote-host">{t("remote.host")}</label>
            <TextInput
              id="ocx-remote-host"
              value={host}
              onChange={event => { setHost(event.target.value); setHostTouched(true); }}
              onBlur={() => setHostTouched(true)}
              placeholder={t("remote.hostPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={hostTouched && hostInvalid}
              aria-describedby={hostTouched && hostInvalid ? hostErrorId : undefined}
            />
            {hostTouched && hostInvalid && (
              <p id={hostErrorId} role="alert" className="m3-field-hint" style={{ color: "var(--m3-error)" }}>
                {hostError}
              </p>
            )}
          </div>
          <div className="m3-field" style={{ flex: "0 1 160px" }}>
            <label className="m3-field-label" htmlFor="ocx-remote-port">{t("remote.port")}</label>
            <TextInput
              id="ocx-remote-port"
              type="text"
              inputMode="numeric"
              value={port}
              onChange={event => { setPort(event.target.value); setPortTouched(true); }}
              onBlur={() => setPortTouched(true)}
              autoComplete="off"
              aria-invalid={portTouched && portInvalid}
              aria-describedby={portTouched && portInvalid ? portErrorId : undefined}
            />
            {portTouched && portInvalid && (
              <p id={portErrorId} role="alert" className="m3-field-hint" style={{ color: "var(--m3-error)" }}>
                {t("remote.portInvalid")}
              </p>
            )}
          </div>
        </div>
        {result.ok && <code style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{result.url}</code>}
      </form>
    </Dialog>
  );
}
