import { describe, expect, it } from 'vitest';
import { demoSnapshot, demoSummary } from './demo';
import { formatNumber, formatPower } from './format';
import { comparisonPercent, batteryDirection, buildLiveMetrics, buildSolarUse, gridDirection } from './ui';
import { shiftAnchor } from './period';

describe('live dashboard presentation data', () => {
  it('maps real snapshot values into the four overview metrics', () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.power.grid_w = -1547;
    snapshot.power.grid_direction = 'import';
    snapshot.power.battery_w = 1071;
    snapshot.power.battery_direction = 'discharge';
    const metrics = buildLiveMetrics(snapshot);

    expect(metrics).toHaveLength(4);
    expect(metrics[0]).toMatchObject({ id: 'solar', label: 'Solar production' });
    expect(metrics[1].detail).toContain('19.4 kWh');
    expect(metrics[2]).toMatchObject({ id: 'battery', value: '1.07 kW', detail: 'discharge' });
    expect(metrics[3]).toMatchObject({ id: 'grid', label: 'Grid import', value: '1.55 kW' });
  });

  it('preserves the inverter sign conventions', () => {
    expect(batteryDirection(900)).toBe('discharge');
    expect(batteryDirection(-900)).toBe('charge');
    expect(batteryDirection(5)).toBe('idle');
    expect(gridDirection(900)).toBe('export');
    expect(gridDirection(-900)).toBe('import');
    expect(gridDirection(5)).toBe('idle');
  });

  it('does not fabricate unavailable values', () => {
    expect(formatNumber(undefined)).toBe('—');
    expect(formatPower(null)).toBe('—');
  });

  it('shows no solar-use split when generation is zero', () => {
    const summary = structuredClone(demoSummary);
    summary.energy.solar_kwh = 0;
    expect(buildSolarUse(summary)).toMatchObject({ retainedPct: null, exportedPct: null, generatedKwh: 0 });
  });

  it('calculates honest comparisons only when a prior value exists', () => {
    expect(comparisonPercent(125, 100)).toBe(25);
    expect(comparisonPercent(20, 0)).toBeNull();
    expect(comparisonPercent(20, null)).toBeNull();
  });

  it('moves anchored periods without overflowing calendar months', () => {
    expect(shiftAnchor('2026-03-31', 'day', -1)).toBe('2026-03-30');
    expect(shiftAnchor('2026-03-31', 'week', -1)).toBe('2026-03-24');
    expect(shiftAnchor('2026-03-31', 'month', -1)).toBe('2026-02-28');
    expect(shiftAnchor('2024-02-29', 'year', 1)).toBe('2025-02-28');
  });
});
