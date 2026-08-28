from datetime import UTC, datetime

import pytest
from goodwe_home.normalization import normalize_snapshot


@pytest.fixture
def night_snapshot() -> dict[str, object]:
    return {
        "timestamp": datetime(2026, 8, 28, 20, 23, 43),
        "ppv": 0,
        "vpv1": 0,
        "ipv1": 0,
        "ppv1": 0,
        "vpv2": 0,
        "ipv2": 0,
        "ppv2": 0,
        "pv1_mode_label": "PV panels not connected",
        "pv2_mode_label": "PV panels not connected",
        "active_power_total": -6,
        "house_consumption": 1077,
        "backup_ptotal": 980,
        "vgrid": 239.9,
        "igrid": 4.1,
        "fgrid": 50.09,
        "total_inverter_power": 975,
        "reactive_power": -7,
        "apparent_power": 967,
        "grid_mode_label": "Connected to grid",
        "grid_in_out_label": "Idle",
        "vbattery1": 53.0,
        "ibattery1": 20.4,
        "pbattery1": 1071,
        "battery_mode_label": "Discharge",
        "battery_soc": 67,
        "battery_soh": 100,
        "battery_temperature": 25,
        "battery_max_cell_temp": 33.8,
        "battery_min_cell_temp": 33.2,
        "battery_max_cell_voltage": 3.291,
        "battery_min_cell_voltage": 3.288,
        "battery_charge_limit": 90,
        "battery_discharge_limit": 150,
        "battery_modules": 1,
        "e_day": 13.1,
        "e_load_day": 19.4,
        "e_day_exp": 11.0,
        "e_day_imp": 0.3,
        "e_bat_charge_day": 4.5,
        "e_bat_discharge_day": 2.9,
        "e_total": 469.7,
        "e_load_total": 868.7,
        "e_total_exp": 428.2,
        "e_total_imp": 12.8,
        "e_bat_charge_total": 123.7,
        "e_bat_discharge_total": 122.7,
        "temperature_air": 46.7,
        "temperature_module": 48.5,
        "temperature": 48.8,
        "work_mode_label": "Normal (On-Grid)",
        "operation_mode": 513,
        "warning_code": 0,
        "error_codes": 0,
        "errors": "",
        "battery_warning": "",
        "battery_error": "",
        "meter_comm_status": 1,
        "diagnose_result_label": "Discharge Driver On, Export power limit set",
    }


def test_normalizes_confirmed_live_snapshot(night_snapshot: dict[str, object]) -> None:
    collected_at = datetime(2026, 8, 28, 15, 23, 45, tzinfo=UTC)
    snapshot = normalize_snapshot(
        night_snapshot,
        collected_at=collected_at,
        protocol_model="GW6000ES20",
        firmware="04048-02-S11",
    )

    assert snapshot.headline == "Your home is running on battery"
    assert snapshot.power.grid_direction == "idle"
    assert snapshot.power.battery_direction == "discharge"
    assert snapshot.power.home_w == 1077
    assert snapshot.power.grid_w == -6
    assert snapshot.battery.cell_voltage_spread_mv == pytest.approx(3)
    assert snapshot.battery.cell_temperature_spread_c == pytest.approx(0.6)
    assert snapshot.insights.grid_independence_pct == pytest.approx(98.4536, rel=1e-3)
    assert snapshot.insights.solar_retention_pct == pytest.approx(16.0305, rel=1e-3)
    assert snapshot.connection.clock_drift_seconds == pytest.approx(2)
    assert snapshot.system.health == "healthy"


def test_falls_back_to_power_balance_when_house_meter_missing(
    night_snapshot: dict[str, object],
) -> None:
    night_snapshot["house_consumption"] = 0
    snapshot = normalize_snapshot(
        night_snapshot,
        collected_at=datetime(2026, 8, 28, 15, 23, 45, tzinfo=UTC),
    )
    assert snapshot.power.home_w == 1077


def test_warning_and_error_are_not_inferred_from_diagnostics(
    night_snapshot: dict[str, object],
) -> None:
    snapshot = normalize_snapshot(
        night_snapshot,
        collected_at=datetime(2026, 8, 28, 15, 23, 45, tzinfo=UTC),
    )
    assert snapshot.system.diagnostic
    assert snapshot.system.health == "healthy"

    night_snapshot["warning_code"] = 4
    warned = normalize_snapshot(
        night_snapshot,
        collected_at=datetime(2026, 8, 28, 15, 23, 45, tzinfo=UTC),
    )
    assert warned.system.health == "warning"
