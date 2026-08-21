import { describe, expect, test } from "bun:test";
import { detectStaticWindowsSystemProxy } from "../src/lib/system-proxy";

const reg = (body: string) => (_file: string, _args: string[]) => body;

describe("static Windows system proxy detection", () => {
  test("reads an enabled static proxy without following PAC", () => {
    const result = detectStaticWindowsSystemProxy(reg([
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    http=proxy.example:8080;https=secure.example:8443",
      "",
    ].join("\n")), "win32");
    expect(result).toEqual({ proxy: "http://proxy.example:8080", source: "windows-static" });
  });

  test("refuses PAC/WPAD and disabled settings", () => {
    const pac = detectStaticWindowsSystemProxy(reg([
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    proxy.example:8080",
      "    AutoConfigURL  REG_SZ    http://wpad.example/proxy.pac",
    ].join("\n")), "win32");
    expect(pac).toBeNull();
    expect(detectStaticWindowsSystemProxy(reg("ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ proxy.example:8080"), "win32")).toBeNull();
  });

  test("does not detect a system proxy on other platforms", () => {
    expect(detectStaticWindowsSystemProxy(reg("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ proxy.example:8080"), "linux")).toBeNull();
  });
});
