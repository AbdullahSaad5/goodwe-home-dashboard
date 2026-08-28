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


ReadinessStatus = Literal["unconfigured", "collecting", "ready", "stale", "unavailable"]


class ReadinessState(BaseModel):
    status: ReadinessStatus
    reason: str
    observed: int | None = None
    required: int | None = None


class EnergyMix(BaseModel):
    home_w: float
    solar_w: float
    battery_w: float
    grid_w: float
    unaccounted_w: float
    solar_pct: float
    battery_pct: float
    grid_pct: float
    unaccounted_pct: float


class BatteryReserveInsight(BaseModel):
    status: ReadinessStatus
    reason: str
    available_kwh: float | None = None
    reserve_margin_pct: float | None = None
    runtime_hours: float | None = None


class LiveCommandCenter(BaseModel):
    headline: str
    explanation: str
    dominant_power_w: float
    energy_mix: EnergyMix
    solar_coverage_pct: float | None = None
    inverter_utilization_pct: float | None = None
    power_balance: Literal["balanced", "mismatch"] = "balanced"
    battery_reserve: BatteryReserveInsight


class HealthSignal(BaseModel):
    id: str
    label: str
    status: Literal["healthy", "warning", "error", "unknown", "stale", "unavailable"]
    value: str
    detail: str


class OutageItem(BaseModel):
    id: int
    start_at: datetime
    end_at: datetime | None = None
    duration_seconds: float | None = None
    start_soc_pct: float | None = None
    end_soc_pct: float | None = None
    confidence: float = 1
    ongoing: bool = False


class OutageBand(BaseModel):
    start: datetime
    end: datetime | None = None


class TrendData(BaseModel):
    range: str
    resolution: str
    points: list[HistoryPoint]
    outages: list[OutageBand]


class PeakMetric(BaseModel):
    metric: str
    value: float
    unit: str
    occurred_at: datetime


class TodayInsight(BaseModel):
    energy: EnergyCounters
    yesterday_same_time: EnergyCounters | None = None
    grid_independence_pct: float | None = None
    solar_self_consumption_pct: float | None = None
    peaks: list[PeakMetric] = Field(default_factory=list)


class DailyEnergyPoint(BaseModel):
    day: str
    energy: EnergyCounters
    peak_pv_w: float
    peak_home_w: float
    coverage_pct: float


class RecordMetric(BaseModel):
    id: str
    label: str
    value: float
    unit: str
    day: str


class ForecastPoint(BaseModel):
    timestamp: datetime
    irradiance_w_m2: float
    pv_w: float | None = None


class ForecastRun(BaseModel):
    provider: str
    issued_at: datetime
    points: list[ForecastPoint]
    metadata: dict[str, Any] = Field(default_factory=dict)


class ForecastCalibrationObservation(BaseModel):
    actual_kwh: float
    predicted_kwh: float


class DaylightCoverageObservation(BaseModel):
    day: str
    sample_count: int
    expected_samples: float


class LoadObservation(BaseModel):
    minute_of_day: int
    home_w: float
    weekend: bool


class MpptTotals(BaseModel):
    mppt1_w_samples: float | None = None
    mppt2_w_samples: float | None = None


class ForecastInsight(BaseModel):
    status: ReadinessStatus
    reason: str
    provider: str | None = None
    updated_at: datetime | None = None
    today_kwh: float | None = None
    tomorrow_kwh: float | None = None
    calibration_days: int = 0
    points: list[ForecastPoint] = Field(default_factory=list)


class ProjectionPoint(BaseModel):
    timestamp: datetime
    pv_w: float
    load_w: float
    soc_pct: float
    outage_likely: bool = False


class ProjectionInsight(BaseModel):
    status: ReadinessStatus
    reason: str
    lowest_soc_pct: float | None = None
    lowest_soc_at: datetime | None = None
    points: list[ProjectionPoint] = Field(default_factory=list)


class OutageBucket(BaseModel):
    minute_of_day: int
    probability_pct: float


class OutageOutlookInsight(BaseModel):
    status: ReadinessStatus
    reason: str
    observed_days: int = 0
    outage_count: int = 0
    next_window_start: datetime | None = None
    next_window_end: datetime | None = None
    typical_duration_minutes: float | None = None
    buckets: list[OutageBucket] = Field(default_factory=list)


class WatchdogMetric(BaseModel):
    id: str
    label: str
    status: ReadinessStatus
    value: str
    detail: str


class WatchdogInsight(BaseModel):
    status: ReadinessStatus
    reason: str
    metrics: list[WatchdogMetric] = Field(default_factory=list)
    recommendation: str = ""


class CommandCenterResponse(BaseModel):
    generated_at: datetime
    live: LiveCommandCenter
    health: list[HealthSignal]
    trend: TrendData
    today: TodayInsight
    daily_history: list[DailyEnergyPoint]
    period_totals: EnergyCounters
    lifetime: EnergyCounters
    records: list[RecordMetric]
    outages: list[OutageItem]
    outage_outlook: OutageOutlookInsight
    forecast: ForecastInsight
    projection: ProjectionInsight
    watchdog: WatchdogInsight
    readiness: dict[str, ReadinessState]
