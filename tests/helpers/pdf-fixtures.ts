/** Deterministic PDF byte fixtures shared by the pdf-tools test files. */
import { PDFDocument, degrees } from "pdf-lib";

/** A real, valid PDF with the given page sizes (points), optionally titled. */
export async function makePdf(
  pageSizes: Array<[number, number]> = [[200, 300]],
  opts?: { title?: string; author?: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (opts?.title !== undefined) doc.setTitle(opts.title);
  if (opts?.author !== undefined) doc.setAuthor(opts.author);
  for (const [w, h] of pageSizes) doc.addPage([w, h]);
  return doc.save();
}

/** A real PDF whose page N has the given rotation set (0/90/180/270), 1-based. */
export async function makeRotatedPdf(rotations: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rotation of rotations) {
    const page = doc.addPage([150, 200]);
    page.setRotation(degrees(rotation));
  }
  return doc.save();
}

/**
 * Not a PDF at all — no `%PDF-` header. Plain text, long enough that it is
 * obviously not a truncated header.
 */
export function notAPdfBytes(): Uint8Array {
  return new TextEncoder().encode(
    "This is an ordinary text file. It has nothing to do with the Portable Document Format, " +
    "and it is well past eight bytes long so the size check does not short-circuit it.",
  );
}

/**
 * Has a `%PDF-` header and a `%%EOF` trailer (so it survives the cheap byte
 * sniff) but a body of structured noise that pdf-lib's parser cannot make
 * sense of. Distinct from `notAPdfBytes` — this exercises the "malformed"
 * boundary, not "not-a-pdf".
 */
export function malformedPdfBytes(): Uint8Array {
  const head = new TextEncoder().encode("%PDF-1.4\n");
  const tail = new TextEncoder().encode("\n%%EOF");
  const noise = new Uint8Array(2000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) % 256;
  const out = new Uint8Array(head.length + noise.length + tail.length);
  out.set(head, 0);
  out.set(noise, head.length);
  out.set(tail, head.length + noise.length);
  return out;
}

/** A hand-built trailer whose `/Encrypt` entry makes `PDFDocument.load` refuse it. */
export function encryptedPdfBytes(): Uint8Array {
  const pdf = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>",
    "endobj",
    "4 0 obj",
    "<< /Filter /Standard /V 1 /R 2 /O (ownerpwdxxxxxxxxxxxxxxxxxxxxxxxxx) /U (userpwdxxxxxxxxxxxxxxxxxxxxxxxxx) /P -4 >>",
    "endobj",
    "trailer",
    "<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<00000000000000000000000000000000> <00000000000000000000000000000000>] >>",
    "%%EOF",
  ].join("\n");
  return new TextEncoder().encode(pdf);
}

/**
 * A real, valid, loadable one-page PDF that also carries the byte-level
 * markers `hasSignatureMarkers` looks for, appended after the document's own
 * `%%EOF` so the xref byte offsets pdf-lib already computed stay correct.
 */
export async function signedLookingPdfBytes(): Promise<Uint8Array> {
  const base = await makePdf([[120, 160]], { title: "Signed-looking fixture" });
  const marker = new TextEncoder().encode("\n% /ByteRange[0 1 2 3] /Type /Sig\n");
  const out = new Uint8Array(base.length + marker.length);
  out.set(base, 0);
  out.set(marker, base.length);
  return out;
}

/** `count` bytes of harmless filler, for bounds tests — not a PDF at all. */
export function fillerBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  out.fill(0x41);
  return out;
}
