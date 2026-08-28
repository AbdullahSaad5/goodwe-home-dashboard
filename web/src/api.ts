import type {
  CommandCenterResponse,
  CommandHistoryRange,
  EventItem,
  HistoryResponse,
  Period,
  SensorReading,
  Snapshot,
  Summary,
  TrendRange,
} from './types';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export const api = {
  status: () => getJson<Snapshot>('/api/v1/status'),
  history: (period: Period, anchor?: string) =>
    getJson<HistoryResponse>(
      `/api/v1/history?period=${period}${anchor ? `&anchor=${anchor}` : ''}`,
    ),
  summary: (period: Period, anchor?: string) =>
    getJson<Summary>(`/api/v1/summary?period=${period}${anchor ? `&anchor=${anchor}` : ''}`),
  sensors: () => getJson<SensorReading[]>('/api/v1/sensors'),
  events: () => getJson<EventItem[]>('/api/v1/events?limit=100'),
  commandCenter: (range: TrendRange, history: CommandHistoryRange) =>
    getJson<CommandCenterResponse>(`/api/v1/command-center?range=${range}&history=${history}`),
};
