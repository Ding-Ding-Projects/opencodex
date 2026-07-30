"""Sensors: usage counters, estimated cost, and the active account's quota."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import OpencodexCoordinator, OpencodexData


@dataclass(frozen=True, kw_only=True)
class OpencodexSensorDescription(SensorEntityDescription):
    """Sensor description with a value extractor."""

    value_fn: Callable[[OpencodexData], Any]


def _epoch_ms(value: int | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc)


SENSORS: tuple[OpencodexSensorDescription, ...] = (
    OpencodexSensorDescription(
        key="requests_7d",
        translation_key="requests_7d",
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda d: d.usage.get("requests"),
    ),
    OpencodexSensorDescription(
        key="total_tokens_7d",
        translation_key="total_tokens_7d",
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda d: d.usage.get("totalTokens"),
    ),
    OpencodexSensorDescription(
        key="input_tokens_7d",
        translation_key="input_tokens_7d",
        state_class=SensorStateClass.TOTAL_INCREASING,
        entity_registry_enabled_default=False,
        value_fn=lambda d: d.usage.get("inputTokens"),
    ),
    OpencodexSensorDescription(
        key="output_tokens_7d",
        translation_key="output_tokens_7d",
        state_class=SensorStateClass.TOTAL_INCREASING,
        entity_registry_enabled_default=False,
        value_fn=lambda d: d.usage.get("outputTokens"),
    ),
    OpencodexSensorDescription(
        key="estimated_cost_7d",
        translation_key="estimated_cost_7d",
        state_class=SensorStateClass.TOTAL,
        device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="USD",
        suggested_display_precision=2,
        value_fn=lambda d: d.usage.get("estimatedCostUsd"),
    ),
    OpencodexSensorDescription(
        key="weekly_quota_used",
        translation_key="weekly_quota_used",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.weekly_percent,
    ),
    OpencodexSensorDescription(
        key="monthly_quota_used",
        translation_key="monthly_quota_used",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.monthly_percent,
    ),
    OpencodexSensorDescription(
        key="weekly_quota_resets",
        translation_key="weekly_quota_resets",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_registry_enabled_default=False,
        value_fn=lambda d: _epoch_ms(d.weekly_reset_at),
    ),
    OpencodexSensorDescription(
        key="monthly_quota_resets",
        translation_key="monthly_quota_resets",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_registry_enabled_default=False,
        value_fn=lambda d: _epoch_ms(d.monthly_reset_at),
    ),
    OpencodexSensorDescription(
        key="uptime",
        translation_key="uptime",
        native_unit_of_measurement="s",
        device_class=SensorDeviceClass.DURATION,
        state_class=SensorStateClass.MEASUREMENT,
        entity_registry_enabled_default=False,
        value_fn=lambda d: d.uptime_seconds,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: OpencodexCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(OpencodexSensor(coordinator, entry, description) for description in SENSORS)


class OpencodexSensor(CoordinatorEntity[OpencodexCoordinator], SensorEntity):
    """One reading from the proxy."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: OpencodexCoordinator,
        entry: ConfigEntry,
        description: OpencodexSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description: OpencodexSensorDescription = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="opencodex",
            sw_version=coordinator.data.version if coordinator.data else None,
            configuration_url=coordinator._base,  # noqa: SLF001 — same package
        )

    @property
    def native_value(self) -> Any:
        return self.entity_description.value_fn(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        # The account email arrives pre-masked from the proxy; nothing sensitive here.
        if self.entity_description.key in ("weekly_quota_used", "monthly_quota_used"):
            return {"account": self.coordinator.data.active_account_email}
        return None
