from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from goodwe_home.collector import GoodWeCollector
from goodwe_home.config import Settings
from goodwe_home.database import DashboardDatabase
from goodwe_home.discovery import DiscoveredInverter


def make_collector(
    tmp_path, host: str | None = "192.168.50.10"
) -> tuple[GoodWeCollector, DashboardDatabase]:
    settings = Settings(
        inverter_host=host,
        inverter_port=502,
        database_path=tmp_path / "collector.sqlite3",
    )
    database = DashboardDatabase(settings.database_path, settings.timezone)
    return GoodWeCollector(settings, database), database


def test_configured_host_is_used_without_broadcast_when_it_responds(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path)
    inverter = object()
    connect = AsyncMock(return_value=inverter)
    discover = AsyncMock()
    monkeypatch.setattr("goodwe_home.collector.goodwe.connect", connect)
    monkeypatch.setattr("goodwe_home.collector.discover_inverter", discover)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.50.10"
        assert database.get_runtime_setting("inverter_host") == "192.168.50.10"
        connect.assert_awaited_once_with("192.168.50.10", port=502, timeout=2, retries=2)
        discover.assert_not_awaited()
    finally:
        database.close()


def test_missing_configured_host_discovers_the_inverter_at_startup(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path, host=None)
    inverter = object()
    discover = AsyncMock(return_value=DiscoveredInverter("192.168.100.201", inverter))
    monkeypatch.setattr("goodwe_home.collector.discover_inverter", discover)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.100.201"
        assert database.get_runtime_setting("inverter_host") == "192.168.100.201"
        discover.assert_awaited_once_with(502)
        event = database.list_events(1)[0]
        assert event.event_type == "inverter_discovered"
        assert event.details == {
            "previous_host": None,
            "discovered_host": "192.168.100.201",
        }
    finally:
        database.close()


def test_saved_host_is_tried_first_on_the_next_launch(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path, host=None)
    database.set_runtime_setting("inverter_host", "192.168.50.20")
    collector = GoodWeCollector(collector.config, database)
    inverter = object()
    connect = AsyncMock(return_value=inverter)
    discover = AsyncMock()
    monkeypatch.setattr("goodwe_home.collector.goodwe.connect", connect)
    monkeypatch.setattr("goodwe_home.collector.discover_inverter", discover)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter_host == "192.168.50.20"
        connect.assert_awaited_once_with("192.168.50.20", port=502, timeout=2, retries=2)
        discover.assert_not_awaited()
    finally:
        database.close()


def test_failed_startup_connection_discovers_and_uses_the_new_ip(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path)
    inverter = object()
    connect = AsyncMock(side_effect=OSError("old address unavailable"))
    discover = AsyncMock(return_value=DiscoveredInverter("192.168.100.201", inverter))
    monkeypatch.setattr("goodwe_home.collector.goodwe.connect", connect)
    monkeypatch.setattr("goodwe_home.collector.discover_inverter", discover)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.100.201"
        connect.assert_awaited_once_with("192.168.50.10", port=502, timeout=2, retries=2)
        discover.assert_awaited_once_with(502)
        event = database.list_events(1)[0]
        assert event.event_type == "inverter_rediscovered"
        assert event.details == {
            "previous_host": "192.168.50.10",
            "discovered_host": "192.168.100.201",
        }
    finally:
        database.close()


def test_discovery_is_attempted_only_once_per_startup(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path)
    connect = AsyncMock(side_effect=OSError("unavailable"))
    discover = AsyncMock(side_effect=OSError("no discovery response"))
    monkeypatch.setattr("goodwe_home.collector.goodwe.connect", connect)
    monkeypatch.setattr("goodwe_home.collector.discover_inverter", discover)

    try:
        with pytest.raises(OSError, match="unavailable"):
            asyncio.run(collector._connect())
        with pytest.raises(OSError, match="unavailable"):
            asyncio.run(collector._connect())
        discover.assert_awaited_once_with(502)
    finally:
        database.close()
