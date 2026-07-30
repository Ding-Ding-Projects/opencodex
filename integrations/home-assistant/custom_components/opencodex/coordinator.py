"""Data coordinator: polls the opencodex proxy's management API.

Three endpoints per refresh, all local:
- /healthz            — liveness, version, uptime (unauthenticated)
- /api/usage?range=7d — the summarized usage the dashboard's Usage screen shows
- /api/codex-auth/active + /accounts — the routed account and its quota

The API key travels in the x-opencodex-api-key header. When the proxy is bound
to loopback only (no `ocx host enable`), requests from HA will simply fail to
connect — the config flow explains that instead of leaving a dead entry.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import API_KEY_HEADER, DEFAULT_SCAN_INTERVAL_SECONDS, DOMAIN, USAGE_RANGE

_LOGGER = logging.getLogger(__name__)


@dataclass
class OpencodexData:
    """One refresh worth of proxy state."""

    version: str | None
    uptime_seconds: float | None
    usage: dict[str, Any]
    active_account_email: str | None
    weekly_percent: float | None
    monthly_percent: float | None
    weekly_reset_at: int | None
    monthly_reset_at: int | None


class OpencodexCoordinator(DataUpdateCoordinator[OpencodexData]):
    """Polls the proxy on a fixed interval."""

    def __init__(self, hass: HomeAssistant, host: str, port: int, api_key: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL_SECONDS),
        )
        self._base = f"http://{host}:{port}"
        self._headers = {API_KEY_HEADER: api_key}
        self._session = async_get_clientsession(hass)

    async def _get(self, path: str, authed: bool = True) -> Any:
        try:
            async with self._session.get(
                f"{self._base}{path}",
                headers=self._headers if authed else None,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                if response.status == 401:
                    raise UpdateFailed("token rejected (401) — get the admin token with: ocx host token")
                response.raise_for_status()
                return await response.json()
        except UpdateFailed:
            raise
        except (aiohttp.ClientError, TimeoutError) as err:
            raise UpdateFailed(f"opencodex unreachable at {self._base}: {err}") from err

    async def _async_update_data(self) -> OpencodexData:
        health = await self._get("/healthz", authed=False)
        if not isinstance(health, dict) or health.get("service") != "opencodex":
            # A foreign server on the port must never be read as proxy data.
            raise UpdateFailed(f"{self._base} did not identify as opencodex")

        usage = await self._get(f"/api/usage?range={USAGE_RANGE}")
        summary = usage.get("summary") if isinstance(usage, dict) else None
        if not isinstance(summary, dict):
            raise UpdateFailed("unexpected /api/usage payload")

        # Quota for whichever account the pool is routing through. Best-effort:
        # a proxy with no Codex accounts still has meaningful usage sensors.
        email: str | None = None
        weekly = monthly = weekly_reset = monthly_reset = None
        try:
            active = await self._get("/api/codex-auth/active")
            accounts = await self._get("/api/codex-auth/accounts")
            active_id = active.get("activeCodexAccountId") if isinstance(active, dict) else None
            rows = accounts.get("accounts") if isinstance(accounts, dict) else None
            if isinstance(active_id, str) and isinstance(rows, list):
                match = next((a for a in rows if isinstance(a, dict) and a.get("id") == active_id), None)
                if match:
                    email = match.get("email")
                    quota = match.get("quota") or {}
                    if isinstance(quota, dict):
                        weekly = quota.get("weeklyPercent")
                        monthly = quota.get("monthlyPercent")
                        weekly_reset = quota.get("weeklyResetAt")
                        monthly_reset = quota.get("monthlyResetAt")
        except UpdateFailed:
            _LOGGER.debug("account quota unavailable this cycle; usage sensors still updated")

        return OpencodexData(
            version=health.get("version"),
            uptime_seconds=health.get("uptime"),
            usage=summary,
            active_account_email=email if isinstance(email, str) else None,
            weekly_percent=weekly if isinstance(weekly, (int, float)) else None,
            monthly_percent=monthly if isinstance(monthly, (int, float)) else None,
            weekly_reset_at=weekly_reset if isinstance(weekly_reset, int) else None,
            monthly_reset_at=monthly_reset if isinstance(monthly_reset, int) else None,
        )
