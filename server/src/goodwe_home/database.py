from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import UTC, date, datetime, timedelta
from datetime import time as datetime_time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .models import (
    EnergyCounters,
    EventItem,
    HistoryPoint,
    HistoryResponse,
    NormalizedSnapshot,
    SummaryResponse,
)
from .normalization import json_safe


class DashboardDatabase:
    def __init__(self, path: Path, timezone_name: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.timezone = ZoneInfo(timezone_name)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._initialize()

    def _initialize(self) -> None:
        statements = [
            "PRAGMA journal_mode=WAL",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA foreign_keys=ON",
            """
            CREATE TABLE IF NOT EXISTS samples (
                collected_ts REAL PRIMARY KEY,
                collected_at TEXT NOT NULL,
                inverter_at TEXT,
                connection_state TEXT NOT NULL,
                pv_w REAL NOT NULL,
                home_w REAL NOT NULL,
                grid_w REAL NOT NULL,
                battery_w REAL NOT NULL,
                backup_w REAL NOT NULL,
                battery_soc_pct REAL NOT NULL,
                grid_voltage_v REAL NOT NULL,
                grid_frequency_hz REAL NOT NULL,
                inverter_temperature_c REAL NOT NULL,
                snapshot_json TEXT NOT NULL,
                raw_json TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS aggregates (
                resolution TEXT NOT NULL,
                bucket_ts INTEGER NOT NULL,
                pv_w REAL NOT NULL,
                home_w REAL NOT NULL,
                grid_w REAL NOT NULL,
                battery_w REAL NOT NULL,
                backup_w REAL NOT NULL,
                battery_soc_pct REAL NOT NULL,
                grid_voltage_v REAL NOT NULL,
                grid_frequency_hz REAL NOT NULL,
                inverter_temperature_c REAL NOT NULL,
                sample_count INTEGER NOT NULL,
                PRIMARY KEY (resolution, bucket_ts)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS daily_energy (
                day TEXT PRIMARY KEY,
                solar_kwh REAL NOT NULL,
                load_kwh REAL NOT NULL,
                export_kwh REAL NOT NULL,
                import_kwh REAL NOT NULL,
                battery_charge_kwh REAL NOT NULL,
                battery_discharge_kwh REAL NOT NULL,
                peak_pv_w REAL NOT NULL,
                peak_home_w REAL NOT NULL,
                minimum_soc_pct REAL NOT NULL,
                maximum_soc_pct REAL NOT NULL,
                sample_count INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_ts REAL NOT NULL,
                created_at TEXT NOT NULL,
                severity TEXT NOT NULL,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                details_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS runtime_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_samples_collected_ts ON samples(collected_ts)",
            (
                "CREATE INDEX IF NOT EXISTS idx_aggregates_resolution_ts "
                "ON aggregates(resolution, bucket_ts)"
            ),
            "CREATE INDEX IF NOT EXISTS idx_events_created_ts ON events(created_ts DESC)",
        ]
        with self._lock:
            for statement in statements:
                self._connection.execute(statement)
            self._connection.execute("PRAGMA optimize")
            self._connection.commit()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def get_runtime_setting(self, key: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM runtime_settings WHERE key = ?", (key,)
            ).fetchone()
        return str(row["value"]) if row else None

    def set_runtime_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO runtime_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value=excluded.value,
                    updated_at=excluded.updated_at
                """,
                (key, value, datetime.now(UTC).isoformat()),
            )
            self._connection.commit()

    def record_snapshot(
        self,
        snapshot: NormalizedSnapshot,
        raw: dict[str, Any] | None,
    ) -> None:
        collected = snapshot.connection.last_updated
        if collected is None:
            return
        timestamp = collected.timestamp()
        snapshot_json = snapshot.model_dump_json()
        raw_json = json.dumps(json_safe(raw), separators=(",", ":")) if raw else None
        local_day = collected.astimezone(self.timezone).date().isoformat()

        values = (
            timestamp,
            collected.isoformat(),
            snapshot.connection.inverter_time.isoformat()
            if snapshot.connection.inverter_time
            else None,
            snapshot.connection.state,
            snapshot.power.pv_w,
            snapshot.power.home_w,
            snapshot.power.grid_w,
            snapshot.power.battery_w,
            snapshot.power.backup_w,
            snapshot.power.battery_soc_pct,
            snapshot.grid.voltage_v,
            snapshot.grid.frequency_hz,
            snapshot.system.temperature_radiator_c,
            snapshot_json,
            raw_json,
        )
        with self._lock:
            self._connection.execute(
                """
                INSERT OR REPLACE INTO samples (
                    collected_ts, collected_at, inverter_at, connection_state,
                    pv_w, home_w, grid_w, battery_w, backup_w, battery_soc_pct,
                    grid_voltage_v, grid_frequency_hz, inverter_temperature_c,
                    snapshot_json, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
            self._connection.execute(
                """
                INSERT INTO daily_energy (
                    day, solar_kwh, load_kwh, export_kwh, import_kwh,
                    battery_charge_kwh, battery_discharge_kwh, peak_pv_w,
                    peak_home_w, minimum_soc_pct, maximum_soc_pct, sample_count,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(day) DO UPDATE SET
                    solar_kwh=excluded.solar_kwh,
                    load_kwh=excluded.load_kwh,
                    export_kwh=excluded.export_kwh,
                    import_kwh=excluded.import_kwh,
                    battery_charge_kwh=excluded.battery_charge_kwh,
                    battery_discharge_kwh=excluded.battery_discharge_kwh,
                    peak_pv_w=MAX(daily_energy.peak_pv_w, excluded.peak_pv_w),
                    peak_home_w=MAX(daily_energy.peak_home_w, excluded.peak_home_w),
                    minimum_soc_pct=MIN(daily_energy.minimum_soc_pct, excluded.minimum_soc_pct),
                    maximum_soc_pct=MAX(daily_energy.maximum_soc_pct, excluded.maximum_soc_pct),
                    sample_count=daily_energy.sample_count + 1,
                    updated_at=excluded.updated_at
                """,
                (
                    local_day,
                    snapshot.today.solar_kwh,
                    snapshot.today.load_kwh,
                    snapshot.today.export_kwh,
                    snapshot.today.import_kwh,
                    snapshot.today.battery_charge_kwh,
                    snapshot.today.battery_discharge_kwh,
                    snapshot.power.pv_w,
                    snapshot.power.home_w,
                    snapshot.power.battery_soc_pct,
                    snapshot.power.battery_soc_pct,
                    collected.isoformat(),
                ),
            )
            self._connection.commit()

    def add_event(
        self,
        severity: str,
        event_type: str,
        message: str,
        details: dict[str, Any] | None = None,
        *,
        created_at: datetime | None = None,
    ) -> int:
        created = created_at or datetime.now(UTC)
        with self._lock:
            cursor = self._connection.execute(
                """
                INSERT INTO events (
                    created_ts, created_at, severity, event_type, message, details_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    created.timestamp(),
                    created.isoformat(),
                    severity,
                    event_type,
                    message,
                    json.dumps(json_safe(details or {}), separators=(",", ":")),
                ),
            )
            self._connection.commit()
            return int(cursor.lastrowid)

    def list_events(self, limit: int = 100) -> list[EventItem]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM events ORDER BY created_ts DESC LIMIT ?", (limit,)
            ).fetchall()
        return [
            EventItem(
                id=row["id"],
                created_at=datetime.fromisoformat(row["created_at"]),
                severity=row["severity"],
                event_type=row["event_type"],
                message=row["message"],
                details=json.loads(row["details_json"]),
            )
            for row in rows
        ]

    def latest_snapshot(self) -> NormalizedSnapshot | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT snapshot_json FROM samples ORDER BY collected_ts DESC LIMIT 1"
            ).fetchone()
        return NormalizedSnapshot.model_validate_json(row["snapshot_json"]) if row else None

    def _period_bounds(
        self, period: str, anchor: date | None = None
    ) -> tuple[datetime, datetime, str]:
        durations = {
            "day": timedelta(days=1),
            "week": timedelta(days=7),
            "month": timedelta(days=30),
            "year": timedelta(days=365),
        }
        resolution = "10s" if period == "day" else "1m" if period in {"week", "month"} else "15m"
        if anchor is None:
            now = datetime.now(UTC)
            return now - durations.get(period, durations["day"]), now, resolution

        if period == "day":
            start_date = anchor
            end_date = anchor + timedelta(days=1)
        elif period == "week":
            end_date = anchor + timedelta(days=1)
            start_date = end_date - timedelta(days=7)
        elif period == "month":
            start_date = anchor.replace(day=1)
            end_date = date(
                start_date.year + (start_date.month == 12),
                start_date.month % 12 + 1,
                1,
            )
        else:
            start_date = date(anchor.year, 1, 1)
            end_date = date(anchor.year + 1, 1, 1)

        start = datetime.combine(start_date, datetime_time.min, tzinfo=self.timezone).astimezone(
            UTC
        )
        end = datetime.combine(end_date, datetime_time.min, tzinfo=self.timezone).astimezone(UTC)
        return start, end, resolution

    def history(self, period: str, anchor: date | None = None) -> HistoryResponse:
        start, end, resolution = self._period_bounds(period, anchor)
        if resolution == "10s":
            query = """
                SELECT collected_ts AS timestamp, pv_w, home_w, grid_w, battery_w,
                       backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                       inverter_temperature_c
                FROM samples WHERE collected_ts >= ? AND collected_ts < ? ORDER BY collected_ts
            """
            params: tuple[Any, ...] = (start.timestamp(), end.timestamp())
        else:
            query = """
                SELECT bucket_ts AS timestamp, pv_w, home_w, grid_w, battery_w,
                       backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                       inverter_temperature_c
                FROM aggregates
                WHERE resolution = ? AND bucket_ts >= ? AND bucket_ts < ? ORDER BY bucket_ts
            """
            params = (resolution, start.timestamp(), end.timestamp())

        with self._lock:
            rows = self._connection.execute(query, params).fetchall()
            if not rows and resolution != "10s":
                rows = self._connection.execute(
                    """
                    SELECT collected_ts AS timestamp, pv_w, home_w, grid_w, battery_w,
                           backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                           inverter_temperature_c
                    FROM samples WHERE collected_ts >= ? AND collected_ts < ? ORDER BY collected_ts
                    """,
                    (start.timestamp(), end.timestamp()),
                ).fetchall()
                resolution = "10s"

        points = [
            HistoryPoint(
                timestamp=datetime.fromtimestamp(row["timestamp"], UTC),
                pv_w=row["pv_w"],
                home_w=row["home_w"],
                grid_w=row["grid_w"],
                battery_w=row["battery_w"],
                backup_w=row["backup_w"],
                battery_soc_pct=row["battery_soc_pct"],
                grid_voltage_v=row["grid_voltage_v"],
                grid_frequency_hz=row["grid_frequency_hz"],
                inverter_temperature_c=row["inverter_temperature_c"],
            )
            for row in rows
        ]
        return HistoryResponse(
            period=period,
            resolution=resolution,
            start=start,
            end=end,
            points=points,
        )

    def summary(self, period: str, anchor: date | None = None) -> SummaryResponse:
        start, end, _ = self._period_bounds(period, anchor)
        start_day = start.astimezone(self.timezone).date().isoformat()
        end_day = (end - timedelta(microseconds=1)).astimezone(self.timezone).date().isoformat()
        with self._lock:
            energy_rows = self._connection.execute(
                "SELECT * FROM daily_energy WHERE day BETWEEN ? AND ? ORDER BY day",
                (start_day, end_day),
            ).fetchall()
            stats = self._connection.execute(
                """
                SELECT MAX(pv_w) AS peak_pv_w, MAX(home_w) AS peak_home_w,
                       MIN(battery_soc_pct) AS minimum_soc_pct,
                       MAX(battery_soc_pct) AS maximum_soc_pct,
                       COUNT(*) AS sample_count,
                       MIN(collected_ts) AS first_sample_ts,
                       MAX(collected_ts) AS last_sample_ts
                FROM samples WHERE collected_ts >= ? AND collected_ts < ?
                """,
                (start.timestamp(), end.timestamp()),
            ).fetchone()

        energy = EnergyCounters(
            solar_kwh=sum(row["solar_kwh"] for row in energy_rows),
            load_kwh=sum(row["load_kwh"] for row in energy_rows),
            export_kwh=sum(row["export_kwh"] for row in energy_rows),
            import_kwh=sum(row["import_kwh"] for row in energy_rows),
            battery_charge_kwh=sum(row["battery_charge_kwh"] for row in energy_rows),
            battery_discharge_kwh=sum(row["battery_discharge_kwh"] for row in energy_rows),
        )
        observed_seconds = (
            (stats["last_sample_ts"] - stats["first_sample_ts"])
            if stats["first_sample_ts"] is not None
            else 0
        )
        expected = max(1, observed_seconds / 10 + 1)
        availability = min(100, (stats["sample_count"] or 0) / expected * 100)
        independence = (
            max(0, min(100, (energy.load_kwh - energy.import_kwh) / energy.load_kwh * 100))
            if energy.load_kwh
            else None
        )
        retention = (
            max(0, min(100, (energy.solar_kwh - energy.export_kwh) / energy.solar_kwh * 100))
            if energy.solar_kwh
            else None
        )
        return SummaryResponse(
            period=period,
            energy=energy,
            peak_pv_w=stats["peak_pv_w"] or 0,
            peak_home_w=stats["peak_home_w"] or 0,
            minimum_soc_pct=stats["minimum_soc_pct"],
            maximum_soc_pct=stats["maximum_soc_pct"],
            availability_pct=availability,
            grid_independence_pct=independence,
            solar_retention_pct=retention,
        )

    def rollup_and_retain(self, now: float | None = None) -> None:
        now_ts = now or time.time()
        with self._lock:
            for resolution, seconds in (("1m", 60), ("15m", 900)):
                self._connection.execute(
                    """
                    INSERT OR REPLACE INTO aggregates (
                        resolution, bucket_ts, pv_w, home_w, grid_w, battery_w,
                        backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                        inverter_temperature_c, sample_count
                    )
                    SELECT ?, CAST(collected_ts / ? AS INTEGER) * ?,
                           AVG(pv_w), AVG(home_w), AVG(grid_w), AVG(battery_w),
                           AVG(backup_w), AVG(battery_soc_pct), AVG(grid_voltage_v),
                           AVG(grid_frequency_hz), AVG(inverter_temperature_c), COUNT(*)
                    FROM samples WHERE collected_ts < ?
                    GROUP BY CAST(collected_ts / ? AS INTEGER)
                    """,
                    (resolution, seconds, seconds, now_ts - seconds, seconds),
                )
            self._connection.execute(
                "DELETE FROM samples WHERE collected_ts < ?", (now_ts - 30 * 86400,)
            )
            self._connection.execute(
                "DELETE FROM aggregates WHERE resolution='1m' AND bucket_ts < ?",
                (now_ts - 365 * 86400,),
            )
            self._connection.execute("PRAGMA optimize")
            self._connection.commit()

    def export_rows(self, period: str, anchor: date | None = None) -> list[dict[str, Any]]:
        history = self.history(period, anchor)
        return [point.model_dump(mode="json") for point in history.points]
