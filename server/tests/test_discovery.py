from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from goodwe_home import discovery
from goodwe_home.discovery import (
    DiscoveredInverter,
    discover_inverter,
    parse_discovery_host,
    parse_local_ipv4_networks,
)


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
    assert [(str(network), host) for network, host in networks] == [
        ("10.20.30.0/24", "10.20.30.44")
    ]


def test_broadcast_failure_falls_back_to_the_bounded_local_scan(monkeypatch) -> None:
    inverter = object()
    search = AsyncMock(side_effect=OSError("broadcast unavailable"))
    scan = AsyncMock(return_value=DiscoveredInverter("192.168.100.201", inverter))
    monkeypatch.setattr("goodwe_home.discovery.goodwe.search_inverters", search)
    monkeypatch.setattr(discovery, "_scan_local_network", scan)

    result = asyncio.run(discover_inverter(502))

    assert result == DiscoveredInverter("192.168.100.201", inverter)
    search.assert_awaited_once_with()
    scan.assert_awaited_once_with(502)
