import type { Snapshot, Summary } from './types';
import { formatNumber, formatPower } from './format';

export const palette = {
  solar: '#2563eb',
  home: '#f97316',
  battery: '#2eae73',
  grid: '#8b5cf6',
  backup: '#64748b',
  soc: '#2563eb',
  text: '#172033',
  muted: '#667085',
};

export type MetricTone = 'solar' | 'home' | 'battery' | 'grid' | 'neutral';

export interface LiveMetric {
  id: 'solar' | 'home' | 'battery' | 'grid';
  label: string;
  value: string;
  detail: string;
  tone: MetricTone;
}

export function buildLiveMetrics(snapshot: Snapshot): LiveMetric[] {
  const gridCounter = snapshot.power.grid_direction === 'import'
    ? snapshot.today.import_kwh
    : snapshot.today.export_kwh;
  const gridLabel = snapshot.power.grid_direction === 'import'
    ? 'Grid import'
    : snapshot.power.grid_direction === 'export'
      ? 'Grid export'
      : 'Grid exchange';

  return [
    {
      id: 'solar', label: 'Solar production', value: formatPower(snapshot.power.pv_w),
      detail: `Today ${formatNumber(snapshot.today.solar_kwh)} kWh`, tone: 'solar',
    },
    {
      id: 'home', label: 'Home consumption', value: formatPower(snapshot.power.home_w),
      detail: `Today ${formatNumber(snapshot.today.load_kwh)} kWh`, tone: 'home',
    },
    {
      id: 'battery', label: `Battery ${formatNumber(snapshot.power.battery_soc_pct, 0)}%`,
      value: formatPower(snapshot.power.battery_w), detail: snapshot.power.battery_direction, tone: 'battery',
    },
    {
      id: 'grid', label: gridLabel, value: formatPower(snapshot.power.grid_w),
      detail: `Today ${formatNumber(gridCounter)} kWh`, tone: 'grid',
    },
  ];
}

export interface SolarUse {
  retainedPct: number | null;
  exportedPct: number | null;
  generatedKwh: number;
  exportedKwh: number;
}

export function buildSolarUse(summary: Summary | null): SolarUse {
  const generatedKwh = summary?.energy.solar_kwh ?? 0;
  const exportedKwh = summary?.energy.export_kwh ?? 0;
  if (generatedKwh <= 0 || summary?.solar_retention_pct == null) {
    return { retainedPct: null, exportedPct: null, generatedKwh, exportedKwh };
  }
  const retainedPct = Math.max(0, Math.min(100, summary.solar_retention_pct));
  return { retainedPct, exportedPct: 100 - retainedPct, generatedKwh, exportedKwh };
}

export function batteryDirection(powerW: number): 'charge' | 'discharge' | 'idle' {
  if (powerW > 20) return 'discharge';
  if (powerW < -20) return 'charge';
  return 'idle';
}

export function gridDirection(powerW: number): 'import' | 'export' | 'idle' {
  if (powerW > 20) return 'export';
  if (powerW < -20) return 'import';
  return 'idle';
}

export function comparisonPercent(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous * 100;
}
