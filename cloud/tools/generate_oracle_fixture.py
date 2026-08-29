#!/usr/bin/env python3
"""Generate deterministic all-field expectations using goodwe 0.4.10."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from goodwe.et import ET
from goodwe.protocol import ProtocolResponse


def frame(registers: int, seed: int, timestamp: bool = False) -> bytes:
    payload = bytearray((index * 37 + seed) & 0xFF for index in range(registers * 2))
    if timestamp:
        payload[:6] = bytes([26, 8, 29, 16, 51, 55])
    header = bytes([0, seed, 0, 0, 0, len(payload) + 3, 0xF7, 3, len(payload)])
    return header + payload


def safe(value: object) -> object:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def main() -> None:
    inverter = ET("0.0.0.0", 502)
    manifest = json.loads(
        (Path(__file__).resolve().parents[1] / "decoder-manifest.json").read_text(encoding="utf-8")
    )
    expected_keys = {field["id"] for field in manifest["fields"]}
    runtime = frame(125, 11, timestamp=True)
    battery = frame(24, 17)
    meter = frame(45, 23)
    selected_meter = tuple(
        sensor
        for sensor in inverter._ET__all_sensors_meter
        if sensor.offset * 2 + sensor.size_ <= (36000 + 45) * 2
    )
    values = inverter._map_response(
        ProtocolResponse(runtime, inverter._READ_RUNNING_DATA),
        tuple(sensor for sensor in inverter._ET__all_sensors if sensor.id_ in expected_keys),
    )
    values.update(
        inverter._map_response(
            ProtocolResponse(battery, inverter._READ_BATTERY_INFO),
            tuple(
                sensor
                for sensor in inverter._ET__all_sensors_battery
                if sensor.id_ in expected_keys
            ),
        )
    )
    values.update(
        inverter._map_response(
            ProtocolResponse(meter, inverter._READ_METER_DATA),
            tuple(sensor for sensor in selected_meter if sensor.id_ in expected_keys),
        )
    )
    if set(values) != expected_keys:
        raise SystemExit("Generated fixture does not match the decoder manifest")
    destination = Path(__file__).resolve().parents[1] / "test/fixtures/et-oracle.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(
            {
                "oracle": "goodwe 0.4.10",
                "runtime": runtime.hex(),
                "battery": battery.hex(),
                "meter": meter.hex(),
                "values": {key: safe(value) for key, value in values.items()},
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(values)} expected values to {destination}")


if __name__ == "__main__":
    main()
