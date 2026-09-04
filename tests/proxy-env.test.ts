import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyProxyEnv, ConfiguredProxyReferenceError } from "../src/config";
import { mergeNoProxyEntries, proxyEnvironment } from "../src/lib/proxy-env";
import type { OcxConfig } from "../src/types";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "OCX_TEST_PROXY_REF"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PROXY_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configWithProxy(proxy?: string): OcxConfig {
  return { proxy, providers: {} } as unknown as OcxConfig;
}

describe("applyProxyEnv", () => {
  test("no-op when config.proxy is unset", () => {
    applyProxyEnv(configWithProxy(undefined));
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBeUndefined();
  });

  test("mirrors config.proxy into HTTP(S)_PROXY and excludes loopback (IPv4 + IPv6)", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("user-set env vars win over config", () => {
    process.env.HTTPS_PROXY = "http://user-proxy:3128";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTPS_PROXY).toBe("http://user-proxy:3128");
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
  });

  test("appends loopback entries to an existing NO_PROXY without duplicating", () => {
    process.env.NO_PROXY = "internal.corp,localhost";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("internal.corp,localhost,127.0.0.1,::1,[::1]");
  });

  test("dedup is case-insensitive against existing entries", () => {
    process.env.NO_PROXY = "LOCALHOST,[::1]";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("LOCALHOST,[::1],127.0.0.1,::1");
  });

  test("resolves ${VAR}-style env references like other config secrets", () => {
    process.env.OCX_TEST_PROXY_REF = "http://ref-proxy:9999";
    applyProxyEnv(configWithProxy("${OCX_TEST_PROXY_REF}"));
    expect(process.env.HTTP_PROXY).toBe("http://ref-proxy:9999");
  });
});

test("merges bounded config noProxy with inherited values and loopback defaults", () => {
  expect(mergeNoProxyEntries(["internal.example", "internal.example"], { NO_PROXY: "corp.example" })).toEqual([
    "corp.example", "internal.example", "localhost", "127.0.0.1", "::1", "[::1]",
  ]);
});

test.each(["http://proxy.example", "user%40proxy.example", "proxy.example/*", "proxy.example\nnext", "*"]) (
  "rejects ambiguous noProxy token %j",
  value => expect(() => mergeNoProxyEntries(value, {})).toThrow(),
);

test("child environment builder does not mutate inherited environment", () => {
  const inherited = { HTTPS_PROXY: "https://inherited.example:443", NO_PROXY: "corp.example" };
  const child = proxyEnvironment({ proxy: "http://configured.example:8080", noProxy: ["internal.example"] }, inherited);
  expect(inherited).toEqual({ HTTPS_PROXY: "https://inherited.example:443", NO_PROXY: "corp.example" });
  expect(child.HTTPS_PROXY).toBe("https://inherited.example:443");
  expect(child.HTTP_PROXY).toBe("http://configured.example:8080");
  expect(child.NO_PROXY).toContain("internal.example");
});

test("an unresolved explicit proxy reference fails closed instead of discovering a system proxy", () => {
  const previous = process.env.OCX_MISSING_PROXY_REF;
  delete process.env.OCX_MISSING_PROXY_REF;
  try {
    expect(() => applyProxyEnv({ ...configWithProxy("${OCX_MISSING_PROXY_REF}"), systemProxy: "static" }, {
      platform: "win32",
      detectSystemProxy: () => { throw new Error("system discovery must not run"); },
    })).toThrow(ConfiguredProxyReferenceError);
  } finally {
    if (previous === undefined) delete process.env.OCX_MISSING_PROXY_REF; else process.env.OCX_MISSING_PROXY_REF = previous;
  }
});

test("inherited standard wildcard NO_PROXY is preserved while configured wildcard is rejected", () => {
  expect(mergeNoProxyEntries(undefined, { NO_PROXY: "*.corp.example" })).toContain("*.corp.example");
  expect(() => mergeNoProxyEntries("*.corp.example", {})).toThrow(/wildcards/);
});
