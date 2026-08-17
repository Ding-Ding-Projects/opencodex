/**
 * Live camera QR scanning for the add-account flow.
 *
 * Opens exactly one `getUserMedia` video stream, feeds frames to
 * `decodeQrFromVideoFrame` on a `requestAnimationFrame` loop, and reports the
 * first decoded value. The stream is stopped — every track — on a decode, on
 * "Stop", and on unmount; there is no route that leaves a camera light on
 * after this component is gone.
 */

import { useEffect, useRef, useState } from "react";
import { Banner, Button } from "../../shell/m3-ui";
import { decodeQrFromVideoFrame } from "../../lib/qr-decode";
import { useT } from "../../i18n/shared";

export interface AuthenticatorCameraScannerProps {
  onDecoded: (value: string) => void;
  onCancel: () => void;
}

export default function AuthenticatorCameraScanner({ onDecoded, onCancel }: AuthenticatorCameraScannerProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decodedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    };

    const loop = async () => {
      if (cancelled || decodedRef.current || !videoRef.current) return;
      const value = await decodeQrFromVideoFrame(videoRef.current);
      if (cancelled || decodedRef.current) return;
      if (value) {
        decodedRef.current = true;
        stop();
        onDecoded(value);
        return;
      }
      rafRef.current = requestAnimationFrame(() => { void loop(); });
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        rafRef.current = requestAnimationFrame(() => { void loop(); });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="m3-authenticator-camera">
      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : (
        // No captions are meaningful for a live camera preview; it is a
        // real-time control surface, not media content.
        <video ref={videoRef} className="m3-authenticator-camera-video" muted playsInline aria-label={t("auth.add.scanCameraOpen")} />
      )}
      <Button variant="outlined" onClick={onCancel}>{t("auth.add.scanCameraStop")}</Button>
    </div>
  );
}
