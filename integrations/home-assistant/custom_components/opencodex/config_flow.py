"""Config flow: host + port + API key, validated against the live proxy."""

from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import API_KEY_HEADER, CONF_API_KEY, DEFAULT_PORT, DOMAIN

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
        vol.Required(CONF_API_KEY): str,
    }
)


class OpencodexConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """UI setup for the opencodex usage meter."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await self._validate(user_input)
            if error is None:
                # One entry per proxy: host:port identifies it.
                await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"opencodex @ {user_input[CONF_HOST]}",
                    data=user_input,
                )
            errors["base"] = error

        return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors)

    async def _validate(self, user_input: dict[str, Any]) -> str | None:
        """Probe /healthz for identity, then /api/usage for the key. Returns an error key or None."""
        session = async_get_clientsession(self.hass)
        base = f"http://{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
        timeout = aiohttp.ClientTimeout(total=10)
        try:
            async with session.get(f"{base}/healthz", timeout=timeout) as response:
                if response.status != 200:
                    return "cannot_connect"
                body = await response.json()
                if not isinstance(body, dict) or body.get("service") != "opencodex":
                    # Something answered, but it is not the proxy — likely the
                    # wrong port, or `ocx host enable` has not been run.
                    return "not_opencodex"
            async with session.get(
                f"{base}/api/usage?range=7d",
                headers={API_KEY_HEADER: user_input[CONF_API_KEY]},
                timeout=timeout,
            ) as response:
                if response.status == 401:
                    return "invalid_auth"
                if response.status != 200:
                    return "cannot_connect"
        except (aiohttp.ClientError, TimeoutError):
            return "cannot_connect"
        return None
