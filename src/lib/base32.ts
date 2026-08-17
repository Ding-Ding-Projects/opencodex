/**
 * RFC 4648 base32 (the plain alphabet, not base32hex) — encode and decode.
 *
 * TOTP secrets are conventionally shown and typed as base32: it is case-
 * insensitive, has no visually ambiguous punctuation, and every authenticator
 * app on every platform already expects it. Written here rather than pulled in
 * as a dependency for the same reason `gui/src/lib/qr.ts` is hand-written — it
 * is ~40 lines of a fully specified algorithm, and a dependency would be a
 * supply-chain surface for something this small and this security-sensitive.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALPHABET_INDEX = new Map<string, number>([...ALPHABET].map((ch, i) => [ch, i]));

/** Encode raw bytes as base32. `=` padding is included by default (RFC 4648 §6). */
export function base32Encode(bytes: Uint8Array, options: { padding?: boolean } = {}): string {
  const { padding = true } = options;
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 0x1f];
  if (padding) while (output.length % 8 !== 0) output += "=";
  return output;
}

export class Base32DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base32DecodeError";
  }
}

/**
 * Decode base32 to raw bytes. Case-insensitive; whitespace, hyphens and `=`
 * padding are ignored (people paste secrets with grouping spaces or dashes
 * exactly as this app displays them, and an authenticator that refuses to read
 * its own formatting back is not a real acceptance path).
 */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET_INDEX.get(ch);
    if (idx === undefined) throw new Base32DecodeError(`invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** True iff `input` decodes cleanly as base32 (used for form validation, not just try/catch at call sites). */
export function isValidBase32(input: string): boolean {
  try {
    base32Decode(input);
    return input.replace(/[\s=-]/g, "").length > 0;
  } catch {
    return false;
  }
}

/**
 * Group a base32 string into 4-character chunks separated by spaces —
 * `JBSWY3DPEHPK3PXP` becomes `JBSW Y3DP EHPK 3PXP`. This is the conventional
 * presentation for a manually-typed secret; grouping does not change what
 * `base32Decode` accepts, since it strips whitespace.
 */
export function groupBase32(secret: string, groupSize = 4): string {
  const clean = secret.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += groupSize) groups.push(clean.slice(i, i + groupSize));
  return groups.join(" ");
}
