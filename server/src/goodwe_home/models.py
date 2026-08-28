from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

ConnectionState = Literal["starting", "live", "stale", "offline"]
HealthState = Literal["healthy", "warning", "error", "unknown"]


class ConnectionInfo(BaseModel):
    state: ConnectionState = "starting"
    last_updated: datetime | None = None
    age_seconds: float | None = None
    consecutive_failures: int = 0
    display_model: str = "GW6000-ES-C10"
    protocol_model: str | None = None
    firmware: str | None = None
    inverter_time: datetime | None = None
    clock_drift_seconds: float | None = None


class PowerFlow(BaseModel):
    pv_w: float = 0
    home_w: float = 0
    grid_w: float = 0
    battery_w: float = 0
    backup_w: float = 0
    battery_soc_pct: float = 0
    grid_direction: Literal["import", "export", "idle"] = "idle"
    battery_direction: Literal["charge", "discharge", "idle"] = "idle"


class EnergyCounters(BaseModel):
    solar_kwh: float = 0
    load_kwh: float = 0
    export_kwh: float = 0
    import_kwh: float = 0
    battery_charge_kwh: float = 0
    battery_discharge_kwh: float = 0


class BatteryState(BaseModel):
    soc_pct: float = 0
    soh_pct: float = 0
    mode: str = "Unknown"
    voltage_v: float = 0
    current_a: float = 0
    power_w: float = 0
    temperature_c: float = 0
    max_cell_temperature_c: float = 0
    min_cell_temperature_c: float = 0
    max_cell_voltage_v: float = 0
    min_cell_voltage_v: float = 0
    cell_voltage_spread_mv: float = 0
    cell_temperature_spread_c: float = 0
    charge_limit_a: float = 0
    discharge_limit_a: float = 0
    modules: int = 0
    warning: str = ""
    error: str = ""
    software_version: str = ""
    hardware_version: str = ""


class MpptState(BaseModel):
    voltage_v: float = 0
    current_a: float = 0
    power_w: float = 0
    mode: str = "Unknown"


class SolarState(BaseModel):
    total_power_w: float = 0
    mppt1: MpptState = Field(default_factory=MpptState)
    mppt2: MpptState = Field(default_factory=MpptState)
    today_kwh: float = 0
    lifetime_kwh: float = 0
    operating_hours: float = 0


class GridState(BaseModel):
    voltage_v: float = 0
    current_a: float = 0
    frequency_hz: float = 0
    inverter_output_w: float = 0
    meter_active_w: float = 0
    reactive_var: float = 0
    apparent_va: float = 0
    meter_communicating: bool = False
    grid_mode: str = "Unknown"
    on_grid_mode: str = "Unknown"


class SystemState(BaseModel):
    health: HealthState = "unknown"
    work_mode: str = "Unknown"
    operation_mode_code: int = 0
    temperature_air_c: float = 0
    temperature_module_c: float = 0
    temperature_radiator_c: float = 0
    warning_code: int = 0
    error_code: int = 0
    errors: str = ""
    diagnostic: str = ""
    safety_country_code: int = 0
    safety_country: str = ""


class Insights(BaseModel):
    grid_independence_pct: float | None = None
    solar_retention_pct: float | None = None
    net_grid_kwh: float = 0
    cell_balance: Literal["excellent", "good", "check", "unknown"] = "unknown"


class NormalizedSnapshot(BaseModel):
    connection: ConnectionInfo
    headline: str
    power: PowerFlow
    today: EnergyCounters
    lifetime: EnergyCounters
    battery: BatteryState
    solar: SolarState
    grid: GridState
    system: SystemState
    insights: Insights
    raw_count: int


class SensorReading(BaseModel):
    id: str
    name: str
    value: Any = None
    unit: str = ""
    category: str = "OTHER"
    timestamp: datetime


class EventItem(BaseModel):
    id: int
    created_at: datetime
    severity: Literal["info", "warning", "error"]
    event_type: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class HistoryPoint(BaseModel):
    timestamp: datetime
    pv_w: float = 0
    home_w: float = 0
    grid_w: float = 0
    battery_w: float = 0
    backup_w: float = 0
    battery_soc_pct: float = 0
    grid_voltage_v: float = 0
    grid_frequency_hz: float = 0
    inverter_temperature_c: float = 0


class HistoryResponse(BaseModel):
    period: str
    resolution: str
    start: datetime
    end: datetime
    points: list[HistoryPoint]


class SummaryResponse(BaseModel):
    period: str
    energy: EnergyCounters
    peak_pv_w: float = 0
    peak_home_w: float = 0
    minimum_soc_pct: float | None = None
    maximum_soc_pct: float | None = None
    availability_pct: float | None = None
    grid_independence_pct: float | None = None
    solar_retention_pct: float | None = None
