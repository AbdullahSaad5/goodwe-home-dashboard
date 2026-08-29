export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function formatPower(watts: number | null | undefined, signed = false): string {
  if (watts == null || !Number.isFinite(watts)) return '—';
  const value = signed ? watts : Math.abs(watts);
  const sign = signed && value > 0 ? '+' : '';
  if (Math.abs(value) >= 1000) return `${sign}${formatNumber(value / 1000, 2)} kW`;
  return `${sign}${formatNumber(value, 0)} W`;
}

export function formatDateTime(value: string | null | undefined, timeZone: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatTime(value: string | null | undefined, timeZone: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function since(seconds: number | null | undefined): string {
  if (seconds == null) return 'Waiting for data';
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

export function periodLabel(period: string): string {
  return period === 'day' ? 'Today' : `This ${period}`;
}
