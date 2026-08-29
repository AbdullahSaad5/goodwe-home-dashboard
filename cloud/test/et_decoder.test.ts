import { describe, expect, it } from 'vitest';
import { decodeEtFrames } from '../src/et_decoder';
import oracleFixture from './fixtures/et-oracle.json';

function frame(byteCount: number, transaction = 1): Uint8Array {
  const value = new Uint8Array(byteCount + 9);
  const view = new DataView(value.buffer);
  view.setUint16(0, transaction);
  view.setUint16(2, 0);
  view.setUint16(4, byteCount + 3);
  value[6] = 0xf7;
  value[7] = 0x03;
  value[8] = byteCount;
  return value;
}

function setU16(value: Uint8Array, base: number, register: number, raw: number): void {
  new DataView(value.buffer).setUint16(9 + (register - base) * 2, raw);
}

function setI16(value: Uint8Array, base: number, register: number, raw: number): void {
  new DataView(value.buffer).setInt16(9 + (register - base) * 2, raw);
}

function setU32(value: Uint8Array, base: number, register: number, raw: number): void {
  new DataView(value.buffer).setUint32(9 + (register - base) * 2, raw);
}

function setI32(value: Uint8Array, base: number, register: number, raw: number): void {
  new DataView(value.buffer).setInt32(9 + (register - base) * 2, raw);
}

describe('ET frame decoder', () => {
  it('matches every field in the pinned goodwe 0.4.10 oracle fixture', () => {
    const bytes = (hex: string) =>
      Uint8Array.from(hex.match(/../g) ?? [], (value) => Number.parseInt(value, 16));
    const decoded = decodeEtFrames(
      bytes(oracleFixture.runtime),
      bytes(oracleFixture.battery),
      bytes(oracleFixture.meter),
      1_777_478_400_000,
    );
    expect(Object.keys(decoded.raw).sort()).toEqual(Object.keys(oracleFixture.values).sort());
    for (const [key, expected] of Object.entries(oracleFixture.values)) {
      const actual = decoded.raw[key];
      if (typeof expected === 'number') expect(actual, key).toBeCloseTo(expected, 8);
      else expect(actual, key).toEqual(expected);
    }
    expect(decoded.snapshot.connection.inverter_time).toBe(decoded.raw.timestamp);
    expect(decoded.snapshot.battery.mode).toBe(decoded.raw.battery_mode_label ?? 'Unknown');
    expect(decoded.snapshot.solar.mppt1.mode).toBe(decoded.raw.pv1_mode_label ?? 'Unknown');
    expect(decoded.snapshot.grid.grid_mode).toBe(decoded.raw.grid_mode_label ?? 'Unknown');
    expect(decoded.snapshot.system.work_mode).toBe(decoded.raw.work_mode_label ?? 'Unknown');
  });

  it('preserves the desktop sign conventions and normalized power balance', () => {
    const runtime = frame(250, 11);
    const battery = frame(48, 12);
    const meter = frame(90, 13);

    setU16(runtime, 35100, 35103, 3550);
    setU16(runtime, 35100, 35104, 42);
    setU32(runtime, 35100, 35105, 1491);
    setU16(runtime, 35100, 35107, 3480);
    setU16(runtime, 35100, 35108, 39);
    setU32(runtime, 35100, 35109, 1357);
    setU16(runtime, 35100, 35121, 2312);
    setU16(runtime, 35100, 35122, 18);
    setU16(runtime, 35100, 35123, 5001);
    setI16(runtime, 35100, 35140, -450);
    setI16(runtime, 35100, 35170, 120);
    setU16(runtime, 35100, 35176, 327);
    setU16(runtime, 35100, 35180, 510);
    setI16(runtime, 35100, 35181, -123);
    setI32(runtime, 35100, 35182, -627);
    setU32(runtime, 35100, 35191, 12_345);
    setU32(runtime, 35100, 35193, 67);
    setU16(runtime, 35100, 35199, 12);
    setU32(runtime, 35100, 35200, 555);
    setU16(runtime, 35100, 35202, 9);
    setU32(runtime, 35100, 35203, 999);
    setU16(runtime, 35100, 35205, 24);

    setU16(battery, 37000, 37003, 251);
    setU16(battery, 37000, 37007, 73);
    setU16(battery, 37000, 37008, 98);
    setU16(battery, 37000, 37022, 3330);
    setU16(battery, 37000, 37023, 3312);

    setI16(meter, 36000, 36008, -450);
    setU16(meter, 36000, 36004, 1);

    const decoded = decodeEtFrames(runtime, battery, meter, 1_777_478_400_000);
    expect(decoded.raw).toMatchObject({
      vpv1: 355,
      ipv1: 4.2,
      ppv1: 1491,
      ppv2: 1357,
      ppv: 2848,
      pbattery1: -627,
      active_power_total: -450,
      house_consumption: 2671,
      battery_soc: 73,
      battery_max_cell_voltage: 3.33,
      battery_min_cell_voltage: 3.312,
    });
    expect(decoded.snapshot.power).toEqual({
      pv_w: 2848,
      home_w: 2671,
      grid_w: -450,
      battery_w: -627,
      backup_w: 120,
      battery_soc_pct: 73,
      grid_direction: 'import',
      battery_direction: 'charge',
    });
    expect(decoded.snapshot.today).toMatchObject({ solar_kwh: 6.7, load_kwh: 2.4 });
    expect(decoded.snapshot.lifetime).toMatchObject({ solar_kwh: 1234.5, load_kwh: 99.9 });
    expect(decoded.history.grid_frequency_hz).toBe(50.01);
    expect(Object.keys(decoded.raw)).toHaveLength(145);
  });

  it('rejects frames outside the three approved ET response shapes', () => {
    expect(() => decodeEtFrames(frame(249), frame(48), frame(90), 0)).toThrow(
      'Invalid runtime frame',
    );
  });
});
