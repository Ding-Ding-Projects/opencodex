import { describe, expect, test } from "bun:test";
import { OtpauthUriError, buildOtpauthUri, parseOtpauthUri } from "../src/lib/otpauth-uri";

describe("buildOtpauthUri", () => {
  test("builds a canonical URI with issuer", () => {
    const uri = buildOtpauthUri({
      issuer: "Example",
      account: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(uri).toBe(
      "otpauth://totp/Example%3Aalice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30",
    );
  });

  test("omits the issuer prefix and query param when issuer is blank", () => {
    const uri = buildOtpauthUri({
      issuer: "",
      account: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(uri).toContain("otpauth://totp/alice%40example.com?");
    expect(uri).not.toContain("issuer=");
  });

  test("uppercases and strips whitespace/padding from the secret", () => {
    const uri = buildOtpauthUri({
      issuer: "X",
      account: "a",
      secret: "jbsw y3dp ehpk 3pxp",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });

  test("throws on an invalid secret", () => {
    expect(() =>
      buildOtpauthUri({ issuer: "X", account: "a", secret: "not-base32!!", algorithm: "SHA1", digits: 6, period: 30 }),
    ).toThrow(OtpauthUriError);
  });

  test("throws on a missing account", () => {
    expect(() =>
      buildOtpauthUri({ issuer: "X", account: "  ", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 }),
    ).toThrow(OtpauthUriError);
  });
});

describe("parseOtpauthUri", () => {
  test("parses issuer:account label plus all query parameters", () => {
    const parsed = parseOtpauthUri(
      "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60",
    );
    expect(parsed).toEqual({
      issuer: "Example",
      account: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA256",
      digits: 8,
      period: 60,
    });
  });

  test("defaults algorithm/digits/period when absent", () => {
    const parsed = parseOtpauthUri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP");
    expect(parsed.algorithm).toBe("SHA1");
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
    expect(parsed.issuer).toBe("");
  });

  test("falls back to the label's issuer when no query issuer is present", () => {
    const parsed = parseOtpauthUri("otpauth://totp/GitHub:bob?secret=JBSWY3DPEHPK3PXP");
    expect(parsed.issuer).toBe("GitHub");
    expect(parsed.account).toBe("bob");
  });

  test("the query issuer wins over a disagreeing label issuer", () => {
    const parsed = parseOtpauthUri("otpauth://totp/LabelIssuer:bob?secret=JBSWY3DPEHPK3PXP&issuer=QueryIssuer");
    expect(parsed.issuer).toBe("QueryIssuer");
  });

  test("round-trips through buildOtpauthUri", () => {
    const original = {
      issuer: "My Service",
      account: "user@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA512" as const,
      digits: 7,
      period: 45,
    };
    const uri = buildOtpauthUri(original);
    const parsed = parseOtpauthUri(uri);
    expect(parsed).toEqual(original);
  });

  test("rejects a non-otpauth protocol", () => {
    expect(() => parseOtpauthUri("https://example.com/totp?secret=X")).toThrow(OtpauthUriError);
  });

  test("rejects hotp with a clear message, distinct from an unsupported type", () => {
    expect(() => parseOtpauthUri("otpauth://hotp/a?secret=JBSWY3DPEHPK3PXP&counter=0")).toThrow(/HOTP/);
  });

  test("rejects an unsupported otpauth type", () => {
    expect(() => parseOtpauthUri("otpauth://carrierpigeon/a?secret=JBSWY3DPEHPK3PXP")).toThrow(OtpauthUriError);
  });

  test("rejects a missing secret", () => {
    expect(() => parseOtpauthUri("otpauth://totp/alice")).toThrow(OtpauthUriError);
  });

  test("rejects an invalid base32 secret", () => {
    expect(() => parseOtpauthUri("otpauth://totp/alice?secret=not-valid-base32!!")).toThrow(OtpauthUriError);
  });

  test("rejects an out-of-range digits value", () => {
    expect(() => parseOtpauthUri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP&digits=12")).toThrow(OtpauthUriError);
  });

  test("rejects a non-positive period", () => {
    expect(() => parseOtpauthUri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP&period=0")).toThrow(OtpauthUriError);
  });

  test("rejects an unsupported algorithm", () => {
    expect(() => parseOtpauthUri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toThrow(OtpauthUriError);
  });

  test("rejects garbage input rather than throwing an unlabeled parse error", () => {
    expect(() => parseOtpauthUri("not a uri at all")).toThrow(OtpauthUriError);
  });

  test("account containing a colon keeps everything after the first colon", () => {
    const parsed = parseOtpauthUri("otpauth://totp/Issuer:account:with:colons?secret=JBSWY3DPEHPK3PXP");
    expect(parsed.issuer).toBe("Issuer");
    expect(parsed.account).toBe("account:with:colons");
  });
});
