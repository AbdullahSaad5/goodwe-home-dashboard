export type Period = 'day' | 'week' | 'month' | 'year';
export type Page = 'overview' | 'history' | 'solar' | 'battery' | 'grid' | 'system' | 'raw';

export interface EnergyCounters {
  solar_kwh: number;
  load_kwh: number;
  export_kwh: number;
  import_kwh: number;
  battery_charge_kwh: number;
  battery_discharge_kwh: number;
}

export interface Snapshot {
  connection: {
    state: 'starting' | 'live' | 'stale' | 'offline';
    last_updated: string | null;
    age_seconds: number | null;
    consecutive_failures: number;
    display_model: string;
    protocol_model: string | null;
    firmware: string | null;
    inverter_time: string | null;
    clock_drift_seconds: number | null;
  };
  headline: string;
  power: {
    pv_w: number;
    home_w: number;
    grid_w: number;
    battery_w: number;
    backup_w: number;
    battery_soc_pct: number;
    grid_direction: 'import' | 'export' | 'idle';
    battery_direction: 'charge' | 'discharge' | 'idle';
  };
  today: EnergyCounters;
  lifetime: EnergyCounters;
  battery: {
    soc_pct: number;
    soh_pct: number;
    mode: string;
    voltage_v: number;
    current_a: number;
    power_w: number;
    temperature_c: number;
    max_cell_temperature_c: number;
    min_cell_temperature_c: number;
    max_cell_voltage_v: number;
    min_cell_voltage_v: number;
    cell_voltage_spread_mv: number;
    cell_temperature_spread_c: number;
    charge_limit_a: number;
    discharge_limit_a: number;
    modules: number;
    warning: string;
    error: string;
    software_version: string;
    hardware_version: string;
  };
  solar: {
    total_power_w: number;
    mppt1: Mppt;
    mppt2: Mppt;
    today_kwh: number;
    lifetime_kwh: number;
    operating_hours: number;
  };
  grid: {
    voltage_v: number;
    current_a: number;
    frequency_hz: number;
    inverter_output_w: number;
    meter_active_w: number;
    reactive_var: number;
    apparent_va: number;
    meter_communicating: boolean;
    grid_mode: string;
    on_grid_mode: string;
  };
  system: {
    health: 'healthy' | 'warning' | 'error' | 'unknown';
    work_mode: string;
    operation_mode_code: number;
    temperature_air_c: number;
    temperature_module_c: number;
    temperature_radiator_c: number;
    warning_code: number;
    error_code: number;
    errors: string;
    diagnostic: string;
    safety_country_code: number;
    safety_country: string;
  };
  insights: {
    grid_independence_pct: number | null;
    solar_retention_pct: number | null;
    net_grid_kwh: number;
    cell_balance: 'excellent' | 'good' | 'check' | 'unknown';
  };
  raw_count: number;
}

export interface Mppt {
  voltage_v: number;
  current_a: number;
  power_w: number;
  mode: string;
}

export interface HistoryPoint {
  timestamp: string;
  pv_w: number;
  home_w: number;
  grid_w: number;
  battery_w: number;
  backup_w: number;
  battery_soc_pct: number;
  grid_voltage_v: number;
  grid_frequency_hz: number;
  inverter_temperature_c: number;
}

export interface HistoryResponse {
  period: Period;
  resolution: string;
  start: string;
  end: string;
  points: HistoryPoint[];
}

export interface Summary {
  period: Period;
  energy: EnergyCounters;
  peak_pv_w: number;
  peak_home_w: number;
  minimum_soc_pct: number | null;
  maximum_soc_pct: number | null;
  availability_pct: number | null;
  grid_independence_pct: number | null;
  solar_retention_pct: number | null;
}

export interface SensorReading {
  id: string;
  name: string;
  value: unknown;
  unit: string;
  category: string;
  timestamp: string;
}

export interface EventItem {
  id: number;
  created_at: string;
  severity: 'info' | 'warning' | 'error';
  event_type: string;
  message: string;
  details: Record<string, unknown>;
}

export type ReadinessStatus = 'unconfigured' | 'collecting' | 'ready' | 'stale' | 'unavailable';
export type TrendRange = '15m' | '1h' | '3h' | '6h' | '12h' | '24h';
export type CommandHistoryRange = '14d' | '30d' | '60d' | '12m';

export interface ReadinessState {
  status: ReadinessStatus;
  reason: string;
  observed: number | null;
  required: number | null;
}

export interface ProjectionPoint {
  timestamp: string;
  pv_w: number;
  load_w: number;
  soc_pct: number;
  outage_likely: boolean;
}

export interface CommandCenterResponse {
  generated_at: string;
  live: {
    headline: string;
    explanation: string;
    dominant_power_w: number;
    energy_mix: {
      home_w: number;
      solar_w: number;
      battery_w: number;
      grid_w: number;
      unaccounted_w: number;
      solar_pct: number;
      battery_pct: number;
      grid_pct: number;
      unaccounted_pct: number;
    };
    solar_coverage_pct: number | null;
    inverter_utilization_pct: number | null;
    power_balance: 'balanced' | 'mismatch';
    battery_reserve: {
      status: ReadinessStatus;
      reason: string;
      available_kwh: number | null;
      reserve_margin_pct: number | null;
      runtime_hours: number | null;
    };
  };
  health: Array<{
    id: string;
    label: string;
    status: 'healthy' | 'warning' | 'error' | 'unknown' | 'stale' | 'unavailable';
    value: string;
    detail: string;
  }>;
  trend: {
    range: TrendRange;
    resolution: string;
    points: HistoryPoint[];
    outages: Array<{ start: string; end: string | null }>;
  };
  today: {
    energy: EnergyCounters;
    yesterday_same_time: EnergyCounters | null;
    grid_independence_pct: number | null;
    solar_self_consumption_pct: number | null;
    peaks: Array<{
      metric: string;
      value: number;
      unit: string;
      occurred_at: string;
    }>;
  };
  daily_history: Array<{
    day: string;
    energy: EnergyCounters;
    peak_pv_w: number;
    peak_home_w: number;
    coverage_pct: number;
  }>;
  period_totals: EnergyCounters;
  lifetime: EnergyCounters;
  records: Array<{ id: string; label: string; value: number; unit: string; day: string }>;
  outages: Array<{
    id: number;
    start_at: string;
    end_at: string | null;
    duration_seconds: number | null;
    start_soc_pct: number | null;
    end_soc_pct: number | null;
    confidence: number;
    ongoing: boolean;
  }>;
  outage_outlook: {
    status: ReadinessStatus;
    reason: string;
    observed_days: number;
    outage_count: number;
    next_window_start: string | null;
    next_window_end: string | null;
    typical_duration_minutes: number | null;
    buckets: Array<{ minute_of_day: number; probability_pct: number }>;
  };
  forecast: {
    status: ReadinessStatus;
    reason: string;
    provider: string | null;
    updated_at: string | null;
    today_kwh: number | null;
    tomorrow_kwh: number | null;
    calibration_days: number;
    points: Array<{ timestamp: string; irradiance_w_m2: number; pv_w: number | null }>;
  };
  projection: {
    status: ReadinessStatus;
    reason: string;
    lowest_soc_pct: number | null;
    lowest_soc_at: string | null;
    points: ProjectionPoint[];
  };
  watchdog: {
    status: ReadinessStatus;
    reason: string;
    metrics: Array<{
      id: string;
      label: string;
      status: ReadinessStatus;
      value: string;
      detail: string;
    }>;
    recommendation: string;
  };
  readiness: Record<string, ReadinessState>;
}
