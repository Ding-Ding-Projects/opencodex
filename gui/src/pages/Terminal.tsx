/**
 * The embedded terminal.
 *
 * Sessions are piped rather than pseudo-terminals (see `src/lib/terminal-session.ts`
 * for why), which has one honest consequence this screen has to carry: a
 * full-screen TUI will not render here. The preset says so before you start it
 * and the session repeats it, because a terminal that looks broken is worse
 * than one that explains its limits.
 *
 * Output is polled with a cursor rather than streamed. The transcript is a few
 * hundred short chunks over the life of a session, and polling avoids holding a
 * socket open against a dashboard that may be published to other devices.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Card, Empty } from "../shell/m3-ui";
import { readJsonIfOk } from "../fetch-json";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";

interface Preset {
  id: string;
  label: string;
  fullScreen?: boolean;
}

interface SessionView {
  id: string;
  presetId: string;
  label: string;
  state: "running" | "exited";
  exitCode?: number;
  fullScreen: boolean;
}

interface Chunk {
  seq: number;
  text: string;
  stream: "out" | "err" | "in";
}

const POLL_MS = 700;

/** Errors read as errors; the lines you sent read as yours. */
const CHUNK_CLASS: Record<Chunk["stream"], string | undefined> = {
  out: undefined,
  err: "m3-term-err",
  in: "m3-term-in",
};

export default function Terminal({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();

  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [input, setInput] = useState("");
  const [blocked, setBlocked] = useState<string | null>(null);

  const cursor = useRef(0);
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`${apiBase}/api/terminal`);
      if (res.status === 403) {
        // The loopback gate. Show the server's own reason rather than inventing one.
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (!cancelled) setBlocked(body?.error ?? t("terminal.blocked"));
        return;
      }
      const data = await readJsonIfOk<{ presets?: Preset[] }>(res);
      if (!cancelled) setPresets(data?.presets ?? null);
    })();
    return () => { cancelled = true; };
  }, [apiBase, t]);

  // Poll the live session for new output.
  useEffect(() => {
    if (!session || session.state !== "running") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        const res = await fetch(
          `${apiBase}/api/terminal/${encodeURIComponent(session.id)}?since=${cursor.current}`,
        );
        const data = await readJsonIfOk<{ session?: SessionView; chunks?: Chunk[]; cursor?: number }>(res);
        if (cancelled || !data?.session) return;
        cursor.current = data.cursor ?? cursor.current;
        if (data.chunks?.length) setChunks(prev => [...prev, ...data.chunks!].slice(-1200));
        setSession(data.session);
      })();
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [apiBase, session]);

  // Follow the tail as output arrives.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  const start = useCallback(async (preset: Preset) => {
    const res = await fetch(`${apiBase}/api/terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: preset.id }),
    });
    const body = await res.json().catch(() => null) as
      { ok?: boolean; session?: SessionView; error?: string } | null;
    if (!body?.ok || !body.session) {
      notify({ tone: "error", title: t("terminal.startFailed", { label: preset.label }), body: body?.error });
      return;
    }
    cursor.current = 0;
    setChunks([]);
    setSession(body.session);
  }, [apiBase, notify, t]);

  const send = useCallback(async (line: string) => {
    if (!session) return;
    // No local echo: the server records what it actually wrote as an `in` chunk,
    // so the sent line keeps its true position in the stream and is still there
    // after a reload.
    const res = await fetch(`${apiBase}/api/terminal/${encodeURIComponent(session.id)}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: `${line}\n` }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!body?.ok) notify({ tone: "error", title: t("terminal.writeFailed"), body: body?.error });
  }, [apiBase, notify, session, t]);

  const stop = useCallback(async () => {
    if (!session) return;
    await fetch(`${apiBase}/api/terminal/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  }, [apiBase, session]);

  if (blocked) {
    return (
      <Card title={t("terminal.title")} subtitle={t("terminal.subtitle")}>
        <Empty title={t("terminal.blockedTitle")}>{blocked}</Empty>
      </Card>
    );
  }

  return (
    <Card title={t("terminal.title")} subtitle={t("terminal.subtitle")}>
      <div className="m3-term-presets">
        {(presets ?? []).map(preset => (
          <Button
            key={preset.id}
            variant={session?.presetId === preset.id ? "filled" : "tonal"}
            onClick={() => void start(preset)}
            title={preset.fullScreen ? t("terminal.fullScreenWarn") : undefined}
          >
            {preset.label}
          </Button>
        ))}
        {session?.state === "running" && (
          <Button variant="text" onClick={() => void stop()}>{t("terminal.stop")}</Button>
        )}
      </div>

      {session?.fullScreen && (
        <p className="m3-term-warn" role="note">{t("terminal.fullScreenWarn")}</p>
      )}

      {!session ? (
        <Empty title={t("terminal.idleTitle")}>{t("terminal.idleBody")}</Empty>
      ) : (
        <>
          <pre
            ref={scroller}
            className="m3-term-out"
            role="log"
            aria-live="polite"
            aria-label={t("terminal.transcript", { label: session.label })}
            tabIndex={0}
          >
            {chunks.map((chunk, i) => (
              <span key={`${chunk.seq}-${i}`} className={CHUNK_CLASS[chunk.stream]}>
                {chunk.text}
              </span>
            ))}
          </pre>

          <form
            className="m3-term-input"
            onSubmit={event => {
              event.preventDefault();
              const line = input;
              if (!line.trim()) return;
              setInput("");
              void send(line);
            }}
          >
            <label className="m3-visually-hidden" htmlFor="m3-term-line">{t("terminal.inputLabel")}</label>
            <input
              id="m3-term-line"
              value={input}
              onChange={event => setInput(event.target.value)}
              disabled={session.state !== "running"}
              placeholder={session.state === "running" ? t("terminal.inputPlaceholder") : t("terminal.exited")}
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="tonal" disabled={session.state !== "running"}>
              {t("terminal.send")}
            </Button>
          </form>
        </>
      )}
    </Card>
  );
}
