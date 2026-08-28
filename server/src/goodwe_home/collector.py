from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import goodwe

from .config import Settings
from .database import DashboardDatabase
from .discovery import discover_inverter
from .models import ConnectionInfo, NormalizedSnapshot, SensorReading
from .normalization import build_sensor_readings, json_safe, normalize_snapshot

logger = logging.getLogger(__name__)
INVERTER_HOST_SETTING = "inverter_host"


class GoodWeCollector:
    """Owns the single read-only connection to the inverter."""

    def __init__(self, config: Settings, database: DashboardDatabase) -> None:
        self.config = config
        self.database = database
        saved_host = database.get_runtime_setting(INVERTER_HOST_SETTING)
        known_hosts = list(
            dict.fromkeys(host for host in (config.inverter_host, saved_host) if host)
        )
        self.inverter_host = known_hosts.pop(0) if known_hosts else None
        self._fallback_hosts = known_hosts
        self.inverter: Any = None
        self.current: NormalizedSnapshot | None = database.latest_snapshot()
        self.current_raw: dict[str, Any] = {}
        self.current_sensors: list[SensorReading] = []
        self.failures = 0
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._last_raw_minute: int | None = None
        self._last_rollup_hour: int | None = None
        self._last_health: str | None = None
        self._offline_event_emitted = False
        self._startup_discovery_attempted = False

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="goodwe-collector")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

    async def _connect(self) -> None:
        configured_error: Exception | None = None
        if self.inverter_host:
            known_hosts = [self.inverter_host, *self._fallback_hosts]
            self._fallback_hosts = []
            for known_host in known_hosts:
                self.inverter_host = known_host
                try:
                    inverter = await goodwe.connect(
                        known_host,
                        port=self.config.inverter_port,
                        timeout=2,
                        retries=2,
                    )
                    self.inverter = inverter
                    self.database.set_runtime_setting(INVERTER_HOST_SETTING, known_host)
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if configured_error is None:
                        configured_error = exc
            if self._startup_discovery_attempted and configured_error is not None:
                raise configured_error
            logger.info("Known inverter address did not respond; trying GoodWe LAN discovery")
        elif self._startup_discovery_attempted:
            raise ConnectionError(
                "No inverter address is available; startup discovery did not find one"
            )
        else:
            logger.info("No inverter address configured; trying GoodWe LAN discovery")

        self._startup_discovery_attempted = True
        try:
            discovered = await discover_inverter(self.config.inverter_port)
        except asyncio.CancelledError:
            raise
        except Exception as discovery_error:
            logger.warning(
                "GoodWe LAN discovery did not find a usable inverter: %s", discovery_error
            )
            if configured_error is not None:
                raise configured_error from discovery_error
            raise

        previous_host = self.inverter_host
        self.inverter_host = discovered.host
        self.inverter = discovered.inverter
        self.database.set_runtime_setting(INVERTER_HOST_SETTING, discovered.host)
        self.database.add_event(
            "info",
            "inverter_rediscovered" if previous_host else "inverter_discovered",
            (
                "Inverter found at a new local address"
                if previous_host
                else "Inverter found on the local network"
            ),
            {
                "previous_host": previous_host,
                "discovered_host": discovered.host,
            },
        )
        logger.info(
            "GoodWe inverter discovered at %s:%s",
            discovered.host,
            self.config.inverter_port,
        )

    async def _poll(self) -> None:
        if self.inverter is None:
            await self._connect()
        raw = await self.inverter.read_runtime_data()
        collected_at = datetime.now(UTC)
        snapshot = normalize_snapshot(
            raw,
            collected_at=collected_at,
            failures=0,
            display_model=self.config.display_model,
            protocol_model=getattr(self.inverter, "model_name", None),
            firmware=getattr(self.inverter, "firmware", None),
        )
        readings = build_sensor_readings(raw, self.inverter.sensors(), collected_at)
        current_minute = int(collected_at.timestamp() // 60)
        persist_raw = current_minute != self._last_raw_minute

        self.database.record_snapshot(snapshot, raw if persist_raw else None)
        if persist_raw:
            self._last_raw_minute = current_minute

        current_hour = int(collected_at.timestamp() // 3600)
        if current_hour != self._last_rollup_hour:
            self.database.rollup_and_retain(collected_at.timestamp())
            self._last_rollup_hour = current_hour

        recovered = self.failures > 0
        self.failures = 0
        self.current = snapshot
        self.current_raw = dict(raw)
        self.current_sensors = readings
        if recovered:
            self.database.add_event(
                "info",
                "connection_restored",
                "Local inverter connection restored",
                {"host": self.inverter_host},
            )
        self._offline_event_emitted = False

        health = snapshot.system.health
        if health != self._last_health:
            if health in {"warning", "error"}:
                self.database.add_event(
                    "error" if health == "error" else "warning",
                    "system_health",
                    (
                        "The inverter reported an error"
                        if health == "error"
                        else "The inverter reported a warning"
                    ),
                    {
                        "warning_code": snapshot.system.warning_code,
                        "error_code": snapshot.system.error_code,
                        "errors": snapshot.system.errors,
                        "battery_warning": snapshot.battery.warning,
                        "battery_error": snapshot.battery.error,
                    },
                )
            elif self._last_health in {"warning", "error"}:
                self.database.add_event(
                    "info", "system_healthy", "Inverter warning and error registers cleared"
                )
            self._last_health = health

        await self._publish(snapshot.model_dump_json())

    async def _run(self) -> None:
        self.database.add_event(
            "info",
            "collector_started",
            "Local energy collector started",
            {"host": self.inverter_host, "port": self.config.inverter_port},
        )
        while not self._stop.is_set():
            try:
                await self._poll()
                delay = self.config.poll_interval_seconds
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # Network and protocol failures share recovery behavior.
                logger.warning("GoodWe poll failed: %s", exc)
                self.inverter = None
                self.failures += 1
                delay = min(
                    self.config.poll_interval_seconds * (2 ** max(0, self.failures - 1)),
                    60,
                )
                if self.failures >= 3 and not self._offline_event_emitted:
                    self.database.add_event(
                        "error",
                        "connection_lost",
                        "Unable to reach the inverter on the local network",
                        {
                            "host": self.inverter_host,
                            "port": self.config.inverter_port,
                            "failures": self.failures,
                            "reason": str(exc),
                        },
                    )
                    self._offline_event_emitted = True
                await self._publish_status_only()

            with suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    def status(self) -> NormalizedSnapshot | None:
        if not self.current:
            return None
        snapshot = self.current.model_copy(deep=True)
        updated = snapshot.connection.last_updated
        age = (datetime.now(UTC) - updated).total_seconds() if updated else None
        if self.failures >= 3:
            state = "offline"
        elif age is not None and age > self.config.stale_after_seconds:
            state = "stale"
        else:
            state = "live"
        snapshot.connection = snapshot.connection.model_copy(
            update={
                "state": state,
                "age_seconds": max(0, age) if age is not None else None,
                "consecutive_failures": self.failures,
            }
        )
        return snapshot

    def starting_status(self) -> dict[str, Any]:
        return {
            "connection": ConnectionInfo(
                state="starting",
                consecutive_failures=self.failures,
                display_model=self.config.display_model,
            ).model_dump(mode="json"),
            "message": "Waiting for the first inverter reading",
        }

    async def _publish_status_only(self) -> None:
        snapshot = self.status()
        payload = snapshot.model_dump_json() if snapshot else json.dumps(self.starting_status())
        await self._publish(payload)

    async def _publish(self, payload: str) -> None:
        stale: list[asyncio.Queue[str]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self._subscribers.discard(queue)

    async def subscribe(self) -> AsyncIterator[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=2)
        self._subscribers.add(queue)
        try:
            initial = self.status()
            if initial:
                yield initial.model_dump_json()
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)

    def raw_payload(self) -> dict[str, Any]:
        return json_safe(self.current_raw)
