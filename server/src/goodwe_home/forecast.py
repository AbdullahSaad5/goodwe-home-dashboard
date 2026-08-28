from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import UTC, datetime
from typing import Protocol

import httpx

from .config import Settings
from .database import DashboardDatabase
from .models import ForecastPoint, ForecastRun

logger = logging.getLogger(__name__)


class ForecastProvider(Protocol):
    name: str

    async def fetch(self, now: datetime) -> ForecastRun: ...


class OpenMeteoForecastProvider:
    name = "Open-Meteo"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def fetch(self, now: datetime) -> ForecastRun:
        if not self.settings.forecast_configured:
            raise RuntimeError("Site coordinates are not configured")
        tilted = self.settings.pv_tilt_deg is not None and self.settings.pv_azimuth_deg is not None
        variable = "global_tilted_irradiance" if tilted else "shortwave_radiation"
        params: dict[str, str | float | int] = {
            "latitude": self.settings.site_latitude or 0,
            "longitude": self.settings.site_longitude or 0,
            "hourly": variable,
            "forecast_days": 3,
            "timezone": "UTC",
        }
        if tilted:
            params["tilt"] = self.settings.pv_tilt_deg or 0
            params["azimuth"] = self.settings.pv_azimuth_deg or 0

        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
            response.raise_for_status()
            payload = response.json()

        hourly = payload.get("hourly", {})
        times = hourly.get("time", [])
        values = hourly.get(variable, [])
        points: list[ForecastPoint] = []
        for timestamp, raw_irradiance in zip(times, values, strict=False):
            parsed = datetime.fromisoformat(timestamp)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            irradiance = max(0, float(raw_irradiance or 0))
            pv_w = (
                irradiance / 1000 * self.settings.pv_array_kwp * 1000 * 0.8
                if self.settings.pv_array_kwp
                else None
            )
            points.append(ForecastPoint(timestamp=parsed, irradiance_w_m2=irradiance, pv_w=pv_w))
        return ForecastRun(
            provider=self.name,
            issued_at=now,
            points=points,
            metadata={"variable": variable, "timezone": "UTC"},
        )


class ForecastCoordinator:
    def __init__(self, database: DashboardDatabase, provider: ForecastProvider) -> None:
        self.database = database
        self.provider = provider
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def refresh_once(self, now: datetime | None = None) -> None:
        issued_at = now or datetime.now(UTC)
        try:
            run = await self.provider.fetch(issued_at)
        except Exception as exc:
            self.database.set_runtime_setting("forecast_last_error", str(exc))
            raise
        self.database.store_forecast(run)
        self.database.set_runtime_setting("forecast_last_error", "")

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="solar-forecast")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self.refresh_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Solar forecast refresh failed: %s", exc)
            with suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=3 * 3600)


__all__ = [
    "ForecastCoordinator",
    "ForecastProvider",
    "ForecastRun",
    "OpenMeteoForecastProvider",
]
