/**
 * The live code for one authenticator entry: current code, next code, and a
 * countdown, kept correct without polling the network every second.
 *
 * The server computes every code (it holds the secret); this hook fetches
 * once, then schedules exactly one more fetch for the moment the code is due
 * to roll over — derived from the server's own `periodEnd`, not from a blind
 * `setInterval` guess. A second, purely local 1-second tick drives the visible
 * countdown number between fetches; it touches no network and exists only so
 * the UI does not sit still between rollovers.
 *
 * `skewMs` is `serverTime - Date.now()` measured at the last successful fetch.
 * It is the one honest clock signal available with no network call: when this
 * screen is opened from a paired phone whose clock disagrees with the machine
 * generating the codes, it says so, and it says nothing wrong on the ordinary
 * desktop case where both clocks are the same OS clock.
 */

import { useEffect, useRef, useState } from "react";
import { fetchLiveCode, type LiveCode } from "./authenticator-api";

export interface AuthenticatorCodeState {
  code: string | null;
  nextCode: string | null;
  digits: number;
  period: number;
  /** Recomputed once per second from the last fetch's anchor, not from the network. */
  secondsRemaining: number;
  /** `serverTime - Date.now()` at the last successful fetch. */
  skewMs: number;
  loading: boolean;
  failed: boolean;
}

const INITIAL: AuthenticatorCodeState = {
  code: null, nextCode: null, digits: 6, period: 30, secondsRemaining: 0, skewMs: 0, loading: true, failed: false,
};

export function useAuthenticatorCode(apiBase: string, entryId: string): AuthenticatorCodeState {
  const [state, setState] = useState<AuthenticatorCodeState>(INITIAL);
  const anchorRef = useRef<{ periodEnd: number; clientNow: number } | null>(null);
  const rolloverTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof window.setInterval> | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    const controller = new AbortController();

    const clearRollover = () => {
      if (rolloverTimerRef.current !== null) { window.clearTimeout(rolloverTimerRef.current); rolloverTimerRef.current = null; }
    };

    const load = async () => {
      try {
        const data: LiveCode = await fetchLiveCode(apiBase, entryId, controller.signal);
        if (cancelled || generationRef.current !== generation) return;
        const clientNow = Date.now();
        anchorRef.current = { periodEnd: data.periodEnd, clientNow };
        setState({
          code: data.code,
          nextCode: data.nextCode,
          digits: data.digits,
          period: data.period,
          secondsRemaining: data.secondsRemaining,
          skewMs: data.serverTime - clientNow,
          loading: false,
          failed: false,
        });
        clearRollover();
        // Fire slightly after the boundary, never before — a fetch issued one
        // tick early would still return the code that is about to expire.
        const delay = Math.max(250, data.secondsRemaining * 1000 + 300);
        rolloverTimerRef.current = window.setTimeout(() => { void load(); }, delay);
      } catch {
        if (cancelled || generationRef.current !== generation) return;
        setState(current => ({ ...current, loading: false, failed: true }));
        clearRollover();
        rolloverTimerRef.current = window.setTimeout(() => { void load(); }, 5000);
      }
    };

    void load();

    // Purely visual 1s tick: recompute the countdown from the anchor already
    // in hand. Never issues a fetch — the rollover timer above owns that.
    tickTimerRef.current = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const elapsedSinceAnchor = Date.now() - anchor.clientNow;
      const remaining = Math.max(0, Math.ceil((anchor.periodEnd - anchor.clientNow - elapsedSinceAnchor) / 1000));
      setState(current => (current.secondsRemaining === remaining ? current : { ...current, secondsRemaining: remaining }));
    }, 1000);

    return () => {
      cancelled = true;
      controller.abort();
      clearRollover();
      if (tickTimerRef.current !== null) { window.clearInterval(tickTimerRef.current); tickTimerRef.current = null; }
      anchorRef.current = null;
    };
  }, [apiBase, entryId]);

  return state;
}
