import type { EventItem, HistoryResponse, SensorReading, Snapshot, Summary } from './types';

export const demoSnapshot: Snapshot = {
  connection: {
    state: 'live', last_updated: new Date().toISOString(), age_seconds: 3,
    consecutive_failures: 0, display_model: 'GW6000-ES-C10', protocol_model: 'GW6000ES20',
    firmware: '04048-02-S11', inverter_time: new Date().toISOString(), clock_drift_seconds: 2,
  },
  headline: 'Your home is running on battery',
  power: { pv_w: 0, home_w: 1077, grid_w: -6, battery_w: 1071, backup_w: 980, battery_soc_pct: 67, grid_direction: 'idle', battery_direction: 'discharge' },
  today: { solar_kwh: 13.1, load_kwh: 19.4, export_kwh: 11, import_kwh: .3, battery_charge_kwh: 4.5, battery_discharge_kwh: 2.9 },
  lifetime: { solar_kwh: 469.7, load_kwh: 868.7, export_kwh: 428.2, import_kwh: 12.8, battery_charge_kwh: 123.7, battery_discharge_kwh: 122.7 },
  battery: { soc_pct: 67, soh_pct: 100, mode: 'Discharge', voltage_v: 53, current_a: 20.4, power_w: 1071, temperature_c: 25, max_cell_temperature_c: 33.8, min_cell_temperature_c: 33.2, max_cell_voltage_v: 3.291, min_cell_voltage_v: 3.288, cell_voltage_spread_mv: 3, cell_temperature_spread_c: .6, charge_limit_a: 90, discharge_limit_a: 150, modules: 1, warning: '', error: '', software_version: '2304', hardware_version: '1' },
  solar: { total_power_w: 0, mppt1: { voltage_v: 0, current_a: 0, power_w: 0, mode: 'PV panels not connected' }, mppt2: { voltage_v: 0, current_a: 0, power_w: 0, mode: 'PV panels not connected' }, today_kwh: 13.1, lifetime_kwh: 469.7, operating_hours: 1837 },
  grid: { voltage_v: 239.9, current_a: 4.1, frequency_hz: 50.09, inverter_output_w: 975, meter_active_w: -6, reactive_var: -7, apparent_va: 967, meter_communicating: true, grid_mode: 'Connected to grid', on_grid_mode: 'Idle' },
  system: { health: 'healthy', work_mode: 'Normal (On-Grid)', operation_mode_code: 513, temperature_air_c: 46.7, temperature_module_c: 48.5, temperature_radiator_c: 48.8, warning_code: 0, error_code: 0, errors: '', diagnostic: 'Discharge Driver On, APP: Discharge current too low, Export power limit set', safety_country_code: 205, safety_country: '' },
  insights: { grid_independence_pct: 98.5, solar_retention_pct: 16, net_grid_kwh: 10.7, cell_balance: 'excellent' }, raw_count: 145,
};

const now = Date.now();
const demoPoints = Array.from({ length: 96 }, (_, index) => {
  const hour = index / 4;
  const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
  const pv = daylight * (4300 + Math.sin(index * .8) * 280);
  const home = 650 + Math.sin(index * .42) * 220 + (hour > 18 ? 620 : 0);
  const battery = daylight > .25 ? -Math.min(1200, pv * .22) : hour > 17 ? Math.min(1400, home * .82) : 0;
  const grid = pv + battery - home;
  return {
    timestamp: new Date(now - (95 - index) * 15 * 60_000).toISOString(),
    pv_w: Math.round(pv), home_w: Math.round(home), grid_w: Math.round(grid), battery_w: Math.round(battery),
    backup_w: Math.round(home * .9), battery_soc_pct: Math.round(43 + daylight * 42 - Math.max(0, hour - 18) * 2),
    grid_voltage_v: 239.5 + Math.sin(index) * 1.3, grid_frequency_hz: 50 + Math.sin(index * .2) * .08,
    inverter_temperature_c: 36 + daylight * 14,
  };
});

export const demoHistory: HistoryResponse = { period: 'day', resolution: '15m', start: demoPoints[0].timestamp, end: demoPoints.at(-1)!.timestamp, points: demoPoints };
export const demoSummary: Summary = { period: 'day', energy: demoSnapshot.today, peak_pv_w: 4512, peak_home_w: 1810, minimum_soc_pct: 43, maximum_soc_pct: 85, availability_pct: 99.9, grid_independence_pct: 98.5, solar_retention_pct: 16 };

const rawEntries: Array<[string, string, unknown, string, string]> = [
  ['ppv', 'PV Power', 0, 'W', 'PV'], ['vpv1', 'PV1 Voltage', 0, 'V', 'PV'], ['vpv2', 'PV2 Voltage', 0, 'V', 'PV'],
  ['house_consumption', 'House Consumption', 1077, 'W', 'AC'], ['vgrid', 'On-grid L1 Voltage', 239.9, 'V', 'AC'], ['fgrid', 'On-grid L1 Frequency', 50.09, 'Hz', 'AC'],
  ['active_power_total', 'Active Power Total', -6, 'W', 'GRID'], ['backup_ptotal', 'Back-up Load', 980, 'W', 'UPS'],
  ['battery_soc', 'Battery State of Charge', 67, '%', 'BAT'], ['battery_soh', 'Battery State of Health', 100, '%', 'BAT'], ['pbattery1', 'Battery Power', 1071, 'W', 'BAT'],
  ['battery_temperature', 'Battery Temperature', 25, '°C', 'BAT'], ['temperature', 'Inverter Temperature', 48.8, '°C', 'AC'], ['warning_code', 'Warning code', 0, '', 'OTHER'], ['error_codes', 'Error Codes', 0, '', 'OTHER'],
];
export const demoSensors: SensorReading[] = rawEntries.map(([id, name, value, unit, category]) => ({ id, name, value, unit, category, timestamp: new Date().toISOString() }));
export const demoEvents: EventItem[] = [
  { id: 1, created_at: new Date(now - 25 * 60_000).toISOString(), severity: 'info', event_type: 'collector_started', message: 'Local energy collector started', details: {} },
  { id: 2, created_at: new Date(now - 24 * 60_000).toISOString(), severity: 'info', event_type: 'connection_restored', message: 'Connected to GW6000-ES-C10', details: {} },
];
