import manifestJson from '../decoder-manifest.json';

interface OracleField {
  id: string;
  name: string;
  unit: string;
  kind: string;
  type: string;
  frame: 'runtime' | 'battery' | 'meter';
  register: number;
  bytes: number;
  scale?: number;
  labels?: Record<string, string>;
  low_register?: number;
}

const oracleFields = manifestJson.fields as OracleField[];

export interface DecodedEtPoll {
  raw: Record<string, unknown>;
  snapshot: Record<string, unknown> & {
    power: Record<string, number | string>;
    connection: Record<string, unknown>;
    battery: Record<string, unknown>;
    solar: Record<string, unknown> & { mppt1: Record<string, unknown> };
    grid: Record<string, unknown>;
    system: Record<string, unknown>;
  };
  history: Record<string, number | string>;
}

export const sensorMetadata = new Map(
  oracleFields.map((field) => [
    field.id,
    { name: field.name, unit: field.unit, category: field.kind },
  ]),
);

function payload(frame: Uint8Array, expected: number, name: string): DataView {
  if (
    frame.length !== expected + 9 ||
    frame[6] !== 0xf7 ||
    frame[7] !== 3 ||
    frame[8] !== expected
  ) {
    throw new Error(`Invalid ${name} frame`);
  }
  const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (header.getUint16(2) !== 0 || header.getUint16(4) !== expected + 3) {
    throw new Error(`Invalid ${name} frame`);
  }
  return new DataView(frame.buffer, frame.byteOffset + 9, expected);
}

