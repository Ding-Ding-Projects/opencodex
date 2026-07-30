/**
 * The mobile remote control.
 *
 * A phone is not a small desktop. The dashboard's nav rail, tab strip and
 * dense tables are the wrong shape for a thumb on a train, so this is its own
 * full-bleed surface with a bottom bar, 44px targets and safe-area insets —
 * rather than the admin UI squeezed into 390px.
 *
 * It deliberately adds no new server API. Chat goes through the proxy's own
 * `/v1/chat/completions`, which is the same endpoint every other client uses,
 * so a message sent from a phone is routed, logged, counted and billed exactly
 * like one sent from Codex. Sessions read `/api/logs`; control reads
 * `/api/host`. Inventing a parallel "mobile API" would have created a second
 * path to the same behaviour, and a second place for it to be wrong.
 *
 * ## Reaching it from a phone
 *
 * The proxy must be published to the network first (`ocx host enable`, or the
 * Remote access screen), which requires a credential — that gate is deliberately
 * the same one the rest of the exposed surface uses, and this screen does not
 * weaken it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { readJsonIfOk } from "../fetch-json";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";

type Panel = "chat" | "sessions" | "control";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Set while the reply is still arriving, so the bubble can show it. */
  streaming?: boolean;
  error?: boolean;
}

interface ModelRow {
  id: string;
  provider?: string;
}

interface LogRow {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  surface?: string;
  status: number;
  durationMs: number;
  totalTokens?: number;
  errorCode?: string;
}

interface HostStatus {
  hostname: string;
  port: number;
  exposed: boolean;
  credentialConfigured: boolean;
  urls: string[];
}

/** Sessions poll while the tab is open; a phone on mobile data should not poll hard. */
const SESSION_POLL_MS = 5000;

const KEY_STORAGE = "ocx-m3:mobile-key";

/**
 * The remembered API key. It is the same credential the proxy already demands
 * from every other client, it stays on this device, and it is only needed once
 * the proxy is published to the network.
 */
function readStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    // Private browsing: the field simply starts empty.
    return "";
  }
}

