/**
 * The mobile remote control.
 *
 * A phone is not a small desktop. The dashboard's nav rail, tab strip and
 * dense tables are the wrong shape for a thumb on a train, so this is its own
 * full-bleed surface with a bottom bar, 44px targets and safe-area insets —
 * rather than the admin UI squeezed into 390px.
 *
 * It adds one server route and no more: `POST /api/host/pair/claim`, which
 * exists because a phone that has never paired has no credential to present and
 * therefore cannot be served by anything already here. Everything else reuses
 * what other clients use. Chat goes through the proxy's own
 * `/v1/chat/completions` and the model list through `/v1/models`, both on the
 * data-plane key pairing hands out, so a message sent from a phone is routed,
 * logged, counted and billed exactly like one sent from Codex. Sessions read
 * `/api/logs`; control reads `/api/host` — both management routes, now open like
 * the desktop dashboard. Inventing a parallel "mobile API" would have created a second path to the same
 * behaviour, and a second place for it to be wrong.
 *
 * ## Reaching it from a phone
 *
 * The proxy must be published to the network first (`ocx host enable`, or the
 * Remote access screen), which still requires a data-plane credential for model
 * traffic. The management routes used by this screen have no admin-token gate.
 *
 * What changed is how the phone *gets* that credential. Scanning the pairing QR
 * on the Remote access screen opens `#/mobile?pair=<token>`; this screen spends
 * the token on load, receives a data-plane key of its own, and removes the
 * parameter from the URL. Nobody types a 43-character key on a phone keyboard,
 * and nothing that survives the page — a screenshot, a shared link, the
 * browser's own session restore — carries a live pairing token.
 *
 * ## Finding a control
 *
 * The screen carries the shared settings search, and it indexes all three panels
 * rather than only the one showing. That is what the `tab` on each option buys:
 * with the search active on Chat, a hit on the Control panel's API key is
 * reported by name instead of being silently filtered away, which is the exact
 * "the app does not have that setting" lie the search exists to stop telling.
 * The bottom bar is deliberately never filtered — hiding the only route back to
 * another panel would strand whoever typed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readJsonIfOk } from "../fetch-json";
import {
  beginPairingClaim,
  canRetryPairingClaim,
  isClaimApplied,
  markClaimApplied,
  readPairedKey,
  retryPairingClaim,
  savePairedKey,
  type ClaimFailure,
} from "../lib/mobile-pairing";
import { useT } from "../i18n/shared";
import { useConfirm } from "../shell/confirm-context";
import { useNotifications } from "../shell/notifications-context";
import { SettingsSearchRow } from "../shell/SettingsSearch";
import { useSettingsSearch } from "../shell/use-settings-search";
import type { SettingsOption } from "../shell/settings-search";

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
  /** The desktop is running with `OPENCODEX_DEBUG_SANDBOX` — it will issue no key. */
  debugSandbox?: boolean;
}

/** Sessions poll while the tab is open; a phone on mobile data should not poll hard. */
const SESSION_POLL_MS = 5000;

/**
 * How many distinct model names from the request log the settings search indexes.
 *
 * The log renders sixty rows, and the search corpus is also what the regex
 * builder shows as sample text. Pasting sixty mostly-repeated model ids into
 * that textarea would bury every other option on the screen without finding the
 * user anything a dozen distinct names do not already find.
 */
const SESSION_INDEX_MODELS = 12;

