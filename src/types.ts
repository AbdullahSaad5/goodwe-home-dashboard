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
