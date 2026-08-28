from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, call

import pytest

from backend.collector import GoodWeCollector, parse_discovery_host, parse_local_ipv4_networks
from backend.config import Settings
from backend.database import DashboardDatabase


def make_collector(tmp_path, host: str | None = "192.168.50.10") -> tuple[GoodWeCollector, DashboardDatabase]:
    settings = Settings(
        inverter_host=host,
        inverter_port=502,
        database_path=tmp_path / "collector.sqlite3",
    )
    database = DashboardDatabase(settings.database_path, settings.timezone)
    return GoodWeCollector(settings, database), database


def test_discovery_response_extracts_a_local_ipv4_address() -> None:
    assert parse_discovery_host(b"192.168.100.201,001D0F123456,WiFi Kit") == "192.168.100.201"


@pytest.mark.parametrize(
    "response",
    [
        b"not-an-ip,001D0F123456,WiFi Kit",
        b"8.8.8.8,001D0F123456,WiFi Kit",
        b"127.0.0.1,001D0F123456,WiFi Kit",
        b"",
    ],
)
def test_discovery_response_rejects_invalid_or_non_lan_addresses(response: bytes) -> None:
    with pytest.raises(ValueError):
        parse_discovery_host(response)


def test_local_interface_output_produces_a_bounded_lan_network() -> None:
    networks = parse_local_ipv4_networks(
        """
en0: flags=8863<UP,BROADCAST,RUNNING>
    inet 10.20.30.44 netmask 0xffff0000 broadcast 10.20.255.255
lo0: flags=8049<UP,LOOPBACK,RUNNING>
    inet 127.0.0.1 netmask 0xff000000
"""
    )
    assert [(str(network), host) for network, host in networks] == [("10.20.30.0/24", "10.20.30.44")]


def test_configured_host_is_used_without_broadcast_when_it_responds(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path)
    inverter = object()
    connect = AsyncMock(return_value=inverter)
    search = AsyncMock()
    monkeypatch.setattr("backend.collector.goodwe.connect", connect)
    monkeypatch.setattr("backend.collector.goodwe.search_inverters", search)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.50.10"
        assert database.get_runtime_setting("inverter_host") == "192.168.50.10"
        connect.assert_awaited_once_with("192.168.50.10", port=502, timeout=2, retries=2)
        search.assert_not_awaited()
    finally:
        database.close()


def test_missing_configured_host_discovers_the_inverter_at_startup(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path, host=None)
    inverter = object()
    connect = AsyncMock(return_value=inverter)
    search = AsyncMock(return_value=b"192.168.100.201,001D0F123456,WiFi Kit")
    monkeypatch.setattr("backend.collector.goodwe.connect", connect)
    monkeypatch.setattr("backend.collector.goodwe.search_inverters", search)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.100.201"
        assert database.get_runtime_setting("inverter_host") == "192.168.100.201"
        connect.assert_awaited_once_with("192.168.100.201", port=502, timeout=2, retries=2)
        search.assert_awaited_once_with()
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
    search = AsyncMock()
    monkeypatch.setattr("backend.collector.goodwe.connect", connect)
    monkeypatch.setattr("backend.collector.goodwe.search_inverters", search)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter_host == "192.168.50.20"
        connect.assert_awaited_once_with("192.168.50.20", port=502, timeout=2, retries=2)
        search.assert_not_awaited()
    finally:
        database.close()


def test_missing_host_falls_back_to_a_bounded_local_scan_when_broadcast_fails(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path, host=None)
    inverter = object()
    search = AsyncMock(side_effect=OSError("broadcast unavailable"))
    scan = AsyncMock(return_value=("192.168.100.201", inverter))
    monkeypatch.setattr("backend.collector.goodwe.search_inverters", search)
    monkeypatch.setattr(collector, "_scan_local_network", scan)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.100.201"
        assert database.get_runtime_setting("inverter_host") == "192.168.100.201"
        search.assert_awaited_once_with()
        scan.assert_awaited_once_with()
    finally:
        database.close()


def test_failed_startup_connection_discovers_and_uses_the_new_ip(tmp_path, monkeypatch) -> None:
    collector, database = make_collector(tmp_path)
    inverter = object()
    connect = AsyncMock(side_effect=[OSError("old address unavailable"), inverter])
    search = AsyncMock(return_value=b"192.168.100.201,001D0F123456,WiFi Kit")
    monkeypatch.setattr("backend.collector.goodwe.connect", connect)
    monkeypatch.setattr("backend.collector.goodwe.search_inverters", search)

    try:
        asyncio.run(collector._connect())
        assert collector.inverter is inverter
        assert collector.inverter_host == "192.168.100.201"
        assert connect.await_args_list == [
            call("192.168.50.10", port=502, timeout=2, retries=2),
            call("192.168.100.201", port=502, timeout=2, retries=2),
        ]
        search.assert_awaited_once_with()
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
    search = AsyncMock(side_effect=OSError("no discovery response"))
    monkeypatch.setattr("backend.collector.goodwe.connect", connect)
    monkeypatch.setattr("backend.collector.goodwe.search_inverters", search)

    try:
        with pytest.raises(OSError, match="unavailable"):
            asyncio.run(collector._connect())
        with pytest.raises(OSError, match="unavailable"):
            asyncio.run(collector._connect())
        search.assert_awaited_once_with()
    finally:
        database.close()