export default function Mobile({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  // Shadows the global `confirm` deliberately, as every other page here does:
  // forgetting a paired key is a decision, and a decision gets the M3 dialog.
  const confirm = useConfirm();

  const [panel, setPanel] = useState<Panel>("chat");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [model, setModel] = useState("");
  // Lazy initializer rather than an effect: this is a synchronous storage read
  // that produces the initial value, so an effect would only add a second render.
  const [apiKey, setApiKey] = useState(readPairedKey);
  const [claiming, setClaiming] = useState(false);
  const [pairError, setPairError] = useState<ClaimFailure | null>(null);
  // A key the proxy has actually refused, as opposed to one simply absent. The
  // two need different advice: "pair this device" versus "pair it again".
  const [keyRejected, setKeyRejected] = useState(false);
  // Bumped by the retry button so the claim effect re-runs against the token
  // still held in module scope.
  const [reclaim, setReclaim] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // undefined = not read yet, null = the read failed, [] = genuinely empty.
  // Collapsing the first two showed "could not read the session log" for a
  // moment on every visit, before anything had been attempted.
  const [logs, setLogs] = useState<LogRow[] | null | undefined>(undefined);
  // undefined = not read yet, null = the read failed, which on a phone usually
  // means 401: `/api/host` is a management route and a paired phone holds a
  // data-plane key. Collapsing the two left this panel showing "Loading…"
  // forever with nothing to act on.
  const [host, setHost] = useState<HostStatus | null | undefined>(undefined);

  const transcript = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  // `reload` is a nonce the retry button bumps. Without it the models effect
  // depends only on `apiBase`, which never changes — so one failed fetch left
  // the model picker empty and Send disabled for the life of the page, with no
  // error shown and no way back short of restarting the app.
  const [reload, setReload] = useState(0);
  const [modelsError, setModelsError] = useState(false);

  /**
   * The panel names, once, because they are three separate things: the label on
   * the bottom bar, the `tab` each option declares, and the tab the search is
   * told is showing. Deriving them in three places is how those three drift
   * apart, and a `tab` string that no longer equals `activeTab` turns every
   * option on the visible panel into an off-tab report.
   */
  const tabs = useMemo(() => ({
    chat: t("mobile.chat"),
    sessions: t("mobile.sessions"),
    control: t("mobile.control"),
  }), [t]);

  /**
   * Everything on this screen a user might go looking for, in the words the
   * screen is currently showing them.
   *
   * Each option carries its current value as well as its name, because the
   * remembered thing is often the value — the model that is selected, the host
   * and port the proxy answers on, the draft still sitting in the compose box.
   */
  const options: SettingsOption[] = useMemo(() => {
    // What the request log actually reads right now: its state message while it
    // is loading, broken or empty, and otherwise the models it is listing — so
    // "I saw a request for that model in there" is enough to find the panel.
    const sessionsValue = logs === undefined
      ? t("common.loading")
      : logs === null
        ? t("mobile.sessionsFailed")
        : logs.length === 0
          ? t("mobile.noSessions")
          : [...new Set(logs.map(row => row.model))].slice(0, SESSION_INDEX_MODELS).join(" ");

    // Three states, like `logs` above and like the panel that renders it below:
    // `undefined` is still loading, `null` is a proxy that could not be read.
    // Collapsing them loses the distinction the panel already draws — and
    // checking only for `null` dereferenced `undefined` on the very first
    // render, which is every render before the fetch lands.
    const proxyValue = host === undefined
      ? t("common.loading")
      : host === null
        ? t("mobile.hostUnavailable")
        : [
          `${host.hostname}:${host.port}`,
          host.exposed ? t("mobile.exposed") : t("mobile.loopback"),
          // Only when it is actually on screen: indexing the warning
          // unconditionally would find "credential" on a proxy that has one,
          // which reads as the opposite of the truth.
          ...(host.exposed && !host.credentialConfigured ? [t("mobile.noCredential")] : []),
          ...(host.urls ?? []),
        ].join(" ");

    return [
      {
        // No `tab`. The bottom bar is on screen whichever panel is showing, so
        // reporting it as living "on another tab" would simply be false.
        id: "panel",
        label: t("mobile.panelNav"),
        value: tabs[panel],
        keywords: [tabs.chat, tabs.sessions, tabs.control].join(" "),
      },
      {
        id: "model",
        label: t("mobile.model"),
        value: model || t("common.loading"),
        // Every model the picker offers, not only the chosen one: typing a model
        // id has to find the control that selects it, which is the whole reason
        // `keywords` exists.
        keywords: models.map(row => row.id).join(" "),
        tab: tabs.chat,
      },
      {
        id: "transcript",
        label: t("mobile.transcript"),
        desc: t("mobile.chatHint"),
        // Deliberately no `value`. The reply text is rewritten on every streamed
        // token, so indexing it would rebuild this list and rerun the search
        // hundreds of times per answer on a phone — and the conversation is
        // already on screen, which is not what a settings search is for. The
        // retry control that replaces the transcript when models fail to load is
        // indexed here instead, because here is where it renders.
        keywords: [t("mobile.retry"), t("mobile.modelsFailed")].join(" "),
        tab: tabs.chat,
      },
      {
        id: "prompt",
        label: t("mobile.prompt"),
        value: draft,
        keywords: [t("mobile.send"), t("mobile.stop")].join(" "),
        tab: tabs.chat,
      },
      {
        id: "sessions",
        label: t("mobile.sessions"),
        value: sessionsValue,
        tab: tabs.sessions,
      },
      {
        id: "proxy",
        label: t("mobile.proxy"),
        value: proxyValue,
        tab: tabs.control,
      },
      {
        // Its own option rather than folded into `apiKey`: pairing and the manual
        // key field are two different ways to hold the same credential, and the
        // words a user searches for differ — "paired", "forget this device" and
        // "scan" belong to this card, not to the password box below it.
        id: "pairing",
        label: t("mobile.pairing"),
        value: apiKey ? t("mobile.pairedState") : t("mobile.unpairedState"),
        keywords: [
          t("mobile.forget"),
          apiKey ? t("mobile.pairedHint") : t("mobile.unpairedHint"),
        ].join(" "),
        tab: tabs.control,
      },
      {
        id: "apiKey",
        label: t("mobile.apiKey"),
        desc: t("mobile.apiKeyHint"),
        // The key itself is never indexed, only whether one was entered. The
        // corpus this builds is handed to the regex builder and rendered into a
        // plain `<textarea>`, so indexing the value would print a live proxy
        // credential in clear text on the screen. `lib/mobile-pairing.ts` accepts
        // storing this key where a script on the origin could read it; that is a
        // bounded, argued trade for a revocable data-plane key, and it is not a
        // reason to also paint it on the screen.
        value: apiKey ? t("mobile.keySet") : t("mobile.keyPlaceholder"),
        tab: tabs.control,
      },
    ];
  }, [t, tabs, panel, model, models, draft, logs, host, apiKey]);

  const search = useSettingsSearch({ options, scope: "mobile", activeTab: tabs[panel] });
  const { matches } = search;
  const showTranscript = matches("transcript");

  // True once a model list has actually arrived, so the first discovery runs
  // immediately and only the re-runs below pay the debounce.
  const haveModels = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // `/v1/models` remains the data-plane discovery endpoint every other
        // client uses, and it takes exactly the credential pairing hands out.
        const res = await fetch(`${apiBase}/v1/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        const data = await readJsonIfOk<{ data?: ModelRow[] } | ModelRow[]>(res);
        const rows = Array.isArray(data) ? data : data?.data;
        if (cancelled) return;
        if (!Array.isArray(rows)) { setModelsError(true); return; }
        setModelsError(false);
        haveModels.current = true;
        setModels(rows);
        setModel(current => current || rows[0]?.id || "");
      } catch {
        // A phone dropping off Wi-Fi rejects the fetch rather than returning an
        // HTTP error, so `readJsonIfOk` never sees it.
        if (!cancelled) setModelsError(true);
      }
    };

    // Debounced on re-runs, immediate on the first. `apiKey` has to be a
    // dependency — the list is a data-plane read and an unpaired phone gets
    // nothing without the key — but the Control tab's key field updates it on
    // every keystroke, so a hand-typed 43-character key fired 43 discovery
    // requests. Pairing sets the key in one go and is unaffected either way.
    const timer = setTimeout(() => void load(), haveModels.current ? 400 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [apiBase, apiKey, reload]);

  // Sessions and host status refresh only while their tab is showing.
  useEffect(() => {
    if (panel !== "sessions") return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/logs`);
        const data = await readJsonIfOk<{ logs?: LogRow[] } | LogRow[]>(res);
        const rows = Array.isArray(data) ? data : data?.logs;
        // null, not [], so a failed read cannot render as "no sessions".
        if (!cancelled) setLogs(Array.isArray(rows) ? rows : null);
      } catch {
        if (!cancelled) setLogs(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), SESSION_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [apiBase, panel]);

  useEffect(() => {
    if (panel !== "control") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/host`);
        const data = await readJsonIfOk<HostStatus>(res);
        if (!cancelled) setHost(data ?? null);
      } catch {
        if (!cancelled) setHost(null);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, panel]);

  // `showTranscript` is a dependency because a search that filters the transcript
  // away unmounts it, and clearing the search mounts a fresh element scrolled to
  // the top. Without this, dismissing a search dropped the user at the beginning
  // of the conversation instead of where they left off, at the newest reply.
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, showTranscript]);

  // Leaving the screen mid-reply must stop the request, not keep a stream open
  // against a component that is gone. A ref, so this runs once on unmount
  // rather than aborting whenever the controller happens to change.
  useEffect(() => () => abort.current?.abort(), []);

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

      // A refused credential is not a generic HTTP failure: it is the one error
      // this screen can actually fix, and it must say so rather than surfacing
      // the proxy's raw "opencodex API key required" and leaving the user to
      // guess that the key their phone has silently stopped working. Keys are
      // revoked from the dashboard and wiped by a state restore, so a stored key
      // going stale is expected, not exotic.
      if (res.status === 401) {
        setKeyRejected(true);
        setPanel("control");
        throw new Error(t(apiKey ? "mobile.keyRejectedBody" : "mobile.keyMissingBody"));
      }

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
    savePairedKey(value);
    // Any stored rejection belonged to the key being replaced.
    setKeyRejected(false);
  }, []);

  /**
   * Spend the pairing token this page was opened with.
   *
   * `claimApplied` is module scope, not a ref, so it is scoped to the page load
   * rather than to a component instance: navigating away from this screen and
   * back must not re-announce a pairing that already happened.
   */
  useEffect(() => {
    const pending = beginPairingClaim(apiBase);
    if (!pending || isClaimApplied()) return;

    let cancelled = false;
    setClaiming(true);
    void pending.then(outcome => {
      // `cancelled` covers StrictMode's first, discarded mount; the applied
      // latch covers a re-run from a locale change while the request was in
      // flight. Either way the outcome is announced exactly once.
      if (cancelled || !markClaimApplied()) return;
      setClaiming(false);
      if (outcome.ok) {
        saveKey(outcome.key);
        setPairError(null);
        notify({ tone: "success", title: t("mobile.paired"), body: t("mobile.pairedBody") });
      } else {
        setPairError(outcome.reason);
        notify({ tone: "error", title: t("mobile.pairFailed"), body: t(`mobile.pairFailed.${outcome.reason}`) });
      }
    });
    return () => { cancelled = true; };
  }, [apiBase, notify, reclaim, saveKey, t]);

  /** Retry a claim that failed on the network, without another trip to the QR. */
  const retryPairing = useCallback(() => {
    if (!retryPairingClaim(apiBase)) return;
    setPairError(null);
    setReclaim(n => n + 1);
  }, [apiBase]);

  const forgetDevice = useCallback(async () => {
    const confirmed = await confirm({
      title: t("mobile.forget"),
      body: t("mobile.forgetConfirm"),
      confirmLabel: t("mobile.forget"),
      tone: "danger",
    });
    if (!confirmed) return;
    saveKey("");
    notify({ tone: "success", title: t("mobile.forgotten"), body: t("mobile.forgottenBody") });
  }, [confirm, notify, saveKey, t]);

  return (
    <div className="m3-mob">
      <header className="m3-mob__bar">
        <span className="m3-mob__title">{t("mobile.title")}</span>
        {panel === "chat" && matches("model") && (
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

      {/*
        Its own grid row between the bar and the body, and outside both — the
        body's panels scroll, and a builder popover opened from inside an
        `overflow-y: auto` box is clipped by it rather than floating over the
        screen. It sits above all three panels because the search spans all
        three: moving it inside a panel would have made the off-tab report a
        thing you can only read on the tab you are already on.
      */}
      <div className="m3-mob__search">
        {/* `compact`: at 390px the row's default 240px field basis pushes the
            builder button onto a second line, and the search block eats a
            quarter of the phone. */}
        <SettingsSearchRow search={search} compact />
      </div>

      <main className="m3-mob__body">
        {panel === "chat" && (
          <>
            {/*
              `role="log"` without `aria-live`: the streaming loop rewrites the
              last bubble's entire text on every delta, so a live region here
              announced the whole reply-so-far once per token — hundreds of
              ever-longer interruptions that made the screen unusable with a
              screen reader exactly while it was producing the answer. The
              completed reply is announced once, from the polite region below.
            */}
            {showTranscript ? (
              <div className="m3-mob__chat" ref={transcript} role="log" aria-label={t("mobile.transcript")}>
                {modelsError && (
                  <div className="m3-mob__msg m3-mob__msg--error" role="alert">
                    {t("mobile.modelsFailed")}
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="m3-mob__send" onClick={() => setReload(n => n + 1)}>
                        {t("mobile.retry")}
                      </button>
                    </div>
                  </div>
                )}
                {messages.length === 0 && !modelsError && (
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
            ) : (
              // An empty transcript rather than nothing at all. The body is a
              // two-row grid whose first row takes the leftover height, so a
              // filtered-away transcript would promote the compose box into it
              // and stretch that bar down the whole screen.
              <div className="m3-mob__chat" />
            )}

            {/* Announced once, when the reply is finished. */}
            <div className="m3-visually-hidden" aria-live="polite">
              {!sending && messages.length > 0 && messages[messages.length - 1].role === "assistant"
                ? messages[messages.length - 1].content
                : ""}
            </div>

            {matches("prompt") && (
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
            )}
          </>
        )}

        {panel === "sessions" && matches("sessions") && (
          <div className="m3-mob__list">
            {logs === undefined ? (
              <p className="m3-mob__hint">{t("common.loading")}</p>
            ) : logs === null ? (
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
            {/* Ungated, and above the cards, like the desktop's banner. A phone
                that reaches this screen against a sandboxed desktop will never
                pair and never keep a key, and finding that out by scanning a code
                and being refused is a worse way to learn it than being told. */}
            {host?.debugSandbox && (
              <p role="status" className="m3-mob__bad">{t("mobile.debugSandbox")}</p>
            )}

            {matches("proxy") && (
            <article className="m3-mob__session">
              <div className="m3-mob__sessionhead"><strong>{t("mobile.proxy")}</strong></div>
              {host === undefined ? (
                <p className="m3-mob__hint">{t("common.loading")}</p>
              ) : host === null ? (
                <p className="m3-mob__hint">{t("mobile.hostUnavailable")}</p>
              ) : (
                <>
                  <div className="m3-mob__sessionmeta">
                    <span>{host.hostname}:{host.port}</span>
                    <span>· {host.exposed ? t("mobile.exposed") : t("mobile.loopback")}</span>
                  </div>
                  {host.exposed && !host.credentialConfigured && (
                    <p className="m3-mob__bad">{t("mobile.noCredential")}</p>
                  )}
                  {(host.urls ?? []).map(url => <div key={url} className="m3-mob__url">{url}</div>)}
                </>
              )}
            </article>
            )}

            {matches("pairing") && (
            <article className="m3-mob__session">
              <div className="m3-mob__sessionhead">
                <strong>{t("mobile.pairing")}</strong>
                <span className={apiKey ? "m3-mob__ok" : "m3-mob__bad"}>
                  {apiKey ? t("mobile.pairedState") : t("mobile.unpairedState")}
                </span>
              </div>

              {claiming ? (
                <p className="m3-mob__hint" role="status">{t("mobile.pairingClaiming")}</p>
              ) : pairError ? (
                <>
                  <p className="m3-mob__bad" role="alert">{t(`mobile.pairFailed.${pairError}`)}</p>
                  {/* Only a dropped connection is worth retrying: a spent, wrong
                      or expired token will refuse identically however many times
                      it is presented, so offering "try again" for those would be
                      an invitation to keep failing. */}
                  {(pairError === "no-connection" || pairError === "rate-limited") && canRetryPairingClaim() && (
                    <button type="button" className="m3-mob__send" onClick={retryPairing}>
                      {t("mobile.retry")}
                    </button>
                  )}
                </>
              ) : keyRejected ? (
                <p className="m3-mob__bad" role="alert">{t("mobile.keyRejectedBody")}</p>
              ) : (
                <p className="m3-mob__hint">{apiKey ? t("mobile.pairedHint") : t("mobile.unpairedHint")}</p>
              )}

              {apiKey && (
                <button type="button" className="m3-mob__send m3-mob__send--stop" onClick={() => void forgetDevice()}>
                  {t("mobile.forget")}
                </button>
              )}
            </article>
            )}

            {matches("apiKey") && (
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
            )}
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
