from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from enum import Enum
from typing import Any
from zoneinfo import ZoneInfo

from .models import (
    BatteryState,
    ConnectionInfo,
    EnergyCounters,
    GridState,
    Insights,
    MpptState,
    NormalizedSnapshot,
    PowerFlow,
    SensorReading,
    SolarState,
    SystemState,
)


def _number(raw: dict[str, Any], key: str, default: float = 0) -> float:
    value = raw.get(key, default)
    if isinstance(value, bool):
        return float(value)
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return default


def _integer(raw: dict[str, Any], key: str, default: int = 0) -> int:
    return int(_number(raw, key, default))


def _text(raw: dict[str, Any], key: str, default: str = "") -> str:
    value = raw.get(key)
    return default if value is None else str(value).strip()


def _clamp(value: float, minimum: float = 0, maximum: float = 100) -> float:
    return max(minimum, min(maximum, value))


def _parse_inverter_time(raw: dict[str, Any]) -> datetime | None:
    value = raw.get("timestamp")
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def json_safe(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def normalize_snapshot(
    raw: dict[str, Any],
    *,
    collected_at: datetime,
    failures: int = 0,
    display_model: str = "GW6000-ES-C10",
    protocol_model: str | None = None,
    firmware: str | None = None,
    reporting_timezone: str = "Asia/Karachi",
) -> NormalizedSnapshot:
    inverter_time = _parse_inverter_time(raw)
    if inverter_time and inverter_time.tzinfo is None:
        inverter_time = inverter_time.replace(tzinfo=ZoneInfo(reporting_timezone))
    clock_drift = abs((collected_at - inverter_time).total_seconds()) if inverter_time else None

    pv_w = _number(raw, "ppv")
    battery_w = _number(raw, "pbattery1")
    grid_w = _number(raw, "active_power_total", _number(raw, "active_power"))
    home_w = _number(raw, "house_consumption")
    if home_w == 0 and (pv_w or battery_w or grid_w):
        home_w = max(0, pv_w + battery_w - grid_w)
    backup_w = _number(raw, "backup_ptotal")
    soc = _number(raw, "battery_soc")

    grid_direction = "export" if grid_w > 20 else "import" if grid_w < -20 else "idle"
    battery_direction = "discharge" if battery_w > 20 else "charge" if battery_w < -20 else "idle"

    today = EnergyCounters(
        solar_kwh=_number(raw, "e_day"),
        load_kwh=_number(raw, "e_load_day"),
        export_kwh=_number(raw, "e_day_exp"),
        import_kwh=_number(raw, "e_day_imp"),
        battery_charge_kwh=_number(raw, "e_bat_charge_day"),
        battery_discharge_kwh=_number(raw, "e_bat_discharge_day"),
    )
    lifetime = EnergyCounters(
        solar_kwh=_number(raw, "e_total"),
        load_kwh=_number(raw, "e_load_total"),
        export_kwh=_number(raw, "e_total_exp"),
        import_kwh=_number(raw, "e_total_imp"),
        battery_charge_kwh=_number(raw, "e_bat_charge_total"),
        battery_discharge_kwh=_number(raw, "e_bat_discharge_total"),
    )

    max_cell_v = _number(raw, "battery_max_cell_voltage")
    min_cell_v = _number(raw, "battery_min_cell_voltage")
    max_cell_t = _number(raw, "battery_max_cell_temp")
    min_cell_t = _number(raw, "battery_min_cell_temp")
    cell_spread_mv = max(0, (max_cell_v - min_cell_v) * 1000)
    cell_temperature_spread = max(0, max_cell_t - min_cell_t)
    if not max_cell_v or not min_cell_v:
        cell_balance = "unknown"
    elif cell_spread_mv <= 10:
        cell_balance = "excellent"
    elif cell_spread_mv <= 30:
        cell_balance = "good"
    else:
        cell_balance = "check"

    warning_code = _integer(raw, "warning_code")
    error_code = _integer(raw, "error_codes")
    battery_warning = _text(raw, "battery_warning")
    battery_error = _text(raw, "battery_error")
    inverter_errors = _text(raw, "errors")
    if error_code or inverter_errors or battery_error:
        health = "error"
    elif warning_code or battery_warning:
        health = "warning"
    else:
        health = "healthy"

    if health == "error":
        headline = "Your energy system needs attention"
    elif health == "warning":
        headline = "Your energy system has a warning"
    elif pv_w > 50:
        if battery_direction == "charge":
            headline = "Solar is powering your home and charging the battery"
        elif grid_direction == "export":
            headline = "Solar is powering your home and exporting"
        else:
            headline = "Your home is running on solar"
    elif battery_direction == "discharge":
        headline = "Your home is running on battery"
    elif grid_direction == "import":
        headline = "Your home is drawing from the grid"
    else:
        headline = "Energy flow is balanced"

    grid_independence = (
        _clamp((today.load_kwh - today.import_kwh) / today.load_kwh * 100)
        if today.load_kwh > 0
        else None
    )
    solar_retention = (
        _clamp((today.solar_kwh - today.export_kwh) / today.solar_kwh * 100)
        if today.solar_kwh > 0
        else None
    )

    return NormalizedSnapshot(
        connection=ConnectionInfo(
            state="live",
            last_updated=collected_at,
            age_seconds=0,
            consecutive_failures=failures,
            display_model=display_model,
            protocol_model=protocol_model,
            firmware=firmware,
            inverter_time=inverter_time,
            clock_drift_seconds=clock_drift,
            reporting_timezone=reporting_timezone,
        ),
        headline=headline,
        power=PowerFlow(
            pv_w=pv_w,
            home_w=home_w,
            grid_w=grid_w,
            battery_w=battery_w,
            backup_w=backup_w,
            battery_soc_pct=soc,
            grid_direction=grid_direction,
            battery_direction=battery_direction,
        ),
        today=today,
        lifetime=lifetime,
        battery=BatteryState(
            soc_pct=soc,
            soh_pct=_number(raw, "battery_soh"),
            mode=_text(raw, "battery_mode_label", "Unknown"),
            voltage_v=_number(raw, "vbattery1"),
            current_a=_number(raw, "ibattery1"),
            power_w=battery_w,
            temperature_c=_number(raw, "battery_temperature"),
            max_cell_temperature_c=max_cell_t,
            min_cell_temperature_c=min_cell_t,
            max_cell_voltage_v=max_cell_v,
            min_cell_voltage_v=min_cell_v,
            cell_voltage_spread_mv=cell_spread_mv,
            cell_temperature_spread_c=cell_temperature_spread,
            charge_limit_a=_number(raw, "battery_charge_limit"),
            discharge_limit_a=_number(raw, "battery_discharge_limit"),
            modules=_integer(raw, "battery_modules"),
            warning=battery_warning,
            error=battery_error,
            software_version=_text(raw, "battery_sw_version"),
            hardware_version=_text(raw, "battery_hw_version"),
        ),
        solar=SolarState(
            total_power_w=pv_w,
            mppt1=MpptState(
                voltage_v=_number(raw, "vpv1"),
                current_a=_number(raw, "ipv1"),
                power_w=_number(raw, "ppv1"),
                mode=_text(raw, "pv1_mode_label", "Unknown"),
            ),
            mppt2=MpptState(
                voltage_v=_number(raw, "vpv2"),
                current_a=_number(raw, "ipv2"),
                power_w=_number(raw, "ppv2"),
                mode=_text(raw, "pv2_mode_label", "Unknown"),
            ),
            today_kwh=today.solar_kwh,
            lifetime_kwh=lifetime.solar_kwh,
            operating_hours=_number(raw, "h_total"),
        ),
        grid=GridState(
            voltage_v=_number(raw, "vgrid"),
            current_a=_number(raw, "igrid"),
            frequency_hz=_number(raw, "fgrid"),
            inverter_output_w=_number(raw, "total_inverter_power"),
            meter_active_w=grid_w,
            reactive_var=_number(raw, "reactive_power_total", _number(raw, "reactive_power")),
            apparent_va=_number(raw, "apparent_power"),
            meter_communicating=_integer(raw, "meter_comm_status") == 1,
            grid_mode=_text(raw, "grid_mode_label", "Unknown"),
            on_grid_mode=_text(raw, "grid_in_out_label", "Unknown"),
        ),
        system=SystemState(
            health=health,
            work_mode=_text(raw, "work_mode_label", "Unknown"),
            operation_mode_code=_integer(raw, "operation_mode"),
            temperature_air_c=_number(raw, "temperature_air"),
            temperature_module_c=_number(raw, "temperature_module"),
            temperature_radiator_c=_number(raw, "temperature"),
            warning_code=warning_code,
            error_code=error_code,
            errors=inverter_errors,
            diagnostic=_text(raw, "diagnose_result_label"),
            safety_country_code=_integer(raw, "safety_country"),
            safety_country=_text(raw, "safety_country_label"),
        ),
        insights=Insights(
            grid_independence_pct=grid_independence,
            solar_retention_pct=solar_retention,
            net_grid_kwh=today.export_kwh - today.import_kwh,
            cell_balance=cell_balance,
        ),
        raw_count=len(raw),
    )


def build_sensor_readings(
    raw: dict[str, Any], sensors: Iterable[Any], timestamp: datetime
) -> list[SensorReading]:
    readings: list[SensorReading] = []
    for sensor in sensors:
        sensor_id = str(sensor.id_)
        if sensor_id not in raw:
            continue
        category = getattr(getattr(sensor, "kind", None), "name", "OTHER")
        readings.append(
            SensorReading(
                id=sensor_id,
                name=str(sensor.name),
                value=json_safe(raw[sensor_id]),
                unit=str(sensor.unit or ""),
                category=category,
                timestamp=timestamp,
            )
        )
    return readings


def utc_now() -> datetime:
    return datetime.now(UTC)
