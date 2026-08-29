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
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) window.dispatchEvent(new Event('goodwe-auth-required'));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export const api = {
  session: () => getJson<{ authenticated: boolean }>('/api/v1/auth/session'),
  login: async (passphrase: string, turnstileToken: string) => {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase, turnstileToken }),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  },
  logout: async () => {
    const response = await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  },
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
