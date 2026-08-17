import { describe, expect, test } from "bun:test";
import { Base32DecodeError, base32Decode, base32Encode, groupBase32, isValidBase32 } from "../src/lib/base32";

describe("base32", () => {
  // RFC 4648 §10 test vectors.
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];

  for (const [plain, encoded] of vectors) {
    test(`encodes ${JSON.stringify(plain)}`, () => {
      expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded);
    });
    test(`decodes ${JSON.stringify(encoded)}`, () => {
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain);
    });
  }

  test("encode without padding drops trailing =", () => {
    expect(base32Encode(new TextEncoder().encode("foob"), { padding: false })).toBe("MZXW6YQ");
  });

  test("decode is case-insensitive and ignores whitespace, hyphens and padding", () => {
    const bytes = base32Decode("mz xw-6y tb");
    expect(new TextDecoder().decode(bytes)).toBe("fooba");
  });

  test("decode rejects an invalid character", () => {
    expect(() => base32Decode("MZXW6Y!B")).toThrow(Base32DecodeError);
  });

  test("isValidBase32", () => {
    expect(isValidBase32("MZXW6YTB")).toBe(true);
    expect(isValidBase32("")).toBe(false);
    expect(isValidBase32("not-base32!!")).toBe(false);
  });

  test("groupBase32 chunks into 4s", () => {
    expect(groupBase32("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });

  test("groupBase32 strips padding and existing separators before regrouping", () => {
    expect(groupBase32("mzxw6ytb")).toBe("MZXW 6YTB");
    expect(groupBase32("MZ XW-6Y TB==")).toBe("MZXW 6YTB");
  });

  test("round-trips random byte lengths 0-40", () => {
    for (let len = 0; len <= 40; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256;
      const roundTripped = base32Decode(base32Encode(bytes));
      expect([...roundTripped]).toEqual([...bytes]);
    }
  });
});