function at(register: number, base: number): number {
  return (register - base) * 2;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function bitmap(value: number, labels: Record<string, string> = {}): string {
  const selected: string[] = [];
  for (let bit = 0; bit < 32; bit += 1) {
    if (((value >>> bit) & 1) === 1) {
      const label = labels[String(bit)] ?? `err${bit}`;
      if (label) selected.push(label);
    }
  }
  return selected.join(', ');
}

function decodeOracleFields(
  views: Record<'runtime' | 'battery' | 'meter', DataView>,
): Record<string, unknown> {
  const bases = { runtime: 35100, battery: 37000, meter: 36000 };
  const raw: Record<string, unknown> = {};
  for (const field of oracleFields) {
    if (field.type === 'Calculated' || field.type === 'EnumCalculated') continue;
    const view = views[field.frame];
    const offset = at(field.register, bases[field.frame]);
    const u16 = () => view.getUint16(offset);
    const i16 = () => view.getInt16(offset);
    const u32 = () => view.getUint32(offset);
    const i32 = () => view.getInt32(offset);
    let value: unknown;
    switch (field.type) {
      case 'Timestamp': {
        const values = Array.from({ length: 6 }, (_, index) => view.getUint8(offset + index));
        const [year, month, day, hour, minute, second] = values;
        value =
          month >= 1 && month <= 12 && day >= 1 && day <= 31
            ? `${String(2000 + year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
            : null;
        break;
      }
      case 'Voltage':
      case 'Current':
        value = u16() === 0xffff ? 0 : u16() / 10;
        break;
      case 'CurrentS':
        value = i16() / 10;
        break;
      case 'Frequency':
        value = i16() / 100;
        break;
      case 'Temp':
        value = i16() === -1 || i16() === 32767 ? null : i16() / 10;
        break;
      case 'CellVoltage':
        value = (u16() === 0xffff ? 0 : u16() / 10) / 100;
        break;
      case 'Power4':
      case 'Long':
        value = u32() === 0xffffffff ? 0 : u32();
        break;
      case 'Power4S':
      case 'Reactive4':
      case 'Apparent4':
        value = i32();
        break;
      case 'PowerS':
      case 'Reactive':
      case 'Apparent':
        value = i16();
        break;
      case 'Integer':
        value = u16() === 0xffff ? 0 : u16();
        break;
      case 'ByteH':
        value = view.getInt8(offset);
        break;
      case 'ByteL':
        value = view.getInt8(offset + 1);
        break;
      case 'EnumH':
        value = field.labels?.[String(view.getInt8(offset))] ?? null;
        break;
      case 'EnumL':
        value = field.labels?.[String(view.getInt8(offset + 1))] ?? null;
        break;
      case 'Enum2':
        value = field.labels?.[String(u16() === 0xffff ? 0 : u16())] ?? null;
        break;
      case 'EnumBitmap4':
        value = bitmap(i32() === -1 ? 0 : i32(), field.labels);
        break;
      case 'EnumBitmap22': {
        // Preserve goodwe 0.4.10's published output for this two-register sensor.
        value = '';
        break;
      }
      case 'Energy':
        value = (u16() === 0xffff ? 0 : u16()) / 10;
        break;
      case 'Energy4':
        value = (u32() === 0xffffffff ? 0 : u32()) / 10;
        break;
      case 'Energy8': {
        const high = view.getUint32(offset);
        const low = view.getUint32(offset + 4);
        value = (high * 0x1_0000_0000 + low) / 100;
        break;
      }
      case 'Decimal':
        value = i16() / (field.scale ?? 1);
        break;
      case 'Float':
        value = round(view.getFloat32(offset) / (field.scale ?? 1));
        break;
      default:
        value = null;
    }
    raw[field.id] = value;
  }
  const runtime = views.runtime;
  const runtimeU32 = (register: number): number => {
    const value = runtime.getUint32(at(register, bases.runtime));
    return value === 0xffffffff ? 0 : value;
  };
  const allPvPower = [35105, 35109, 35113, 35117].map(runtimeU32);
  raw.ppv = allPvPower.reduce((sum, value) => sum + Math.max(0, value), 0);
  const activePower = Number(raw.active_power ?? 0);
  raw.grid_in_out = activePower < -90 ? 2 : activePower >= 90 ? 1 : 0;
  const gridField = oracleFields.find((field) => field.id === 'grid_in_out_label');
  raw.grid_in_out_label = gridField?.labels?.[String(raw.grid_in_out)] ?? null;
  raw.house_consumption =
    allPvPower.reduce((sum, value) => sum + value, 0) + Number(raw.pbattery1 ?? 0) - activePower;
  return raw;
}

export function decodeEtFrames(
  runtimeFrame: Uint8Array,
  batteryFrame: Uint8Array,
  meterFrame: Uint8Array,
  utcMs: number,
): DecodedEtPoll {
  const runtime = payload(runtimeFrame, 250, 'runtime');
  const battery = payload(batteryFrame, 48, 'battery');
  const meter = payload(meterFrame, 90, 'meter');
  const raw = decodeOracleFields({ runtime, battery, meter });
  const pv = Number(raw.ppv);
  const batteryPower = Number(raw.pbattery1);
  const grid = Number(raw.active_power_total);
  const home = Number(raw.house_consumption);
  const soc = Number(raw.battery_soc);
  const today = {
    solar_kwh: Number(raw.e_day),
    load_kwh: Number(raw.e_load_day),
    export_kwh: Number(raw.e_day_exp),
    import_kwh: Number(raw.e_day_imp),
    battery_charge_kwh: Number(raw.e_bat_charge_day),
    battery_discharge_kwh: Number(raw.e_bat_discharge_day),
  };
  const lifetime = {
    solar_kwh: Number(raw.e_total),
    load_kwh: Number(raw.e_load_total),
    export_kwh: Number(raw.e_total_exp),
    import_kwh: Number(raw.e_total_imp),
    battery_charge_kwh: Number(raw.e_bat_charge_total),
    battery_discharge_kwh: Number(raw.e_bat_discharge_total),
  };
  const maxCell = Number(raw.battery_max_cell_voltage);
  const minCell = Number(raw.battery_min_cell_voltage);
  const cellSpread = Math.max(0, round((maxCell - minCell) * 1000));
  const warning = Number(raw.warning_code);
  const errors = Number(raw.error_codes);
  const batteryWarning = String(raw.battery_warning ?? '');
  const batteryError = String(raw.battery_error ?? '');
  const inverterErrors = String(raw.errors ?? '');
  const hasError = Boolean(errors || batteryError || inverterErrors);
  const hasWarning = Boolean(warning || batteryWarning);
  const timestamp = new Date(utcMs).toISOString();

  const snapshot = {
    connection: {
      state: 'live',
      last_updated: timestamp,
      age_seconds: 0,
      consecutive_failures: 0,
      display_model: 'GoodWe ET',
      protocol_model: 'ET',
      firmware: null,
      inverter_time: raw.timestamp ?? null,
      clock_drift_seconds: null,
      reporting_timezone: 'UTC',
    },
    headline: hasError
      ? 'Your energy system needs attention'
      : hasWarning
        ? 'Your energy system has a warning'
        : pv > 50
          ? batteryPower < -20
            ? 'Solar is powering your home and charging the battery'
            : grid > 20
              ? 'Solar is powering your home and exporting'
              : 'Your home is running on solar'
          : batteryPower > 20
            ? 'Your home is running on battery'
            : grid < -20
              ? 'Your home is drawing from the grid'
              : 'Energy flow is balanced',
    power: {
      pv_w: pv,
      home_w: home,
      grid_w: grid,
      battery_w: batteryPower,
      backup_w: Number(raw.backup_ptotal),
      battery_soc_pct: soc,
      grid_direction: grid > 20 ? 'export' : grid < -20 ? 'import' : 'idle',
      battery_direction: batteryPower > 20 ? 'discharge' : batteryPower < -20 ? 'charge' : 'idle',
    },
    today,
    lifetime,
    battery: {
      soc_pct: soc,
      soh_pct: Number(raw.battery_soh),
      mode: String(raw.battery_mode_label ?? 'Unknown'),
      voltage_v: Number(raw.vbattery1),
      current_a: Number(raw.ibattery1),
      power_w: batteryPower,
      temperature_c: Number(raw.battery_temperature),
      max_cell_temperature_c: Number(raw.battery_max_cell_temp),
      min_cell_temperature_c: Number(raw.battery_min_cell_temp),
      max_cell_voltage_v: maxCell,
      min_cell_voltage_v: minCell,
      cell_voltage_spread_mv: cellSpread,
      cell_temperature_spread_c: Math.max(
        0,
        Number(raw.battery_max_cell_temp) - Number(raw.battery_min_cell_temp),
      ),
      charge_limit_a: Number(raw.battery_charge_limit),
      discharge_limit_a: Number(raw.battery_discharge_limit),
      modules: Number(raw.battery_modules),
      warning: batteryWarning,
      error: batteryError,
      software_version: String(raw.battery_sw_version),
      hardware_version: String(raw.battery_hw_version),
    },
    solar: {
      total_power_w: pv,
      mppt1: {
        voltage_v: raw.vpv1,
        current_a: raw.ipv1,
        power_w: raw.ppv1,
        mode: String(raw.pv1_mode_label ?? 'Unknown'),
      },
      mppt2: {
        voltage_v: raw.vpv2,
        current_a: raw.ipv2,
        power_w: raw.ppv2,
        mode: String(raw.pv2_mode_label ?? 'Unknown'),
      },
      today_kwh: today.solar_kwh,
      lifetime_kwh: lifetime.solar_kwh,
      operating_hours: Number(raw.h_total),
    },
    grid: {
      voltage_v: Number(raw.vgrid),
      current_a: Number(raw.igrid),
      frequency_hz: Number(raw.fgrid),
      inverter_output_w: Number(raw.total_inverter_power),
      meter_active_w: grid,
      reactive_var: Number(raw.reactive_power_total),
      apparent_va: Number(raw.apparent_power),
      meter_communicating: Number(raw.meter_comm_status) === 1,
      grid_mode: String(raw.grid_mode_label ?? 'Unknown'),
      on_grid_mode: String(raw.grid_in_out_label ?? 'Unknown'),
    },
    system: {
      health: hasError ? 'error' : hasWarning ? 'warning' : 'healthy',
      work_mode: String(raw.work_mode_label ?? 'Unknown'),
      operation_mode_code: Number(raw.operation_mode),
      temperature_air_c: Number(raw.temperature_air),
      temperature_module_c: Number(raw.temperature_module),
      temperature_radiator_c: Number(raw.temperature),
      warning_code: warning,
      error_code: errors,
      errors: inverterErrors,
      diagnostic: String(raw.diagnose_result_label ?? ''),
      safety_country_code: Number(raw.safety_country),
      safety_country: String(raw.safety_country_label ?? ''),
    },
    insights: {
      grid_independence_pct:
        today.load_kwh > 0
          ? Math.max(0, Math.min(100, ((today.load_kwh - today.import_kwh) / today.load_kwh) * 100))
          : null,
      solar_retention_pct:
        today.solar_kwh > 0
          ? Math.max(
              0,
              Math.min(100, ((today.solar_kwh - today.export_kwh) / today.solar_kwh) * 100),
            )
          : null,
      net_grid_kwh: today.export_kwh - today.import_kwh,
      cell_balance:
        !maxCell || !minCell
          ? 'unknown'
          : cellSpread <= 10
            ? 'excellent'
            : cellSpread <= 30
              ? 'good'
              : 'check',
    },
    raw_count: Object.keys(raw).length,
  };
  return {
    raw,
    snapshot,
    history: {
      timestamp,
      pv_w: pv,
      home_w: home,
      grid_w: grid,
      battery_w: batteryPower,
      backup_w: Number(raw.backup_ptotal),
      battery_soc_pct: soc,
      grid_voltage_v: Number(raw.vgrid),
      grid_frequency_hz: Number(raw.fgrid),
      inverter_temperature_c: Number(raw.temperature),
    },
  };
}
