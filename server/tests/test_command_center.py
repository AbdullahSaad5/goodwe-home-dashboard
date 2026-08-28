import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from goodwe_home.analytics import CommandCenterAnalytics
from goodwe_home.config import Settings
from goodwe_home.database import DashboardDatabase
from goodwe_home.normalization import normalize_snapshot


def raw_sample(**overrides: float) -> dict[str, object]:
    data: dict[str, object] = {
        "ppv": 3000,
        "ppv1": 1500,
        "ppv2": 1500,
        "house_consumption": 2200,
        "active_power_total": 800,
        "pbattery1": 0,
        "backup_ptotal": 0,
        "battery_soc": 75,
        "battery_soh": 98,
        "battery_temperature": 26,
        "vgrid": 235,
        "fgrid": 50,
        "grid_mode_label": "Connected",
        "temperature": 42,
        "e_day": 8,
        "e_load_day": 6,
        "e_day_exp": 2,
        "e_day_imp": 0,
        "e_bat_charge_day": 1,
        "e_bat_discharge_day": 0.5,
        "e_total": 1000,
        "e_load_total": 900,
        "e_total_exp": 250,
        "e_total_imp": 150,
    }
    data.update(overrides)
    return data


def test_command_center_conserves_home_energy_mix(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    now = datetime(2026, 8, 28, 12, tzinfo=UTC)
    snapshot = normalize_snapshot(raw_sample(), collected_at=now)
    database.record_snapshot(snapshot, raw_sample())

    analytics = CommandCenterAnalytics(database, Settings())
    response = analytics.build(snapshot, trend_range="15m", history_range="14d", now=now)

    mix = response.live.energy_mix
    assert mix.home_w == 2200
    assert mix.solar_w + mix.battery_w + mix.grid_w == 2200
    assert mix.solar_w == 2200
    assert mix.battery_w == 0
    assert mix.grid_w == 0
    database.close()


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"ppv": 0, "house_consumption": 1000, "active_power_total": -1000}, (0, 0, 1000)),
        (
            {
                "ppv": 0,
                "house_consumption": 1000,
                "pbattery1": -500,
                "active_power_total": -1500,
            },
            (0, 0, 1000),
        ),
        ({"ppv": 3000, "house_consumption": 1000, "active_power_total": 2000}, (1000, 0, 0)),
    ],
)
def test_energy_mix_excludes_charging_and_exported_energy(
    tmp_path, overrides: dict[str, float], expected: tuple[float, float, float]
) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    snapshot = normalize_snapshot(raw_sample(**overrides), collected_at=datetime.now(UTC))
    mix = CommandCenterAnalytics(database, Settings())._live(snapshot).energy_mix
    assert (mix.solar_w, mix.battery_w, mix.grid_w) == expected
    assert mix.solar_w + mix.battery_w + mix.grid_w + mix.unaccounted_w == mix.home_w
    database.close()


