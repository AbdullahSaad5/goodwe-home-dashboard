import type { Period } from './types';

function parseAnchor(anchor: string): Date {
  const [year, month, day] = anchor.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatAnchor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function shiftAnchor(anchor: string, period: Period, direction: -1 | 1): string {
  const date = parseAnchor(anchor);
  if (period === 'day' || period === 'week') {
    date.setUTCDate(date.getUTCDate() + direction * (period === 'week' ? 7 : 1));
    return formatAnchor(date);
  }

  const originalDay = date.getUTCDate();
  const targetMonth = period === 'month' ? date.getUTCMonth() + direction : date.getUTCMonth();
  const targetYear = period === 'year' ? date.getUTCFullYear() + direction : date.getUTCFullYear();
  const normalized = new Date(Date.UTC(targetYear, targetMonth, 1));
  normalized.setUTCDate(
    Math.min(originalDay, daysInMonth(normalized.getUTCFullYear(), normalized.getUTCMonth())),
  );
  return formatAnchor(normalized);
}

export function todayInTimeZone(timeZone = 'Asia/Karachi', now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function readableAnchor(anchor: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(parseAnchor(anchor));
}
