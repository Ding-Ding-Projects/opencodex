/**
 * A QR matrix as inline SVG.
 *
 * Inline rather than an image: no network fetch, no third-party generator
 * service, and the code stays crisp at any size. The URL being encoded is a LAN
 * address for this machine — handing it to a public QR API would publish the
 * user's internal network layout to a third party for no benefit.
 *
 * A failed encode renders nothing rather than a broken box. The caller always
 * shows the URL in text beside this, so losing the QR costs convenience, not
 * access.
 */

import { useMemo } from "react";

import { encodeQr, qrSvgPath } from "../lib/qr";

export default function QrCode({ text, label, size = 148 }: { text: string; label: string; size?: number }) {
  const svg = useMemo(() => {
    try {
      return qrSvgPath(encodeQr(text));
    } catch {
      // Payload too long for the supported versions. The text link still works.
      return null;
    }
  }, [text]);

  if (!svg) return null;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${svg.size} ${svg.size}`}
      width={size}
      height={size}
      // A quiet zone is only quiet against a light background, and scanners
      // read dark-on-light. This deliberately does not follow the theme.
      style={{ background: "#fff", borderRadius: "var(--r-s, 8px)", display: "block" }}
      shapeRendering="crispEdges"
    >
      <path d={svg.path} fill="#000" />
    </svg>
  );
}
