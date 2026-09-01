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
    DailyEnergyPoint,
    DaylightCoverageObservation,
    EnergyCounters,
    EventItem,
    ForecastCalibrationObservation,
    ForecastRun,
    HistoryPoint,
    HistoryResponse,
    LoadObservation,
    MpptTotals,
    NormalizedSnapshot,
    OutageItem,
    PeakMetric,
    SummaryResponse,
)
from .normalization import json_safe


class DashboardDatabase:
    def __init__(self, path: Path, timezone_name: str, poll_interval_seconds: int = 10) -> None:
        self._was_existing = path.exists() and path.stat().st_size > 0
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.timezone = ZoneInfo(timezone_name)
        self.poll_interval_seconds = max(1, poll_interval_seconds)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._backup_before_migration()
        self._initialize()

    def _backup_before_migration(self) -> None:
        if not self._was_existing:
            return
        version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        if version >= 1:
            return
        backup_path = self.path.with_suffix(f"{self.path.suffix}.pre-command-center.bak")
        if backup_path.exists():
            return
        backup = sqlite3.connect(backup_path)
        try:
            self._connection.backup(backup)
        finally:
            backup.close()

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
                mppt1_w REAL,
                mppt2_w REAL,
                battery_temperature_c REAL,
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
                mppt1_w REAL,
                mppt2_w REAL,
                battery_temperature_c REAL,
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
            """
            CREATE TABLE IF NOT EXISTS outages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_ts REAL NOT NULL UNIQUE,
                start_at TEXT NOT NULL,
                end_ts REAL,
                end_at TEXT,
                duration_seconds REAL,
                start_soc_pct REAL,
                end_soc_pct REAL,
                confidence REAL NOT NULL DEFAULT 1,
                detection_version INTEGER NOT NULL DEFAULT 1
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS daily_peaks (
                day TEXT NOT NULL,
                metric TEXT NOT NULL,
                value REAL NOT NULL,
                unit TEXT NOT NULL,
                occurred_ts REAL NOT NULL,
                occurred_at TEXT NOT NULL,
                PRIMARY KEY (day, metric)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS forecast_runs (
                issued_ts REAL PRIMARY KEY,
                issued_at TEXT NOT NULL,
                provider TEXT NOT NULL,
                points_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_samples_collected_ts ON samples(collected_ts)",
            (
                "CREATE INDEX IF NOT EXISTS idx_aggregates_resolution_ts "
                "ON aggregates(resolution, bucket_ts)"
            ),
            "CREATE INDEX IF NOT EXISTS idx_events_created_ts ON events(created_ts DESC)",
            "CREATE INDEX IF NOT EXISTS idx_outages_start_ts ON outages(start_ts DESC)",
        ]
        with self._lock:
            for statement in statements:
                self._connection.execute(statement)
            self._connection.execute("PRAGMA optimize")
            self._connection.commit()
        self._migrate()
        self._grid_candidate_since: datetime | None = None
        self._grid_candidate_soc: float | None = None
        self._grid_recovery_since: datetime | None = None
        self._grid_recovery_soc: float | None = None
        latest = self._connection.execute(
            "SELECT collected_at, battery_soc_pct FROM samples ORDER BY collected_ts DESC LIMIT 1"
        ).fetchone()
        self._last_grid_observed_at = (
            datetime.fromisoformat(latest["collected_at"]) if latest else None
        )
        self._last_grid_soc = float(latest["battery_soc_pct"]) if latest else None

    def _migrate(self) -> None:
        with self._lock:
            version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            if version >= 1:
                return

            for table in ("samples", "aggregates"):
                columns = {
                    row[1]
                    for row in self._connection.execute(f"PRAGMA table_info({table})").fetchall()
                }
                for column in ("mppt1_w", "mppt2_w", "battery_temperature_c"):
                    if column not in columns:
                        self._connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} REAL")

            self._connection.execute(
                """
                UPDATE samples SET
                    mppt1_w=json_extract(raw_json, '$.ppv1'),
                    mppt2_w=json_extract(raw_json, '$.ppv2'),
                    battery_temperature_c=json_extract(raw_json, '$.battery_temperature')
                WHERE mppt1_w IS NULL OR mppt2_w IS NULL OR battery_temperature_c IS NULL
                """
            )
            self._backfill_command_center_facts()
            self._connection.execute("PRAGMA user_version=1")
            self._connection.commit()

    def _backfill_command_center_facts(self) -> None:
        rows = self._connection.execute(
            """
            SELECT collected_ts, collected_at, connection_state, pv_w, home_w, grid_w,
                   battery_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                   inverter_temperature_c, battery_temperature_c
            FROM samples ORDER BY collected_ts
            """
        ).fetchall()
        peaks: dict[tuple[str, str], tuple[float, str, float, str]] = {}
        definitions = (
            ("pv_w", "W", lambda row: max(0, float(row["pv_w"]))),
            ("home_w", "W", lambda row: max(0, float(row["home_w"]))),
            ("grid_import_w", "W", lambda row: max(0, -float(row["grid_w"]))),
            (
                "battery_discharge_w",
                "W",
                lambda row: max(0, float(row["battery_w"])),
            ),
            (
                "inverter_temperature_c",
                "°C",
                lambda row: float(row["inverter_temperature_c"]),
            ),
            (
                "battery_temperature_c",
                "°C",
                lambda row: (
                    float(row["battery_temperature_c"])
                    if row["battery_temperature_c"] is not None
                    else None
                ),
            ),
        )
        for row in rows:
            observed = datetime.fromisoformat(row["collected_at"])
            day = observed.astimezone(self.timezone).date().isoformat()
            for metric, unit, getter in definitions:
                value = getter(row)
                if value is None:
                    continue
                key = (day, metric)
                if key not in peaks or value > peaks[key][0]:
                    peaks[key] = (value, unit, float(row["collected_ts"]), row["collected_at"])
        for (day, metric), (value, unit, occurred_ts, occurred_at) in peaks.items():
            self._connection.execute(
                """
                INSERT OR IGNORE INTO daily_peaks (
                    day, metric, value, unit, occurred_ts, occurred_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (day, metric, value, unit, occurred_ts, occurred_at),
            )

        invalid_start = invalid_last = recovery_start = None
        start_soc = recovery_soc = None
        previous_ts: float | None = None
        for row in rows:
            timestamp = float(row["collected_ts"])
            if previous_ts is not None and timestamp - previous_ts > 30:
                invalid_start = invalid_last = recovery_start = None
                start_soc = recovery_soc = None
            previous_ts = timestamp
            live = row["connection_state"] == "live"
            grid_available = (
                live
                and float(row["grid_voltage_v"]) >= 180
                and 45 <= float(row["grid_frequency_hz"]) <= 55
            )
            if not live:
                invalid_start = invalid_last = recovery_start = None
                continue
            if not grid_available:
                recovery_start = recovery_soc = None
                if invalid_start is None:
                    invalid_start = timestamp
                    start_soc = float(row["battery_soc_pct"])
                invalid_last = timestamp
                continue
            if invalid_start is None or invalid_last is None or invalid_last - invalid_start < 30:
                invalid_start = invalid_last = None
                continue
            if recovery_start is None:
                recovery_start = timestamp
                recovery_soc = float(row["battery_soc_pct"])
                continue
            if timestamp - recovery_start < 30:
                continue
            self._connection.execute(
                """
                INSERT OR IGNORE INTO outages (
                    start_ts, start_at, end_ts, end_at, duration_seconds,
                    start_soc_pct, end_soc_pct, confidence, detection_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.75, 0)
                """,
                (
                    invalid_start,
                    datetime.fromtimestamp(invalid_start, UTC).isoformat(),
                    recovery_start,
                    datetime.fromtimestamp(recovery_start, UTC).isoformat(),
                    recovery_start - invalid_start,
                    start_soc,
                    recovery_soc,
                ),
            )
            invalid_start = invalid_last = recovery_start = None
            start_soc = recovery_soc = None

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
        *,
        persist_raw: bool = True,
    ) -> None:
        collected = snapshot.connection.last_updated
        if collected is None:
            return
        timestamp = collected.timestamp()
        snapshot_json = snapshot.model_dump_json()
        raw_json = (
            json.dumps(json_safe(raw), separators=(",", ":")) if raw and persist_raw else None
        )
        mppt1_w = snapshot.solar.mppt1.power_w if raw and "ppv1" in raw else None
        mppt2_w = snapshot.solar.mppt2.power_w if raw and "ppv2" in raw else None
        battery_temperature_c = (
            snapshot.battery.temperature_c if raw and "battery_temperature" in raw else None
        )
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
            mppt1_w,
            mppt2_w,
            battery_temperature_c,
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
                    mppt1_w, mppt2_w, battery_temperature_c, snapshot_json, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            peak_values = (
                ("pv_w", max(0, snapshot.power.pv_w), "W"),
                ("home_w", max(0, snapshot.power.home_w), "W"),
                ("grid_import_w", max(0, -snapshot.power.grid_w), "W"),
                ("battery_discharge_w", max(0, snapshot.power.battery_w), "W"),
                (
                    "inverter_temperature_c",
                    snapshot.system.temperature_radiator_c,
                    "°C",
                ),
                ("battery_temperature_c", snapshot.battery.temperature_c, "°C"),
            )
            for metric, value, unit in peak_values:
                self._connection.execute(
                    """
                    INSERT INTO daily_peaks (
                        day, metric, value, unit, occurred_ts, occurred_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(day, metric) DO UPDATE SET
                        value=excluded.value,
                        unit=excluded.unit,
                        occurred_ts=excluded.occurred_ts,
                        occurred_at=excluded.occurred_at
                    WHERE excluded.value > daily_peaks.value
                    """,
                    (local_day, metric, value, unit, timestamp, collected.isoformat()),
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

    def observe_grid(self, snapshot: NormalizedSnapshot) -> None:
        observed_at = snapshot.connection.last_updated
        if observed_at is None or snapshot.connection.state != "live":
            return
        mode = snapshot.grid.grid_mode.lower()
        grid_available = (
            snapshot.grid.voltage_v >= 180
            and 45 <= snapshot.grid.frequency_hz <= 55
            and "not connected" not in mode
            and "off grid" not in mode
        )
        with self._lock:
            open_row = self._connection.execute(
                "SELECT * FROM outages WHERE end_ts IS NULL ORDER BY start_ts DESC LIMIT 1"
            ).fetchone()
            maximum_live_gap = max(30, self.poll_interval_seconds * 3)
            if (
                self._last_grid_observed_at is not None
                and (observed_at - self._last_grid_observed_at).total_seconds() > maximum_live_gap
            ):
                self._grid_candidate_since = None
                self._grid_candidate_soc = None
                self._grid_recovery_since = None
                self._grid_recovery_soc = None
                if open_row:
                    end_at = self._last_grid_observed_at
                    duration = max(0, end_at.timestamp() - float(open_row["start_ts"]))
                    self._connection.execute(
                        """
                        UPDATE outages
                        SET end_ts=?, end_at=?, duration_seconds=?, end_soc_pct=?
                        WHERE id=? AND end_ts IS NULL
                        """,
                        (
                            end_at.timestamp(),
                            end_at.isoformat(),
                            duration,
                            self._last_grid_soc,
                            open_row["id"],
                        ),
                    )
                    self._connection.commit()
                    open_row = None
            self._last_grid_observed_at = observed_at
            self._last_grid_soc = snapshot.power.battery_soc_pct

            if not grid_available:
                self._grid_recovery_since = None
                self._grid_recovery_soc = None
                if open_row:
                    return
                if self._grid_candidate_since is None:
                    self._grid_candidate_since = observed_at
                    self._grid_candidate_soc = snapshot.power.battery_soc_pct
                    return
                if (observed_at - self._grid_candidate_since).total_seconds() < 30:
                    return
                self._connection.execute(
                    """
                    INSERT OR IGNORE INTO outages (
                        start_ts, start_at, start_soc_pct, confidence, detection_version
                    ) VALUES (?, ?, ?, 1, 1)
                    """,
                    (
                        self._grid_candidate_since.timestamp(),
                        self._grid_candidate_since.isoformat(),
                        self._grid_candidate_soc,
                    ),
                )
                self._connection.commit()
                self._grid_candidate_since = None
                self._grid_candidate_soc = None
                return

            self._grid_candidate_since = None
            self._grid_candidate_soc = None
            if not open_row:
                self._grid_recovery_since = None
                self._grid_recovery_soc = None
                return
            if self._grid_recovery_since is None:
                self._grid_recovery_since = observed_at
                self._grid_recovery_soc = snapshot.power.battery_soc_pct
                return
            if (observed_at - self._grid_recovery_since).total_seconds() < 30:
                return
            end_at = self._grid_recovery_since
            duration = max(0, end_at.timestamp() - float(open_row["start_ts"]))
            self._connection.execute(
                """
                UPDATE outages SET end_ts=?, end_at=?, duration_seconds=?, end_soc_pct=?
                WHERE id=? AND end_ts IS NULL
                """,
                (
                    end_at.timestamp(),
                    end_at.isoformat(),
                    duration,
                    self._grid_recovery_soc,
                    open_row["id"],
                ),
            )
            self._connection.commit()
            self._grid_recovery_since = None
            self._grid_recovery_soc = None

    def list_outages(self, limit: int = 100) -> list[OutageItem]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM outages ORDER BY start_ts DESC LIMIT ?", (limit,)
            ).fetchall()
        return [
            OutageItem(
                id=row["id"],
                start_at=datetime.fromisoformat(row["start_at"]),
                end_at=datetime.fromisoformat(row["end_at"]) if row["end_at"] else None,
                duration_seconds=row["duration_seconds"],
                start_soc_pct=row["start_soc_pct"],
                end_soc_pct=row["end_soc_pct"],
                confidence=row["confidence"],
                ongoing=row["end_ts"] is None,
            )
            for row in rows
        ]

    def short_history(self, seconds: int, now: datetime) -> HistoryResponse:
        start = now - timedelta(seconds=seconds)
        if seconds <= 3 * 3600:
            resolution = "10s"
            query = """
                SELECT collected_ts AS timestamp, pv_w, home_w, grid_w, battery_w,
                       backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                       inverter_temperature_c
                FROM samples WHERE collected_ts >= ? AND collected_ts <= ? ORDER BY collected_ts
            """
            params: tuple[Any, ...] = (start.timestamp(), now.timestamp())
        else:
            resolution = "1m"
            query = """
                SELECT bucket_ts AS timestamp, pv_w, home_w, grid_w, battery_w,
                       backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                       inverter_temperature_c
                FROM aggregates WHERE resolution='1m' AND bucket_ts >= ? AND bucket_ts <= ?
                ORDER BY bucket_ts
            """
            params = (start.timestamp(), now.timestamp())
        with self._lock:
            rows = self._connection.execute(query, params).fetchall()
            if rows and resolution == "1m":
                rows = self._merge_live_aggregate_tail(
                    rows,
                    start_ts=start.timestamp(),
                    end_ts=now.timestamp(),
                    bucket_seconds=60,
                )
            elif not rows and resolution == "1m":
                rows = self._connection.execute(
                    """
                    SELECT collected_ts AS timestamp, pv_w, home_w, grid_w, battery_w,
                           backup_w, battery_soc_pct, grid_voltage_v, grid_frequency_hz,
                           inverter_temperature_c
                    FROM samples WHERE collected_ts >= ? AND collected_ts <= ? ORDER BY collected_ts
                    """,
                    params,
                ).fetchall()
                resolution = "10s"
        return HistoryResponse(
            period=f"{seconds}s",
            resolution=resolution,
            start=start,
            end=now,
            points=[
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
            ],
        )

    def _merge_live_aggregate_tail(
        self,
        rows: list[sqlite3.Row],
        *,
        start_ts: float,
        end_ts: float,
        bucket_seconds: int,
    ) -> list[sqlite3.Row]:
        """Replace the final rollup bucket and append newer retained samples."""
        tail_start = max(start_ts, float(rows[-1]["timestamp"]))
        tail_rows = self._connection.execute(
            """
            SELECT CAST(collected_ts / ? AS INTEGER) * ? AS timestamp,
                   AVG(pv_w) AS pv_w, AVG(home_w) AS home_w,
                   AVG(grid_w) AS grid_w, AVG(battery_w) AS battery_w,
                   AVG(backup_w) AS backup_w,
                   AVG(battery_soc_pct) AS battery_soc_pct,
                   AVG(grid_voltage_v) AS grid_voltage_v,
                   AVG(grid_frequency_hz) AS grid_frequency_hz,
                   AVG(inverter_temperature_c) AS inverter_temperature_c
            FROM samples WHERE collected_ts >= ? AND collected_ts < ?
            GROUP BY CAST(collected_ts / ? AS INTEGER)
            ORDER BY timestamp
            """,
            (bucket_seconds, bucket_seconds, tail_start, end_ts, bucket_seconds),
        ).fetchall()
        points_by_timestamp = {int(row["timestamp"]): row for row in rows}
        points_by_timestamp.update({int(row["timestamp"]): row for row in tail_rows})
        return [points_by_timestamp[key] for key in sorted(points_by_timestamp)]

    def daily_history(self, days: int, now: datetime) -> list[DailyEnergyPoint]:
        local_today = now.astimezone(self.timezone).date()
        first_day = (local_today - timedelta(days=days - 1)).isoformat()
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM daily_energy WHERE day >= ? ORDER BY day", (first_day,)
            ).fetchall()
        return [
            DailyEnergyPoint(
                day=row["day"],
                energy=EnergyCounters(
                    solar_kwh=row["solar_kwh"],
                    load_kwh=row["load_kwh"],
                    export_kwh=row["export_kwh"],
                    import_kwh=row["import_kwh"],
                    battery_charge_kwh=row["battery_charge_kwh"],
                    battery_discharge_kwh=row["battery_discharge_kwh"],
                ),
                peak_pv_w=row["peak_pv_w"],
                peak_home_w=row["peak_home_w"],
                coverage_pct=self._coverage_pct(row["day"], row["sample_count"]),
            )
            for row in rows
        ]

    def _coverage_pct(self, day: str, sample_count: int) -> float:
        local_day = date.fromisoformat(day)
        start = datetime.combine(local_day, datetime_time.min, tzinfo=self.timezone)
        end = datetime.combine(
            local_day + timedelta(days=1), datetime_time.min, tzinfo=self.timezone
        )
        expected = max(
            1,
            (end.astimezone(UTC) - start.astimezone(UTC)).total_seconds()
            / self.poll_interval_seconds,
        )
        return min(100, sample_count / expected * 100)

    def daily_peaks(self, day: str) -> list[PeakMetric]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM daily_peaks WHERE day = ? ORDER BY metric", (day,)
            ).fetchall()
        return [
            PeakMetric(
                metric=row["metric"],
                value=row["value"],
                unit=row["unit"],
                occurred_at=datetime.fromisoformat(row["occurred_at"]),
            )
            for row in rows
        ]

    def yesterday_same_time(self, now: datetime) -> EnergyCounters | None:
        target = now - timedelta(days=1)
        with self._lock:
            row = self._connection.execute(
                """
                SELECT snapshot_json FROM samples
                WHERE collected_ts BETWEEN ? AND ?
                ORDER BY ABS(collected_ts - ?) LIMIT 1
                """,
                (target.timestamp() - 300, target.timestamp() + 300, target.timestamp()),
            ).fetchone()
        if not row:
            return None
        snapshot = NormalizedSnapshot.model_validate_json(row["snapshot_json"])
        return snapshot.today

    def store_forecast(self, run: ForecastRun) -> None:
        metadata = {
            **run.metadata,
            "weather_days": [day.model_dump(mode="json") for day in run.weather_days],
        }
        with self._lock:
            self._connection.execute(
                """
                INSERT OR REPLACE INTO forecast_runs (
                    issued_ts, issued_at, provider, points_json, metadata_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    run.issued_at.timestamp(),
                    run.issued_at.isoformat(),
                    run.provider,
                    json.dumps(
                        [point.model_dump(mode="json") for point in run.points],
                        separators=(",", ":"),
                    ),
                    json.dumps(metadata, separators=(",", ":")),
                ),
            )
            self._connection.execute(
                "DELETE FROM forecast_runs WHERE issued_ts < ?",
                (run.issued_at.timestamp() - 60 * 86400,),
            )
            self._connection.commit()

    def latest_forecast(self) -> ForecastRun | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM forecast_runs ORDER BY issued_ts DESC LIMIT 1"
            ).fetchone()
        if not row:
            return None
        metadata = json.loads(row["metadata_json"])
        weather_days = metadata.pop("weather_days", [])
        return ForecastRun(
            provider=row["provider"],
            issued_at=datetime.fromisoformat(row["issued_at"]),
            points=json.loads(row["points_json"]),
            weather_days=weather_days,
            metadata=metadata,
        )

    def forecast_calibration_observations(
        self, now: datetime, valid_days: set[str], days: int = 30
    ) -> list[ForecastCalibrationObservation]:
        first_day = (now.astimezone(self.timezone).date() - timedelta(days=days)).isoformat()
        with self._lock:
            daily_rows = self._connection.execute(
                "SELECT day, solar_kwh, sample_count FROM daily_energy WHERE day >= ?",
                (first_day,),
            ).fetchall()
            forecast_rows = self._connection.execute(
                "SELECT * FROM forecast_runs WHERE issued_ts >= ? ORDER BY issued_ts",
                (now.timestamp() - (days + 2) * 86400,),
            ).fetchall()
        actual = {
            row["day"]: float(row["solar_kwh"])
            for row in daily_rows
            if row["day"] in valid_days
            and row["day"] < now.astimezone(self.timezone).date().isoformat()
        }
        predictions: dict[str, tuple[float, float]] = {}
        for row in forecast_rows:
            issued = datetime.fromisoformat(row["issued_at"])
            totals: dict[str, float] = {}
            for point in json.loads(row["points_json"]):
                timestamp = datetime.fromisoformat(point["timestamp"])
                target_day = timestamp.astimezone(self.timezone).date().isoformat()
                totals[target_day] = (
                    totals.get(target_day, 0) + float(point.get("pv_w") or 0) / 1000
                )
            for target_day, predicted_kwh in totals.items():
                if target_day not in actual or predicted_kwh < 0.5:
                    continue
                previous = predictions.get(target_day)
                if previous is None or issued.timestamp() > previous[0]:
                    predictions[target_day] = (issued.timestamp(), predicted_kwh)
        return [
            ForecastCalibrationObservation(actual_kwh=actual[day], predicted_kwh=predicted_kwh)
            for day, (_, predicted_kwh) in predictions.items()
        ]

    def daylight_coverage_observations(
        self, now: datetime, days: int = 30
    ) -> list[DaylightCoverageObservation]:
        start = now - timedelta(days=days)
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT collected_ts FROM samples
                WHERE collected_ts BETWEEN ? AND ? ORDER BY collected_ts
                """,
                (start.timestamp(), now.timestamp()),
            ).fetchall()
        counts: dict[str, int] = {}
        for row in rows:
            local = datetime.fromtimestamp(row["collected_ts"], UTC).astimezone(self.timezone)
            if 6 <= local.hour < 18:
                day = local.date().isoformat()
                counts[day] = counts.get(day, 0) + 1
        expected = 12 * 3600 / self.poll_interval_seconds
        return [
            DaylightCoverageObservation(
                day=day, sample_count=sample_count, expected_samples=expected
            )
            for day, sample_count in counts.items()
        ]

    def load_observations(
        self, now: datetime, valid_day_limit: int = 15
    ) -> tuple[list[LoadObservation], int, int]:
        today = now.astimezone(self.timezone).date().isoformat()
        with self._lock:
            day_rows = self._connection.execute(
                """
                SELECT day, sample_count FROM daily_energy
                WHERE day < ?
                ORDER BY day DESC
                """,
                (today,),
            ).fetchall()
        valid_days = {
            row["day"]
            for row in day_rows
            if self._coverage_pct(row["day"], row["sample_count"]) >= 90
        }
        valid_days = set(sorted(valid_days, reverse=True)[:valid_day_limit])
        if not valid_days:
            return [], 0, 0
        first_day = min(valid_days)
        start = datetime.combine(
            date.fromisoformat(first_day), datetime_time.min, tzinfo=self.timezone
        ).astimezone(UTC)
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT bucket_ts, home_w FROM aggregates
                WHERE resolution='15m' AND bucket_ts BETWEEN ? AND ?
                ORDER BY bucket_ts
                """,
                (start.timestamp(), now.timestamp()),
            ).fetchall()
        observations: list[LoadObservation] = []
        weekday_days: set[str] = set()
        weekend_days: set[str] = set()
        for row in rows:
            local = datetime.fromtimestamp(row["bucket_ts"], UTC).astimezone(self.timezone)
            day = local.date().isoformat()
            if day not in valid_days:
                continue
            minute = local.hour * 60 + (local.minute // 15) * 15
            is_weekend = local.weekday() >= 5
            observations.append(
                LoadObservation(
                    minute_of_day=minute,
                    home_w=float(row["home_w"]),
                    weekend=is_weekend,
                )
            )
            if is_weekend:
                weekend_days.add(day)
            else:
                weekday_days.add(day)

        return observations, len(weekday_days), len(weekend_days)

    def mppt_totals(self, now: datetime, days: int = 30) -> MpptTotals:
        start = now - timedelta(days=days)
        with self._lock:
            row = self._connection.execute(
                """
                SELECT SUM(mppt1_w) AS mppt1, SUM(mppt2_w) AS mppt2,
                       COUNT(mppt1_w) AS mppt1_count, COUNT(mppt2_w) AS mppt2_count
                FROM aggregates
                WHERE resolution='15m' AND bucket_ts BETWEEN ? AND ?
                """,
                (start.timestamp(), now.timestamp()),
            ).fetchone()
        return MpptTotals(
            mppt1_w_samples=float(row["mppt1"]) if row["mppt1_count"] else None,
            mppt2_w_samples=float(row["mppt2"]) if row["mppt2_count"] else None,
        )

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
            if rows and resolution != "10s":
                rows = self._merge_live_aggregate_tail(
                    rows,
                    start_ts=start.timestamp(),
                    end_ts=end.timestamp(),
                    bucket_seconds=60 if resolution == "1m" else 15 * 60,
                )
            elif not rows and resolution != "10s":
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
        expected = max(1, observed_seconds / self.poll_interval_seconds + 1)
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
                        inverter_temperature_c, mppt1_w, mppt2_w,
                        battery_temperature_c, sample_count
                    )
                    SELECT ?, CAST(collected_ts / ? AS INTEGER) * ?,
                           AVG(pv_w), AVG(home_w), AVG(grid_w), AVG(battery_w),
                           AVG(backup_w), AVG(battery_soc_pct), AVG(grid_voltage_v),
                           AVG(grid_frequency_hz), AVG(inverter_temperature_c),
                           AVG(mppt1_w), AVG(mppt2_w), AVG(battery_temperature_c), COUNT(*)
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

    def export_daily_rows(self, period: str, anchor: date | None = None) -> list[dict[str, Any]]:
        start, end, _ = self._period_bounds(period, anchor)
        first_day = start.astimezone(self.timezone).date().isoformat()
        last_day = (end - timedelta(microseconds=1)).astimezone(self.timezone).date().isoformat()
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM daily_energy WHERE day BETWEEN ? AND ? ORDER BY day",
                (first_day, last_day),
            ).fetchall()
        return [
            {
                "day": row["day"],
                "solar_kwh": row["solar_kwh"],
                "load_kwh": row["load_kwh"],
                "export_kwh": row["export_kwh"],
                "import_kwh": row["import_kwh"],
                "battery_charge_kwh": row["battery_charge_kwh"],
                "battery_discharge_kwh": row["battery_discharge_kwh"],
                "peak_pv_w": row["peak_pv_w"],
                "peak_home_w": row["peak_home_w"],
            }
            for row in rows
        ]
