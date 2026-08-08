/**
 * LAN discovery.
 *
 * A subnet sweep is a feature that looks exactly like an attack tool if it is
 * built carelessly, so most of what is pinned here is what it *refuses* to do:
 * only this host's own /24s, only one port, only one path, and only a body that
 * actually looks like opencodex.
 */

import { describe, expect, test } from "bun:test";

import { discoverProxies, localSubnets } from "../src/lib/lan-discovery";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("what it sweeps", () => {
  test("only /24 networks this machine is actually on", () => {
    // A /16 is 65 000 hosts. Sweeping one is not discovery, it is a port scan,
    // and it could never finish inside the deadline anyway.
    for (const net of localSubnets()) {
      expect(net.prefix.split(".")).toHaveLength(3);
      expect(net.own.startsWith(`${net.prefix}.`)).toBe(true);
    }
  });

  test("probes .1 through .254, never the network or broadcast address", async () => {
    const seen: string[] = [];
    await discoverProxies(10100, {
      probe: async url => { seen.push(url); return jsonResponse({ status: "ok" }); },
    });
    if (seen.length === 0) return; // no qualifying interface on this host
    const lastOctets = seen.map(u => Number(u.split(":")[1].replace("//", "").split(".")[3]));
    expect(Math.min(...lastOctets)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...lastOctets)).toBeLessThanOrEqual(254);
  });

  test("probes exactly the port it was given", async () => {
    const ports = new Set<string>();
    await discoverProxies(4321, {
      probe: async url => { ports.add(url.split(":")[2]); return jsonResponse({ status: "ok" }); },
    });
    if (ports.size === 0) return;
    expect([...ports]).toEqual(["4321"]);
  });
});

describe("what counts as a match", () => {
  test("a 200 that is not opencodex is not a match", async () => {
    // Any web server on the subnet answers something. Only a body shaped like
    // ours counts, or discovery reports every printer as a proxy.
    const found = await discoverProxies(10100, {
      probe: async () => new Response("<html>hello</html>", { status: 200 }),
    });
    expect(found).toEqual([]);
  });

  test("valid JSON without a status field is not a match", async () => {
    const found = await discoverProxies(10100, { probe: async () => jsonResponse({ hello: "world" }) });
    expect(found).toEqual([]);
  });

  test("a non-2xx is not a match", async () => {
    const found = await discoverProxies(10100, { probe: async () => jsonResponse({ status: "ok" }, 500) });
    expect(found).toEqual([]);
  });

  test("a refused connection is not an error, just an absence", async () => {
    const found = await discoverProxies(10100, {
      probe: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(found).toEqual([]);
  });

  test("a real health body is a match, and carries its version", async () => {
    const found = await discoverProxies(10100, {
      probe: async () => jsonResponse({ status: "ok", version: "2.7.42" }),
    });
    if (found.length === 0) return; // no qualifying interface here
    expect(found[0].version).toBe("2.7.42");
    expect(found[0].url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:10100$/);
  });
});

describe("bounds", () => {
  test("the sweep stops at its deadline rather than running forever", async () => {
    // A network that never answers must not hold the request open. `now` is
    // injected so this does not actually wait six seconds.
    let clock = 0;
    const found = await discoverProxies(10100, {
      now: () => (clock += 500),
      probe: async () => jsonResponse({ status: "ok" }),
    });
    // With the clock advancing 500ms per check, the deadline is crossed long
    // before 254 hosts are probed.
    expect(found.length).toBeLessThan(254);
  });

  test("this machine is reported, and flagged as itself", async () => {
    const found = await discoverProxies(10100, { probe: async () => jsonResponse({ status: "ok" }) });
    if (found.length === 0) return;
    // Hiding self would make a local-only install look undiscoverable, which is
    // the opposite of helpful in a first-run wizard.
    const own = localSubnets().map(n => n.own);
    for (const hit of found) {
      expect(hit.self).toBe(own.includes(hit.host));
    }
    // Self sorts first so the wizard can show "this machine" at the top.
    if (found.some(f => f.self)) expect(found[0].self).toBe(true);
  });
});
