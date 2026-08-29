#!/usr/bin/env python3
"""Generate the immutable ET decoder manifest from the pinned desktop oracle."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import sqlite3
from pathlib import Path

from goodwe.et import ET


def field(sensor: object, frame: str) -> dict[str, object]:
    value: dict[str, object] = {
        "id": sensor.id_,
        "name": sensor.name,
        "unit": sensor.unit,
        "kind": sensor.kind.name if sensor.kind else "OTHER",
        "type": type(sensor).__name__,
        "frame": frame,
        "register": sensor.offset,
        "bytes": sensor.size_,
    }
    if hasattr(sensor, "scale"):
        value["scale"] = sensor.scale
    if hasattr(sensor, "_labels"):
        value["labels"] = {str(key): label for key, label in sensor._labels.items()}
    if hasattr(sensor, "_offsetL"):
        value["low_register"] = sensor._offsetL
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--oracle-db",
        type=Path,
        required=True,
        help="Desktop SQLite database containing the validated 145-key raw schema",
    )
    return parser.parse_args()


def oracle_keys(database: Path) -> set[str]:
    if not database.is_file():
        raise SystemExit(f"Oracle database does not exist: {database}")
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        row = connection.execute(
            "SELECT raw_json FROM samples WHERE raw_json IS NOT NULL "
            "ORDER BY collected_ts DESC LIMIT 1"
        ).fetchone()
    if not row:
        raise SystemExit("Oracle database contains no raw snapshot")
    keys = set(json.loads(row[0]))
    if len(keys) != 145:
        raise SystemExit(f"Expected the validated 145-key schema, found {len(keys)} keys")
    return keys


def main() -> None:
    args = parse_args()
    expected_keys = oracle_keys(args.oracle_db)
    inverter = ET("0.0.0.0", 502)
    selections = [
        ("runtime", inverter._ET__all_sensors, 35100, 125),
        ("battery", inverter._ET__all_sensors_battery, 37000, 24),
        ("meter", inverter._ET__all_sensors_meter, 36000, 45),
    ]
    fields: list[dict[str, object]] = []
    for frame_name, sensors, first, registers in selections:
        last_byte = (first + registers) * 2
        for sensor in sensors:
            if sensor.id_ in expected_keys and (
                sensor.offset == 0 or sensor.offset * 2 + sensor.size_ <= last_byte
            ):
                fields.append(field(sensor, frame_name))
    found = {value["id"] for value in fields}
    if found != expected_keys:
        missing = sorted(expected_keys - found)
        extra = sorted(found - expected_keys)
        raise SystemExit(f"Oracle schema mismatch; missing={missing}, extra={extra}")
    payload = {
        "format": 1,
        "oracle": f"goodwe {importlib.metadata.version('goodwe')}",
        "approved_ranges": {
            "runtime": {"register": 35100, "count": 125},
            "battery": {"register": 37000, "count": 24},
            "meter": {"register": 36000, "count": 45},
        },
        "field_count": len(fields),
        "fields": fields,
    }
    destination = Path(__file__).resolve().parents[1] / "decoder-manifest.json"
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {len(fields)} oracle fields to {destination}")


if __name__ == "__main__":
    main()
