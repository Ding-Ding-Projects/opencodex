import { describe, expect, test } from "bun:test";
import { detectStaticWindowsSystemProxy } from "../src/lib/system-proxy";
import { applyProxyEnv } from "../src/config";
import type { OcxConfig } from "../src/types";

const reg = (body: string) => (_file: string, _args: string[]) => body;

function perValue(values: Record<string, string>, calls: string[][] = []) {
  return (_file: string, args: string[]) => {
    calls.push(args);
    return values[args.at(-1)!] ?? (() => { throw new Error("value not present"); })();
  };
}

describe("static Windows system proxy detection", () => {
  test("reads an enabled static proxy without following PAC", () => {
    const calls: string[][] = [];
    const result = detectStaticWindowsSystemProxy(perValue({
      ProxyEnable: "    ProxyEnable    REG_DWORD    0x1",
      ProxyServer: "    ProxyServer    REG_SZ    proxy.example:8080",
      AutoConfigURL: "",
      AutoDetect: "",
    }, calls), "win32");
    expect(result).toEqual({ proxy: "http://proxy.example:8080", source: "windows-static" });
    expect(calls).toEqual([
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "AutoConfigURL"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "AutoDetect"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
    ]);
  });

  test("refuses PAC/WPAD, keyed per-scheme values, and disabled settings", () => {
    const pac = detectStaticWindowsSystemProxy(reg([
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    proxy.example:8080",
      "    AutoConfigURL  REG_SZ    http://wpad.example/proxy.pac",
    ].join("\n")), "win32");
    expect(pac).toBeNull();
    expect(detectStaticWindowsSystemProxy(reg("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=proxy.example:8080;https=secure.example:8443"), "win32")).toBeNull();
    expect(detectStaticWindowsSystemProxy(reg("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ proxy.example:8080\nAutoDetect REG_DWORD 0x1"), "win32")).toBeNull();
    expect(detectStaticWindowsSystemProxy(reg("ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ proxy.example:8080"), "win32")).toBeNull();
  });

  test("registry failures and absent settings are honest no-proxy results", () => {
    expect(detectStaticWindowsSystemProxy(() => { throw new Error("registry unavailable"); }, "win32")).toBeNull();
    expect(detectStaticWindowsSystemProxy(perValue({ ProxyEnable: "ProxyEnable REG_DWORD 0x1" }), "win32")).toBeNull();
  });

  test("does not detect a system proxy on other platforms", () => {
    expect(detectStaticWindowsSystemProxy(reg("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ proxy.example:8080"), "linux")).toBeNull();
  });

  test("application seam gives configured proxy precedence and fails closed without direct fallback", () => {
    const envBefore = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
    try {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
      applyProxyEnv({ proxy: "http://configured.example:8080", systemProxy: "static", providers: {} } as unknown as OcxConfig, {
        platform: "win32",
        detectSystemProxy: () => { throw new Error("detector must not run when config proxy is present"); },
      });
      expect(process.env.HTTP_PROXY).toBe("http://configured.example:8080");
      expect(() => applyProxyEnv({ systemProxy: "static", providers: {} } as unknown as OcxConfig, {
        platform: "win32", detectSystemProxy: () => null,
      })).toThrow(/no usable static proxy/);
    } finally {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] as const) {
        const value = envBefore[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
