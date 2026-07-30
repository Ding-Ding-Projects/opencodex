# opencodex usage meter for Home Assistant

Sensors for the [opencodex](https://github.com/lidge-jun/opencodex) proxy: requests, tokens,
estimated cost over the last 7 days, and the active Codex account's weekly/monthly quota.

## Requirements

The proxy must be reachable from Home Assistant. On the machine running opencodex:

```bash
ocx host enable --new-key --yes
```

This binds the proxy to your local network, generates an API key, and prints it **once** —
that key is what the integration asks for. `ocx host status` shows the URLs and whether a
credential is configured. Only do this on a network you trust.

## Install

**HACS:** add this repository as a custom repository (category: Integration), install
"opencodex usage meter", restart Home Assistant.

**Manual:** copy `custom_components/opencodex/` into your Home Assistant `config/custom_components/`
directory and restart.

Then: Settings → Devices & Services → Add Integration → "opencodex usage meter", and enter the
host, port (default 10100), and the API key.

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

Everything stays on your network. The account email shown as a quota attribute arrives
pre-masked from the proxy; the integration never sees tokens, prompts, or credentials other
than the API key you give it.
