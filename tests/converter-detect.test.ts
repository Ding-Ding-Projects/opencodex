/**
 * `src/lib/converter/detect.ts` — byte-level format sniffing.
 *
 * Every case here is deliberately fed bytes that carry no filename or
 * content-type at all, because that is the whole point of the module: a
 * caller with only a `Uint8Array` and nothing else must still get an honest
 * answer, including "unrecognised" rather than a guess.
 */
import { describe, expect, test } from "bun:test";
import { sniffFormat } from "../src/lib/converter/detect";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string, ...extra: number[]): Uint8Array {
  return new Uint8Array([...Buffer.from(text, "latin1"), ...extra]);
}

describe("sniffFormat — binary magic numbers", () => {
  test("PDF: the %PDF- header", () => {
    const r = sniffFormat(ascii("%PDF-1.7\n%%EOF"));
    expect(r.formatId).toBe("pdf");
    expect(r.category).toBe("documents-pdf");
  });

  test("PNG: the 8-byte signature", () => {
    const r = sniffFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13));
    expect(r.formatId).toBe("png");
    expect(r.category).toBe("images");
  });

  test("JPEG: the SOI marker", () => {
    const r = sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0));
    expect(r.formatId).toBe("jpeg");
    expect(r.category).toBe("images");
  });

  test("GIF89a", () => {
    const r = sniffFormat(ascii("GIF89a"));
    expect(r.formatId).toBe("gif");
  });

  test("WEBP: RIFF....WEBP, not confused with WAV's RIFF....WAVE", () => {
    const r = sniffFormat(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]));
    expect(r.formatId).toBe("webp");
    expect(r.category).toBe("images");
  });

  test("WAV: RIFF....WAVE", () => {
    const r = sniffFormat(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]));
    expect(r.formatId).toBe("wav");
    expect(r.category).toBe("audio");
  });

  test("FLAC stream marker", () => {
    const r = sniffFormat(ascii("fLaC"));
    expect(r.formatId).toBe("flac");
  });

  test("Ogg page header", () => {
    const r = sniffFormat(ascii("OggS"));
    expect(r.formatId).toBe("ogg");
  });

  test("MP3: an ID3 tag", () => {
    const r = sniffFormat(ascii("ID3", 3, 0, 0));
    expect(r.formatId).toBe("mp3");
  });

  test("MP3: a raw MPEG frame sync with no ID3 tag", () => {
    const r = sniffFormat(bytes(0xff, 0xfb, 0x90, 0));
    expect(r.formatId).toBe("mp3");
  });

  test("MP4/MOV family: an ftyp box", () => {
    const r = sniffFormat(bytes(0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii("isom")));
    expect(r.formatId).toBe("mp4");
    expect(r.category).toBe("video");
  });

  test("WebM/Matroska: the EBML header", () => {
    const r = sniffFormat(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0));
    expect(r.formatId).toBe("webm");
  });

  test("7-Zip signature", () => {
    const r = sniffFormat(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0));
    expect(r.formatId).toBe("7z");
    expect(r.category).toBe("archives");
  });

  test("gzip magic bytes — checked before ZIP's PK signature since neither can be confused with the other", () => {
    const r = sniffFormat(bytes(0x1f, 0x8b, 0x08, 0));
    expect(r.formatId).toBe("gzip");
  });

  test("ZIP local-file-header signature", () => {
    const r = sniffFormat(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0));
    expect(r.formatId).toBe("zip");
  });

  test("tar: the ustar marker at byte 257", () => {
    const buf = new Uint8Array(300);
    buf.set(ascii("ustar"), 257);
    const r = sniffFormat(buf);
    expect(r.formatId).toBe("tar");
  });
});

describe("sniffFormat — structured text heuristics", () => {
  test("XML declaration", () => {
    const r = sniffFormat(ascii('<?xml version="1.0"?><root/>'));
    expect(r.formatId).toBe("xml");
    expect(r.category).toBe("structured-data");
  });

  test("HTML doctype", () => {
    const r = sniffFormat(ascii("<!DOCTYPE html><html><body>hi</body></html>"));
    expect(r.formatId).toBe("html");
    expect(r.category).toBe("code-text");
  });

  test("JSON is reported as consistent-with, never confirmed", () => {
    const r = sniffFormat(ascii('{"a": 1, "b": [1,2,3'));
    expect(r.formatId).toBe("json");
    expect(r.evidence).toContain("not confirmed");
  });

  test("a comma-delimited first line reads as CSV", () => {
    const r = sniffFormat(ascii("name,age,city\nAda,30,London\n"));
    expect(r.formatId).toBe("csv");
    expect(r.category).toBe("structured-data");
  });

  test("plain text with nothing recognisable stays unnamed rather than guessed", () => {
    const r = sniffFormat(ascii("just an ordinary sentence with no structure to it at all"));
    expect(r.formatId).toBeUndefined();
    expect(r.category).toBeUndefined();
    expect(r.evidence.length).toBeGreaterThan(0);
  });
});

describe("sniffFormat — genuinely unrecognisable input", () => {
  test("a NUL byte rules out every text heuristic", () => {
    const r = sniffFormat(bytes(1, 2, 0, 3, 4, 5, 6, 7));
    expect(r.formatId).toBeUndefined();
    expect(r.evidence).toContain("not printable text");
  });

  test("random non-text, non-magic bytes are reported unrecognised, not guessed", () => {
    const r = sniffFormat(bytes(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04));
    expect(r.formatId).toBeUndefined();
  });
});
