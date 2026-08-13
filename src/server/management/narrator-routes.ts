/**
 * `GET /api/narrator/edge-voices` and `POST /api/narrator/edge-speak`.
 *
 * The narrator's Edge voices reach the renderer through here rather than being
 * fetched by the page directly, for two reasons that both matter.
 *
 * The dashboard's CSP is `connect-src 'self'`, so the renderer cannot reach
 * `speech.platform.bing.com` at all — and widening that to let it would open the
 * page to a third-party origin for the sake of one feature, which is a far worse
 * trade than proxying two routes. The endpoint also needs a specific
 * `User-Agent`/`Origin` pair that a browser will not let a page set, so the call
 * has to happen somewhere with real control over its headers regardless.
 *
 * Nothing here is enabled by default. The renderer only calls these routes after
 * the user has explicitly turned the Edge source on, having been told that the
 * narrated text leaves the machine.
 */

import { jsonResponse } from "../auth-cors";
import { EDGE_TEXT_MAX, listEdgeVoices, synthesizeEdgeSpeech } from "./narrator-tts";
import type { ManagementContext } from "./context";

/** Mirrors the picker's own bounds; a request outside them is a bug, not input. */
function clampMultiplier(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1;
}

export async function handleNarratorRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  /* ------------------------------------------------------------ catalogue */

  if (url.pathname === "/api/narrator/edge-voices" && req.method === "GET") {
    try {
      return jsonResponse({ available: true, voices: await listEdgeVoices() }, 200, req, config);
    } catch (error) {
      // 200 with `available: false`, not a 5xx. The surface has to *say* the
      // service is unreachable and fall back to a local voice; a failed request
      // that reads as a broken dashboard would send the user looking for the
      // wrong problem. The reason is scalar text with no path or token in it.
      return jsonResponse(
        { available: false, voices: [], error: error instanceof Error ? error.message : "unavailable" },
        200, req, config,
      );
    }
  }

  /* ------------------------------------------------------------ synthesis */

  if (url.pathname === "/api/narrator/edge-speak" && req.method === "POST") {
    let body: { text?: unknown; voice?: unknown; rate?: unknown; pitch?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "malformed request body" }, 400, req, config);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voice = typeof body.voice === "string" ? body.voice : "";
    if (!text || !voice) return jsonResponse({ error: "text and voice are required" }, 400, req, config);
    if (text.length > EDGE_TEXT_MAX) {
      return jsonResponse({ error: `text exceeds ${EDGE_TEXT_MAX} characters` }, 413, req, config);
    }

    try {
      const audio = await synthesizeEdgeSpeech({
        text,
        voice,
        rate: clampMultiplier(body.rate),
        pitch: clampMultiplier(body.pitch),
        // A superseded utterance aborts its fetch in the renderer; that closes
        // this request, which closes the upstream socket rather than leaving it
        // transferring audio nobody will hear.
        signal: req.signal,
      });
      // The underlying buffer, not the view. `synthesizeEdgeSpeech` allocates a
      // fresh exactly-sized `Uint8Array`, so the two describe the same bytes —
      // and `BodyInit` does not accept a typed-array view under this lib target.
      return new Response(audio.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audio.byteLength),
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "synthesis failed";
      // A cancelled request is the expected outcome of superseding, not a fault.
      const status = message === "cancelled" ? 499 : 502;
      return jsonResponse({ error: message }, status, req, config);
    }
  }

  return null;
}
