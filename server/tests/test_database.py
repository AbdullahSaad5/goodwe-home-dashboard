from datetime import UTC, date, datetime, timedelta

from goodwe_home.database import DashboardDatabase
from goodwe_home.normalization import normalize_snapshot


def raw_sample(**overrides: float) -> dict[str, object]:
    data: dict[str, object] = {
        "ppv": 1000,
        "house_consumption": 800,
        "active_power_total": 200,
        "pbattery1": 0,
        "backup_ptotal": 500,
        "battery_soc": 75,
        "vgrid": 240,
        "fgrid": 50,
        "temperature": 42,
        "e_day": 5,
        "e_load_day": 4,
        "e_day_exp": 1,
        "e_day_imp": 0.2,
        "e_bat_charge_day": 0.5,
        "e_bat_discharge_day": 0.4,
    }
    data.update(overrides)
    return data


def test_records_history_summary_and_events(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    now = datetime.now(UTC).replace(microsecond=0)
    for index in range(4):
        collected = now - timedelta(seconds=(3 - index) * 10)
        raw = raw_sample(ppv=1000 + index * 100, house_consumption=800 + index * 50)
        snapshot = normalize_snapshot(raw, collected_at=collected)
        database.record_snapshot(snapshot, raw if index == 3 else None)

    history = database.history("day")
    assert len(history.points) == 4
    assert history.points[-1].pv_w == 1300

    summary = database.summary("day")
    assert summary.energy.solar_kwh == 5
    assert summary.peak_pv_w == 1300
    assert summary.grid_independence_pct is not None
    assert summary.availability_pct == 100

    event_id = database.add_event("info", "test", "Stored safely", {"ok": True})
    events = database.list_events()
    assert events[0].id == event_id
    assert events[0].details == {"ok": True}
    database.close()


def test_runtime_setting_is_persisted_and_overwritten(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    assert database.get_runtime_setting("inverter_host") is None
    database.set_runtime_setting("inverter_host", "192.168.50.20")
    assert database.get_runtime_setting("inverter_host") == "192.168.50.20"
    database.set_runtime_setting("inverter_host", "192.168.50.21")
    assert database.get_runtime_setting("inverter_host") == "192.168.50.21"
    database.close()


def test_rollup_preserves_aggregates_before_retention(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    now = datetime.now(UTC).replace(microsecond=0)
    old = now - timedelta(days=31)
    snapshot = normalize_snapshot(raw_sample(), collected_at=old)
    database.record_snapshot(snapshot, raw_sample())
    database.rollup_and_retain(now.timestamp())

    with database._lock:
        sample_count = database._connection.execute("SELECT COUNT(*) FROM samples").fetchone()[0]
        aggregate_count = database._connection.execute(
            "SELECT COUNT(*) FROM aggregates"
        ).fetchone()[0]
    assert sample_count == 0
    assert aggregate_count == 2
    database.close()


def test_aggregate_history_merges_live_samples_after_the_latest_hourly_rollup(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    hour = datetime(2026, 8, 28, 12, tzinfo=UTC)

    for collected, pv_w in (
        (hour - timedelta(seconds=55), 1000),
        (hour - timedelta(seconds=10), 3000),
    ):
        raw = raw_sample(ppv=pv_w)
        database.record_snapshot(normalize_snapshot(raw, collected_at=collected), raw)

    database.rollup_and_retain((hour + timedelta(seconds=10)).timestamp())

    live_at = hour + timedelta(minutes=40)
    live_raw = raw_sample(ppv=2200)
    database.record_snapshot(normalize_snapshot(live_raw, collected_at=live_at), live_raw)

    history = database.short_history(24 * 3600, hour + timedelta(minutes=45))
    calendar_history = database.history("week", date(2026, 8, 28))

    assert history.resolution == "1m"
    assert history.points[-1].timestamp == live_at
    assert calendar_history.resolution == "1m"
    assert calendar_history.points[-1].timestamp == live_at
    previous_minute = next(
        point for point in history.points if point.timestamp == hour - timedelta(minutes=1)
    )
    assert previous_minute.pv_w == 2000
    database.close()


def test_anchor_uses_reporting_calendar_day(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    before_midnight = datetime(2026, 8, 20, 18, 30, tzinfo=UTC)
    next_day_boundary = datetime(2026, 8, 20, 19, 0, tzinfo=UTC)
    after_midnight = datetime(2026, 8, 20, 19, 30, tzinfo=UTC)
    database.record_snapshot(
        normalize_snapshot(raw_sample(ppv=1100), collected_at=before_midnight), raw_sample()
    )
    database.record_snapshot(
        normalize_snapshot(raw_sample(ppv=3300), collected_at=next_day_boundary), raw_sample()
    )
    database.record_snapshot(
        normalize_snapshot(raw_sample(ppv=2200), collected_at=after_midnight), raw_sample()
    )

    history = database.history("day", date(2026, 8, 20))
    assert [point.pv_w for point in history.points] == [1100]
    assert history.start == datetime(2026, 8, 19, 19, 0, tzinfo=UTC)
    assert history.end == datetime(2026, 8, 20, 19, 0, tzinfo=UTC)

    summary = database.summary("day", date(2026, 8, 20))
    assert summary.energy.solar_kwh == 5
    assert summary.peak_pv_w == 1100
    database.close()


def test_anchored_calendar_period_boundaries(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    month_start, month_end, _ = database._period_bounds("month", date(2026, 2, 18))
    year_start, year_end, _ = database._period_bounds("year", date(2026, 8, 20))
    week_start, week_end, _ = database._period_bounds("week", date(2026, 8, 20))

    assert month_start == datetime(2026, 1, 31, 19, 0, tzinfo=UTC)
    assert month_end == datetime(2026, 2, 28, 19, 0, tzinfo=UTC)
    assert year_start == datetime(2025, 12, 31, 19, 0, tzinfo=UTC)
    assert year_end == datetime(2026, 12, 31, 19, 0, tzinfo=UTC)
    assert week_end - week_start == timedelta(days=7)
    database.close()
