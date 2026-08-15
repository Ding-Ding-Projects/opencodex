/**
 * B3 security port #3 (upstream 18-commit redact.ts arc, ending 7336b54e — adopted as
 * "merge the intent", not a wholesale replacement of this fork's simpler module).
 *
 * The survey confirmed two concrete leak shapes this fork's ~105-line flat pattern list
 * missed, both of which are realistic: an upstream provider's 4xx body frequently quotes
 * the offending header back at the caller, and ordinary JSON serialization of a headers
 * object puts the credential in a quoted field.
 *
 *   1. Colon-labelled, not `key=value`:      x-api-key: <secret>
 *   2. Quoted-JSON, key not in the old list: {"x-api-key":"<secret>"}
 *
 * This file pins exactly those two shapes (upstream e1edd4ef / 0e29a1b3f), plus the two
 * follow-up hardenings upstream needed within the SAME review to make the colon rule safe
 * rather than merely present (30360ea60 — mask the whole delimiter-bearing value, not a
 * token stopped at the first quote/space/semicolon; 1bf8f3409 — close the "prefix it with
 * Bearer" smuggling hole the first Bearer carve-out opened). Porting the leak-shape fix
 * without its own smuggling closure would ship a redactor with a known, named bypass,
 * which is worse than not shipping it — hence porting the whole small arc together.
 *
 * Every "secret" below is an obvious sentinel string, never a real credential shape.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED_SECRET, redactSecretString } from "../src/lib/redact";

describe("colon-labelled credential leaks (survey shape #1)", () => {
  test("masks colon-labelled credentials echoed back by an upstream error", () => {
    const input = [
      "x-api-key: SENTINEL-colon-cred-one",
      "X-Goog-Api-Key: SENTINEL-colon-cred-two",
      "client_secret: SENTINEL-not-sk-shaped",
      "token: SENTINEL-opaque-session",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`x-api-key: ${REDACTED_SECRET}`);
    expect(redacted).toContain(`X-Goog-Api-Key: ${REDACTED_SECRET}`);
    expect(redacted).not.toContain("SENTINEL-colon-cred-one");
    expect(redacted).not.toContain("SENTINEL-colon-cred-two");
    expect(redacted).not.toContain("SENTINEL-not-sk-shaped");
    expect(redacted).not.toContain("SENTINEL-opaque-session");
  });

  test("leaves non-credential colon labels readable (no over-redaction)", () => {
    expect(redactSecretString("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123"))
      .toBe("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123");
  });

  test("masks the WHOLE value, including quote/space/semicolon-bearing forms", () => {
    // The naive fix tokenizes on quotes/spaces/semicolons and leaks anything containing
    // one. A credential header's value is the rest of the line.
    expect(redactSecretString('x-api-key: "SENTINEL-quoted-cred"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Basic U0VOVElORUwtYmFzaWMtcGF5bG9hZA=="))
      .toBe(`Authorization: ${REDACTED_SECRET}`);
    expect(redactSecretString("Cookie: session=SENTINEL-one; csrf=SENTINEL-two"))
      .toBe(`Cookie: ${REDACTED_SECRET}`);
  });

  test("keeps the Bearer scheme readable while masking its token", () => {
    expect(redactSecretString("Authorization: Bearer SENTINEL-bearer-1234"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("the Bearer carve-out cannot be used to smuggle a credential past the rule", () => {
    // Exempting the bare scheme word (instead of only the already-sanitized result) would
    // let anything the dedicated Bearer rule cannot parse — quoted, punctuation-bearing, or
    // under its length floor — pass through untouched merely by being prefixed "Bearer".
    expect(redactSecretString('x-api-key: Bearer "SENTINEL-smuggled-cred"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer custom:SENTINEL-cred-punct"))
      .toBe(`Authorization: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: Bearer short"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
  });

  test("masks each credential line independently without eating the next line", () => {
    expect(redactSecretString("x-api-key: SENTINEL-one\nmodel: gpt-5.5\ncookie: SENTINEL-two"))
      .toBe(`x-api-key: ${REDACTED_SECRET}\nmodel: gpt-5.5\ncookie: ${REDACTED_SECRET}`);
  });
});

describe("quoted-JSON credential leaks (survey shape #2)", () => {
  test("a serialized headers object does not hide the credential behind an unlisted key", () => {
    // The fork's pre-existing quoted-field pattern listed only a handful of bare key
    // names (apiKey, accessToken, ...) and never matched the hyphenated header-style
    // spellings a real headers object actually serializes under.
    expect(redactSecretString('request headers: {"x-api-key":"SENTINEL-json-cred-one"}'))
      .toBe(`request headers: {"x-api-key":"${REDACTED_SECRET}"}`);
    expect(redactSecretString('headers={"authorization":"SENTINEL-json-cred-two"}'))
      .toBe(`headers={"authorization":"${REDACTED_SECRET}"}`);
    expect(redactSecretString('headers={"cookie":"session=SENTINEL-json-cred-three"}'))
      .toBe(`headers={"cookie":"${REDACTED_SECRET}"}`);
    expect(redactSecretString('"x-goog-api-key" : "SENTINEL-json-cred-four"'))
      .toBe(`"x-goog-api-key" : "${REDACTED_SECRET}"`);
  });

  test("a quoted value's sibling fields survive (does not swallow the closing brace)", () => {
    expect(redactSecretString('{"x-api-key":"SENTINEL-json-cred-five","model":"gpt-5.5"}'))
      .toBe(`{"x-api-key":"${REDACTED_SECRET}","model":"gpt-5.5"}`);
  });
});
