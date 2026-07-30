# opencodex usage meter for Home Assistant

Sensors for the [opencodex](https://github.com/lidge-jun/opencodex) proxy: requests, tokens,
estimated cost over the last 7 days, and the active Codex account's weekly/monthly quota.

## Requirements

The proxy must be reachable from Home Assistant, and this integration reads the **management
API** (`/api/*`), so it needs the **admin token** — *not* the data-plane key. On the machine
running opencodex:

```bash
ocx host enable --new-key --yes   # bind to the LAN; mints the data-plane key (used by API clients, not by this integration)
ocx host token                    # print the ADMIN token — this is what the integration asks for
```

`ocx host status` shows the URLs and whether a credential is configured. Only do this on a
network you trust.

The two credentials are deliberately distinct and the server refuses one that plays both roles:
the data-plane key authenticates model traffic from Codex/Claude Code, the admin token
authenticates the dashboard and `/api/*`. Pasting the data-plane key here gets a rejected-token
error, not usage sensors.

## Read this before you paste the admin token

> **Warning — the admin token is a full-control credential, and this integration handles it in
> the clear.**

The admin token is not a scoped read-only usage key. Anyone holding it can drive the entire
proxy through `/api/*`: add, remove, and switch provider accounts, rewrite configuration, mint
and revoke data-plane keys, and call `GET /api/host/export`, which returns the **full state
bundle in plaintext — every provider API key and every stored OAuth refresh token**. That is
equivalent to handing over all the AI accounts behind the proxy.

Three specific exposures follow from giving it to Home Assistant:

- **Home Assistant stores it in plaintext.** Config-entry data lives unencrypted in
  `.storage/core.config_entries`, so anyone with the HA config directory, a backup of it, or
  an add-on that can read it also has the token.
- **It goes over the network unencrypted.** The integration talks plain `http://` to the proxy
  — `ocx host` has no TLS support — so the token crosses your LAN in cleartext.
- **It does so every 60 seconds,** on every poll, indefinitely.

So: **use this on a trusted LAN only.** Do not route it across a VPN-less WAN link, a shared or
guest network, an untrusted VLAN, or the public internet. If your Home Assistant instance is
exposed to the internet, treat its compromise as compromise of every provider account behind the
proxy, and rotate the admin token if you ever suspect it leaked.

The proper fix is a scoped, read-only usage credential the integration could hold instead of the
admin token — **that does not exist yet**. Until it does, the trade-off above is the real one,
and this integration is only appropriate where you accept it.

## Install

**HACS:** add this repository as a custom repository (category: Integration), install
"opencodex usage meter", restart Home Assistant.

**Manual:** copy `custom_components/opencodex/` into your Home Assistant `config/custom_components/`
directory and restart.

Then: Settings → Devices & Services → Add Integration → "opencodex usage meter", and enter the
host, port (default 10100), and the admin token from `ocx host token`.

## Sensors

| Sensor | Notes |
|---|---|
| Requests (7 days) | proxied request count |
| Total tokens (7 days) | input + output + cache |
| Input / Output tokens (7 days) | disabled by default; enable in the entity registry |
| Estimated cost (7 days) | USD, from the proxy's own pricing table |
| Weekly / Monthly quota used | % for the account the pool is currently routing through; the masked account email is an attribute |
| Weekly / Monthly quota resets | timestamps, disabled by default |
| Proxy uptime | disabled by default |

Polling is every 60 seconds; the proxy caches usage summaries server-side, so this is cheap.

## Privacy

Everything stays on your network — nothing is sent anywhere else. The account email shown as a
quota attribute arrives pre-masked from the proxy, and the integration never reads prompts,
completions, or provider credentials; it only calls the three read endpoints listed in
`coordinator.py`.

That is a statement about what this integration *does*, not about what its credential *permits*.
The admin token it holds could read every provider secret out of the proxy (see the warning
above); the protection is that the token stays on a trusted LAN, not that the token is weak.