export default function Mobile({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();

  const [panel, setPanel] = useState<Panel>("chat");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [model, setModel] = useState("");
  // Lazy initializer rather than an effect: this is a synchronous storage read
  // that produces the initial value, so an effect would only add a second render.
  const [apiKey, setApiKey] = useState(readStoredKey);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [host, setHost] = useState<HostStatus | null>(null);

  const transcript = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`${apiBase}/api/models`);
      const data = await readJsonIfOk<{ models?: ModelRow[] } | ModelRow[]>(res);
      const rows = Array.isArray(data) ? data : data?.models;
      if (cancelled || !Array.isArray(rows)) return;
      setModels(rows);
      setModel(current => current || rows[0]?.id || "");
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  // Sessions and host status refresh only while their tab is showing.
  useEffect(() => {
    if (panel !== "sessions") return;
    let cancelled = false;
    const load = async () => {
      const res = await fetch(`${apiBase}/api/logs`);
      const data = await readJsonIfOk<{ logs?: LogRow[] } | LogRow[]>(res);
      const rows = Array.isArray(data) ? data : data?.logs;
      // null, not [], so a failed read cannot render as "no sessions".
      if (!cancelled) setLogs(Array.isArray(rows) ? rows : null);
    };
    void load();
    const timer = setInterval(() => void load(), SESSION_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [apiBase, panel]);

  useEffect(() => {
    if (panel !== "control") return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`${apiBase}/api/host`);
      const data = await readJsonIfOk<HostStatus>(res);
      if (!cancelled) setHost(data ?? null);
    })();
    return () => { cancelled = true; };
  }, [apiBase, panel]);

  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || !model || sending) return;

    setDraft("");
    setSending(true);
    setMessages(prev => [...prev, { role: "user", content: prompt }, { role: "assistant", content: "", streaming: true }]);

    const controller = new AbortController();
    abort.current = controller;

    try {
      const history = [...messages, { role: "user" as const, content: prompt }]
        .filter(m => !m.error)
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${apiBase}/v1/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages: history, stream: true }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail.slice(0, 300) || t("mobile.httpStatus", { status: res.status }));
      }

      // Server-sent events, decoded incrementally. A partial frame at the end of
      // a chunk is kept in `buffer` rather than parsed and dropped.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let reply = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find(l => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const piece = json.choices?.[0]?.delta?.content;
            if (piece) {
              reply += piece;
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: reply, streaming: true };
                return next;
              });
            }
          } catch { /* a keepalive or a frame this client does not model */ }
        }
      }

      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: reply || t("mobile.emptyReply"), streaming: false };
        return next;
      });
    } catch (err) {
      // Stop is the user's own decision, not a failure. Treating an abort like a
      // network error threw away everything they had already read, replaced it
      // with a raw DOMException, and — because errored turns are filtered out of
      // the history sent upstream — deleted that whole assistant turn from
      // context, so the next message arrived after two consecutive user turns
      // and "shorten that" referred to text the model had never seen.
      const aborted = err instanceof DOMException && err.name === "AbortError";
      setMessages(prev => {
        const next = [...prev];
        const partial = next[next.length - 1]?.content ?? "";
        if (aborted) {
          next[next.length - 1] = {
            role: "assistant",
            content: partial || t("mobile.stopped"),
            streaming: false,
          };
        } else {
          const message = err instanceof Error ? err.message : String(err);
          next[next.length - 1] = { role: "assistant", content: message, streaming: false, error: true };
        }
        return next;
      });
      if (!aborted) {
        const message = err instanceof Error ? err.message : String(err);
        notify({ tone: "error", title: t("mobile.sendFailed"), body: message });
      }
    } finally {
      abort.current = null;
      setSending(false);
    }
  }, [apiBase, apiKey, draft, messages, model, notify, sending, t]);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setSending(false);
  }, []);

  const saveKey = useCallback((value: string) => {
    setApiKey(value);
    try { localStorage.setItem(KEY_STORAGE, value); } catch { /* private mode */ }
  }, []);

  return (
    <div className="m3-mob">
      <header className="m3-mob__bar">
        <span className="m3-mob__title">{t("mobile.title")}</span>
        {panel === "chat" && (
          <select
            className="m3-mob__model"
            value={model}
            onChange={event => setModel(event.target.value)}
            aria-label={t("mobile.model")}
          >
            {models.length === 0 && <option value="">{t("common.loading")}</option>}
            {models.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}
          </select>
        )}
      </header>

      <main className="m3-mob__body">
        {panel === "chat" && (
          <>
            <div className="m3-mob__chat" ref={transcript} role="log" aria-live="polite" aria-label={t("mobile.transcript")}>
              {messages.length === 0 && (
                <p className="m3-mob__hint">{t("mobile.chatHint")}</p>
              )}
              {messages.map((message, i) => (
                <div
                  key={i}
                  className={`m3-mob__msg m3-mob__msg--${message.role}${message.error ? " m3-mob__msg--error" : ""}`}
                >
                  {message.content}
                  {message.streaming && <span className="m3-mob__caret" aria-hidden="true" />}
                </div>
              ))}
            </div>

            <form
              className="m3-mob__compose"
              onSubmit={event => { event.preventDefault(); void send(); }}
            >
              <label className="m3-visually-hidden" htmlFor="m3-mob-input">{t("mobile.prompt")}</label>
              <textarea
                id="m3-mob-input"
                value={draft}
                onChange={event => setDraft(event.target.value)}
                placeholder={t("mobile.prompt")}
                rows={1}
                onKeyDown={event => {
                  // Enter sends; Shift+Enter is a newline. On a phone the on-screen
                  // keyboard sends Enter as a newline anyway, so the button is the
                  // primary path and this is for a paired keyboard.
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {sending ? (
                <button type="button" className="m3-mob__send m3-mob__send--stop" onClick={stop}>
                  {t("mobile.stop")}
                </button>
              ) : (
                <button type="submit" className="m3-mob__send" disabled={!draft.trim() || !model}>
                  {t("mobile.send")}
                </button>
              )}
            </form>
          </>
        )}

        {panel === "sessions" && (
          <div className="m3-mob__list">
            {logs === null ? (
              <p className="m3-mob__hint">{t("mobile.sessionsFailed")}</p>
            ) : logs.length === 0 ? (
              <p className="m3-mob__hint">{t("mobile.noSessions")}</p>
            ) : (
              logs.slice(0, 60).map((log, i) => (
                <article key={log.requestId ?? i} className="m3-mob__session">
                  <div className="m3-mob__sessionhead">
                    <strong>{log.model}</strong>
                    <span className={log.status >= 400 ? "m3-mob__bad" : "m3-mob__ok"}>{log.status}</span>
                  </div>
                  <div className="m3-mob__sessionmeta">
                    <span>{log.provider}</span>
                    {log.surface && <span>· {log.surface}</span>}
                    <span>· {Math.round(log.durationMs)}ms</span>
                    {typeof log.totalTokens === "number" && <span>· {t("mobile.tokens", { n: log.totalTokens })}</span>}
                  </div>
                  {log.errorCode && <div className="m3-mob__bad">{log.errorCode}</div>}
                </article>
              ))
            )}
          </div>
        )}

        {panel === "control" && (
          <div className="m3-mob__list">
            <article className="m3-mob__session">
              <div className="m3-mob__sessionhead"><strong>{t("mobile.proxy")}</strong></div>
              {host === null ? (
                <p className="m3-mob__hint">{t("common.loading")}</p>
              ) : (
                <>
                  <div className="m3-mob__sessionmeta">
                    <span>{host.hostname}:{host.port}</span>
                    <span>· {host.exposed ? t("mobile.exposed") : t("mobile.loopback")}</span>
                  </div>
                  {host.exposed && !host.credentialConfigured && (
                    <p className="m3-mob__bad">{t("mobile.noCredential")}</p>
                  )}
                  {host.urls.map(url => <div key={url} className="m3-mob__url">{url}</div>)}
                </>
              )}
            </article>

            <article className="m3-mob__session">
              <div className="m3-mob__sessionhead"><strong>{t("mobile.apiKey")}</strong></div>
              <p className="m3-mob__hint">{t("mobile.apiKeyHint")}</p>
              <input
                type="password"
                className="m3-mob__key"
                value={apiKey}
                onChange={event => saveKey(event.target.value)}
                placeholder={t("mobile.keyPlaceholder")}
                autoComplete="off"
                aria-label={t("mobile.apiKey")}
              />
            </article>
          </div>
        )}
      </main>

      <nav className="m3-mob__nav" aria-label={t("mobile.title")}>
        {(["chat", "sessions", "control"] as Panel[]).map(id => (
          <button
            key={id}
            type="button"
            className={`m3-mob__navbtn${panel === id ? " is-active" : ""}`}
            aria-current={panel === id ? "page" : undefined}
            onClick={() => setPanel(id)}
          >
            {t(`mobile.${id}` as Parameters<typeof t>[0])}
          </button>
        ))}
      </nav>
    </div>
  );
}
