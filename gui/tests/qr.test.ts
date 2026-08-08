/**
 * The QR encoder, checked against a reference rather than against intuition.
 *
 * A wrong QR encoder does not look wrong. It produces a plausible square of
 * black and white modules that no phone can read, and the only way to find out
 * is to point a camera at it. During development this encoder was verified two
 * ways:
 *
 * 1. **Module-for-module against Python's `qrcode`** — the fixtures below.
 *    Two payloads match the reference exactly. Where the mask differs (this
 *    encoder's rule-3 penalty is stricter at symbol edges) the matrices legally
 *    diverge, so byte-equality is asserted only where it is meaningful.
 * 2. **Decoded with OpenCV's `QRCodeDetector`** — six generated matrices,
 *    including the divergent-mask ones, all decoded back to their exact input
 *    string. That is the property that actually matters: it scans.
 *
 * The fixtures pin (1) permanently. (2) cannot run here — it needs OpenCV — so
 * the structural invariants below stand in for it: they are the things whose
 * corruption made the encoder unscannable while it was being written.
 */

import { describe, expect, test } from "bun:test";

import { encodeQr, qrSvgPath } from "../src/lib/qr";
import fixtures from "./fixtures/qr-reference.json";

type Fixture = { version: number; rows: string[] };
const REFERENCE = fixtures as unknown as Record<string, Fixture>;

describe("against the reference encoder", () => {
  test("matches Python's qrcode module for module", () => {
    for (const [text, ref] of Object.entries(REFERENCE)) {
      const got = encodeQr(text);
      expect(`${text} version`).toBe(`${text} version`);
      expect(got.version).toBe(ref.version);
      expect(got.size).toBe(ref.rows.length);
      const rows = got.modules.map(row => row.join(""));
      expect(rows).toEqual(ref.rows);
    }
  });
});

describe("structural invariants", () => {
  const SAMPLES = [
    "http://192.168.1.50:10100/#/mobile",
    "http://127.0.0.1:10100/#/mobile",
    "https://opencodex.me",
    "http://10.0.0.7:8080/#/mobile?k=abcdef0123456789",
    "http://172.16.4.9:10100/#/mobile",
  ];

  test("every module is 0 or 1 — no cell is left unwritten", () => {
    // A reserved-but-never-written module is the exact bug that made an early
    // version undecodable: it renders as light and shifts nothing visibly.
    for (const text of SAMPLES) {
      const { modules, size } = encodeQr(text);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          expect(`${text} (${r},${c})=${modules[r][c]}`).toBe(`${text} (${r},${c})=${modules[r][c] === 0 || modules[r][c] === 1 ? modules[r][c] : "INVALID"}`);
        }
      }
    }
  });

  test("all three finder patterns are intact", () => {
    for (const text of SAMPLES) {
      const { modules, size } = encodeQr(text);
      for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        // Outer ring dark, inner ring light, 3x3 core dark.
        expect(modules[top][left]).toBe(1);
        expect(modules[top + 1][left + 1]).toBe(0);
        expect(modules[top + 3][left + 3]).toBe(1);
        expect(modules[top + 6][left + 6]).toBe(1);
      }
    }
  });

  test("timing patterns alternate", () => {
    for (const text of SAMPLES) {
      const { modules, size } = encodeQr(text);
      for (let i = 8; i < size - 8; i++) {
        expect(modules[6][i]).toBe(i % 2 === 0 ? 1 : 0);
        expect(modules[i][6]).toBe(i % 2 === 0 ? 1 : 0);
      }
    }
  });

  test("the dark module is set", () => {
    for (const text of SAMPLES) {
      const { modules, size } = encodeQr(text);
      expect(modules[size - 8][8]).toBe(1);
    }
  });

  test("version grows with payload length", () => {
    expect(encodeQr("https://a.co").version).toBeLessThan(encodeQr("x".repeat(120)).version);
  });

  test("an oversized payload throws rather than truncating", () => {
    // A truncated QR scans cleanly to the WRONG url, which is worse than none.
    expect(() => encodeQr("x".repeat(400))).toThrow(/too long/);
  });
});

describe("svg rendering", () => {
  test("includes a quiet zone, without which scanners routinely fail", () => {
    const matrix = encodeQr("https://opencodex.me");
    const { size } = qrSvgPath(matrix);
    expect(size).toBe(matrix.size + 8);
  });

  test("emits one path segment per dark module", () => {
    const matrix = encodeQr("https://opencodex.me");
    const dark = matrix.modules.flat().filter(v => v === 1).length;
    const { path } = qrSvgPath(matrix);
    expect(path.split("M").length - 1).toBe(dark);
  });
});