def test_energy_mix_flags_meter_skew_without_fabricating_grid_supply(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    snapshot = normalize_snapshot(
        raw_sample(ppv=1000, house_consumption=2000, active_power_total=-500),
        collected_at=datetime.now(UTC),
    )
    live = CommandCenterAnalytics(database, Settings())._live(snapshot)
    assert live.power_balance == "mismatch"
    assert live.energy_mix.grid_w == 500
    assert live.energy_mix.unaccounted_w == 500
    database.close()


def test_command_center_reports_configuration_readiness(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    now = datetime(2026, 8, 28, 12, tzinfo=UTC)
    snapshot = normalize_snapshot(raw_sample(), collected_at=now)
    database.record_snapshot(snapshot, raw_sample())

    response = CommandCenterAnalytics(database, Settings()).build(
        snapshot, trend_range="15m", history_range="14d", now=now
    )

    assert response.forecast.status == "unconfigured"
    assert response.projection.status == "unconfigured"
    assert response.live.battery_reserve.status == "unconfigured"
    assert response.readiness["outage_outlook"].status == "collecting"
    database.close()


def test_stale_telemetry_marks_live_health_groups_stale(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    now = datetime(2026, 8, 28, 12, tzinfo=UTC)
    snapshot = normalize_snapshot(raw_sample(), collected_at=now)
    snapshot.connection = snapshot.connection.model_copy(update={"state": "stale"})

    response = CommandCenterAnalytics(database, Settings()).build(snapshot, now=now)

    assert response.readiness["live"].status == "stale"
    assert response.readiness["health"].status == "stale"
    assert {signal.status for signal in response.health} == {"stale"}
    database.close()


def test_database_persists_debounced_outage_with_soc_edges(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    start = datetime(2026, 8, 28, 12, tzinfo=UTC)

    for seconds, voltage, frequency, soc in (
        (0, 235, 50, 80),
        (10, 0, 0, 79),
        (20, 0, 0, 78),
        (40, 0, 0, 77),
        (50, 235, 50, 76),
        (60, 235, 50, 76),
        (80, 235, 50, 75),
    ):
        collected = start + timedelta(seconds=seconds)
        raw = raw_sample(vgrid=voltage, fgrid=frequency, battery_soc=soc)
        snapshot = normalize_snapshot(raw, collected_at=collected)
        database.record_snapshot(snapshot, raw)
        database.observe_grid(snapshot)

    outages = database.list_outages(limit=10)
    assert len(outages) == 1
    assert outages[0].start_soc_pct == 79
    assert outages[0].end_soc_pct == 76
    assert outages[0].duration_seconds == 40
    database.close()


def test_outage_detection_does_not_span_collector_downtime(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    start = datetime(2026, 8, 28, 12, tzinfo=UTC)

    for seconds in (0, 10, 40, 240, 250, 280):
        raw = raw_sample(vgrid=0, fgrid=0, battery_soc=80 - seconds / 40)
        snapshot = normalize_snapshot(raw, collected_at=start + timedelta(seconds=seconds))
        database.record_snapshot(snapshot, raw)
        database.observe_grid(snapshot)

    outages = database.list_outages(limit=10)
    assert len(outages) == 2
    assert outages[1].duration_seconds == 40
    assert outages[0].ongoing is True
    assert outages[0].start_at == start + timedelta(seconds=240)
    database.close()


def test_daily_coverage_respects_poll_interval_and_dst_day_length(tmp_path) -> None:
    database = DashboardDatabase(
        tmp_path / "dashboard.sqlite3", "America/Toronto", poll_interval_seconds=60
    )
    assert database._coverage_pct("2026-03-08", 23 * 60) == 100
    assert database._coverage_pct("2026-11-01", 25 * 60) == 100
    database.close()


def test_database_backs_up_exact_pre_migration_schema(tmp_path) -> None:
    path = tmp_path / "dashboard.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE samples (
            collected_ts REAL PRIMARY KEY, collected_at TEXT NOT NULL, inverter_at TEXT,
            connection_state TEXT NOT NULL, pv_w REAL NOT NULL, home_w REAL NOT NULL,
            grid_w REAL NOT NULL, battery_w REAL NOT NULL, backup_w REAL NOT NULL,
            battery_soc_pct REAL NOT NULL, grid_voltage_v REAL NOT NULL,
            grid_frequency_hz REAL NOT NULL, inverter_temperature_c REAL NOT NULL,
            snapshot_json TEXT NOT NULL, raw_json TEXT
        );
        CREATE TABLE aggregates (
            resolution TEXT NOT NULL, bucket_ts INTEGER NOT NULL, pv_w REAL NOT NULL,
            home_w REAL NOT NULL, grid_w REAL NOT NULL, battery_w REAL NOT NULL,
            backup_w REAL NOT NULL, battery_soc_pct REAL NOT NULL,
            grid_voltage_v REAL NOT NULL, grid_frequency_hz REAL NOT NULL,
            inverter_temperature_c REAL NOT NULL, sample_count INTEGER NOT NULL,
            PRIMARY KEY (resolution, bucket_ts)
        );
        """
    )
    observed = datetime(2026, 8, 27, 12, tzinfo=UTC)
    snapshot = normalize_snapshot(raw_sample(), collected_at=observed)
    connection.execute(
        """
        INSERT INTO samples VALUES (?, ?, NULL, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            observed.timestamp(),
            observed.isoformat(),
            snapshot.power.pv_w,
            snapshot.power.home_w,
            snapshot.power.grid_w,
            snapshot.power.battery_w,
            snapshot.power.backup_w,
            snapshot.power.battery_soc_pct,
            snapshot.grid.voltage_v,
            snapshot.grid.frequency_hz,
            snapshot.system.temperature_radiator_c,
            snapshot.model_dump_json(),
            json.dumps(raw_sample()),
        ),
    )
    connection.commit()
    connection.close()

    database = DashboardDatabase(path, "Asia/Karachi")
    database.close()

    backup = sqlite3.connect(tmp_path / "dashboard.sqlite3.pre-command-center.bak")
    backup_columns = {row[1] for row in backup.execute("PRAGMA table_info(samples)")}
    assert "mppt1_w" not in backup_columns
    assert (
        backup.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='outages'"
        ).fetchone()
        is None
    )
    assert backup.execute("PRAGMA user_version").fetchone()[0] == 0
    backup.close()

    migrated = sqlite3.connect(path)
    migrated_columns = {row[1] for row in migrated.execute("PRAGMA table_info(samples)")}
    assert {"mppt1_w", "mppt2_w", "battery_temperature_c"} <= migrated_columns
    assert migrated.execute("PRAGMA user_version").fetchone()[0] == 1
    migrated_sample = migrated.execute(
        "SELECT mppt1_w, mppt2_w, battery_temperature_c FROM samples"
    ).fetchone()
    assert migrated_sample == (1500, 1500, 26)
    assert migrated.execute("SELECT value FROM daily_peaks WHERE metric='pv_w'").fetchone() == (
        3000,
    )
    migrated.close()
