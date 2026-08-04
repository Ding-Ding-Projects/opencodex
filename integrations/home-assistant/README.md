# opencodex usage meter for Home Assistant

Sensors for the [opencodex](https://github.com/lidge-jun/opencodex) proxy: requests, tokens,
estimated cost over the last 7 days, and the active Codex account's weekly/monthly quota.

## Requirements

The proxy must be reachable from Home Assistant. This integration reads the **management API**
(`/api/*`), whose admin-token gate has been removed. On the machine running opencodex:

```bash
ocx host enable --new-key --yes   # bind to the LAN and mint the data-plane key for model clients
```

`ocx host status` shows the URLs and data-plane credential state. Because management routes are
open, put any non-loopback deployment behind a trusted network or an external authenticated
boundary.

The management surface includes provider settings, account controls, exports, and logs. Anyone who
can reach this integration's configured address can reach those routes too; do not expose it to an
untrusted network.

## Install

**HACS:** add this repository as a custom repository (category: Integration), install
"opencodex usage meter", restart Home Assistant.

**Manual:** copy `custom_components/opencodex/` into your Home Assistant `config/custom_components/`
directory and restart.

Then: Settings → Devices & Services → Add Integration → "opencodex usage meter", and enter the
host and port (default 10100).

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
`coordinator.py`. Keep the proxy behind a trusted network or external authenticated boundary,
because the management API is intentionally open.
