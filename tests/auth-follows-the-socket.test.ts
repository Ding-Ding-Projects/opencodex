/**
 * Data-plane auth must follow the socket, not the config that will apply next start.
 *
 * `PUT /api/host { exposed: false }` writes `config.hostname = "127.0.0.1"` on
 * the live config object and answers `restartRequired: true` — the listening
 * socket stays on `0.0.0.0` until the proxy is restarted, which the dashboard
 * says plainly ("the socket is still bound where it was").
 *
 * `isApiAuthRequired` read `config.hostname` alone, so it flipped to false the
 * instant remote access was switched **off**. `hasValidApiAuth` short-circuits
 * to `true` when auth is not required, so for the whole window between that
 * toggle and a restart, every device on the network could call `/v1/*` with no
 * credential at all.
 *
 * The action that exists to make the proxy more private was the one that
 * removed its authentication. These pin both transitions, because only one of
 * the two orders is dangerous and a fix that got the other one wrong would look
 * just as green.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { hasValidApiAuth, isApiAuthRequired } from "../src/server/auth-cors";
import { setServerRef } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";

/**
 * Pretend the server is listening on `hostname`, or on nothing at all.
 *
 * Through `setServerRef`, the seam the process itself uses, rather than by
 * patching the module namespace — which Bun refuses, and which would have tested
 * a stand-in for the exact lookup under examination.
 */
function listeningOn(hostname: string | undefined) {
  setServerRef(hostname === undefined
    ? undefined
    : ({ hostname } as unknown as ReturnType<typeof Bun.serve>));
}

afterEach(() => setServerRef(undefined));

const config = (hostname: string): OcxConfig =>
  ({ hostname, apiKeys: [{ name: "lan", key: "secret-key" }] }) as unknown as OcxConfig;

const anonymous = () => new Request("http://192.168.1.50:10100/v1/models");

describe("while the socket is still exposed", () => {
  test("turning remote access off does NOT drop authentication", () => {
    listeningOn("0.0.0.0");
    // This is the exact post-toggle state: config says loopback, socket does not.
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(true);
  });

  test("an anonymous LAN request is still refused in that window", () => {
    listeningOn("0.0.0.0");
    expect(hasValidApiAuth(anonymous(), config("127.0.0.1"))).toBe(false);
  });

  test("and a request carrying the key is still accepted", () => {
    // A fix that simply always required auth would pass the test above and
    // strand every paired device. It has to keep working for the credential.
    listeningOn("0.0.0.0");
    const req = new Request("http://192.168.1.50:10100/v1/models", {
      headers: { authorization: "Bearer secret-key" },
    });
    expect(hasValidApiAuth(req, config("127.0.0.1"))).toBe(true);
  });
});

describe("the other transitions are unchanged", () => {
  test("enabling remote access demands a credential immediately", () => {
    // Config already moved, socket has not. Stricter is the safe direction, and
    // the route mints a key before writing this, so nothing is stranded.
    listeningOn("127.0.0.1");
    expect(isApiAuthRequired(config("0.0.0.0"))).toBe(true);
  });

  test("an ordinary loopback proxy needs no credential", () => {
    listeningOn("127.0.0.1");
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(false);
    expect(hasValidApiAuth(anonymous(), config("127.0.0.1"))).toBe(true);
  });

  test("localhost and ::1 count as loopback, as they always did", () => {
    for (const host of ["localhost", "::1", "[::1]", "localhost."]) {
      listeningOn(host);
      expect({ host, required: isApiAuthRequired(config("127.0.0.1")) })
        .toEqual({ host, required: false });
    }
  });

  test("before the server is listening, the config alone decides", () => {
    // `getServerListenHostname` is undefined until the socket is up. That is
    // "unknown", and the CLI and the tests run entirely in it.
    listeningOn(undefined);
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(false);
    expect(isApiAuthRequired(config("0.0.0.0"))).toBe(true);
  });
});
