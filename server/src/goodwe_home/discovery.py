from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from contextlib import suppress
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network, ip_address, ip_interface
from typing import Any

import goodwe

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DiscoveredInverter:
    host: str
    inverter: Any


def parse_discovery_host(response: bytes) -> str:
    """Extract and validate the LAN address from a GoodWe discovery response."""
    try:
        parts = response.decode("utf-8").strip().split(",", 2)
    except UnicodeDecodeError as exc:
        raise ValueError("GoodWe discovery response was not valid UTF-8") from exc
    if len(parts) < 3:
        raise ValueError("GoodWe discovery response was incomplete")

    try:
        address = ip_address(parts[0].strip())
    except ValueError as exc:
        raise ValueError("GoodWe discovery response did not contain an IP address") from exc
    if (
        not isinstance(address, IPv4Address)
        or address.is_global
        or address.is_loopback
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        raise ValueError("GoodWe discovery response did not contain a local IPv4 address")
    return str(address)


def parse_local_ipv4_networks(interface_output: str) -> list[tuple[IPv4Network, str]]:
    """Read active LAN addresses from macOS/Linux interface output."""
    discovered: dict[tuple[str, str], tuple[IPv4Network, str]] = {}
    patterns = (
        re.compile(
            r"\binet\s+(\d+(?:\.\d+){3})\s+netmask\s+"
            r"(0x[0-9a-fA-F]+|\d+(?:\.\d+){3})"
        ),
        re.compile(r"\binet\s+(\d+(?:\.\d+){3})/(\d{1,2})\b"),
    )
    for pattern in patterns:
        for match in pattern.finditer(interface_output):
            host, mask = match.groups()
            try:
                address = ip_address(host)
                if not isinstance(address, IPv4Address) or address.is_loopback or address.is_global:
                    continue
                if mask.startswith("0x"):
                    mask = str(IPv4Address(int(mask, 16)))
                interface = ip_interface(f"{host}/{mask}")
            except ValueError:
                continue
            network = interface.network
            if network.prefixlen < 24:
                network = IPv4Network(f"{host}/24", strict=False)
            discovered[(str(network), host)] = (network, host)
    return sorted(discovered.values(), key=lambda item: (int(item[0].network_address), item[1]))


def read_local_ipv4_networks() -> list[tuple[IPv4Network, str]]:
    """Query local interfaces without relying on a preconfigured gateway or IP."""
    commands = (
        ("/sbin/ifconfig",),
        ("ifconfig",),
        ("ip", "-o", "-4", "addr", "show", "up"),
    )
    for command in commands:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                timeout=3,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        networks = parse_local_ipv4_networks(result.stdout)
        if networks:
            return networks
    return []


async def discover_inverter(port: int) -> DiscoveredInverter:
    """Find and validate one GoodWe inverter on the active local network."""
    try:
        response = await goodwe.search_inverters()
        host = parse_discovery_host(response)
        inverter = await goodwe.connect(host, port=port, timeout=2, retries=2)
        return DiscoveredInverter(host, inverter)
    except asyncio.CancelledError:
        raise
    except Exception as broadcast_error:
        logger.info(
            "GoodWe broadcast discovery did not answer (%s); checking the local network on port %s",
            broadcast_error,
            port,
        )
    return await _scan_local_network(port)


async def _scan_local_network(port: int) -> DiscoveredInverter:
    networks = await asyncio.to_thread(read_local_ipv4_networks)
    if not networks:
        raise ConnectionError("No active local IPv4 network was found")

    local_addresses = {host for _, host in networks}
    candidates = sorted(
        {str(host) for network, _ in networks for host in network.hosts()} - local_addresses,
        key=lambda host: int(ip_address(host)),
    )
    semaphore = asyncio.Semaphore(48)

    async def port_is_open(host: str) -> str | None:
        async with semaphore:
            try:
                _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=0.2)
            except (OSError, TimeoutError):
                return None
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()
            return host

    responders = [
        host for host in await asyncio.gather(*(port_is_open(host) for host in candidates)) if host
    ]
    for host in responders:
        try:
            inverter = await goodwe.connect(host, port=port, timeout=1, retries=1)
            return DiscoveredInverter(host, inverter)
        except asyncio.CancelledError:
            raise
        except Exception:
            continue
    raise ConnectionError(f"No GoodWe inverter responded on local port {port}")
