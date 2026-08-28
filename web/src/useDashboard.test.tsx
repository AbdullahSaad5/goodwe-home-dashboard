import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import {
  demoCommandCenter,
  demoEvents,
  demoHistory,
  demoSensors,
  demoSnapshot,
  demoSummary,
} from './demo';
import { todayInTimeZone } from './period';
import { useDashboard } from './useDashboard';
import type { Snapshot } from './types';

vi.mock('./api', () => ({
  api: {
    status: vi.fn(),
    history: vi.fn(),
    summary: vi.fn(),
    sensors: vi.fn(),
    events: vi.fn(),
    commandCenter: vi.fn(),
  },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, EventListener>();

  constructor() {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() {}

  emitSnapshot(snapshot: Snapshot) {
    this.listeners.get('snapshot')?.(
      new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }),
    );
  }
}

describe('dashboard refresh coordination', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(api.status).mockResolvedValue(demoSnapshot);
    vi.mocked(api.history).mockResolvedValue(demoHistory);
    vi.mocked(api.summary).mockResolvedValue(demoSummary);
    vi.mocked(api.sensors).mockResolvedValue(demoSensors);
    vi.mocked(api.events).mockResolvedValue(demoEvents);
    vi.mocked(api.commandCenter).mockResolvedValue(demoCommandCenter);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('refreshes every live dataset when a new inverter snapshot arrives', async () => {
    renderHook(() => useDashboard('day', todayInTimeZone(), '24h', '30d'));

    await waitFor(() => {
      expect(api.status).toHaveBeenCalledTimes(1);
      expect(api.history).toHaveBeenCalledTimes(1);
      expect(api.commandCenter).toHaveBeenCalledTimes(1);
      expect(api.sensors).toHaveBeenCalledTimes(1);
      expect(api.events).toHaveBeenCalledTimes(1);
    });

    act(() => {
      FakeEventSource.instances[0].emitSnapshot({
        ...demoSnapshot,
        connection: {
          ...demoSnapshot.connection,
          last_updated: '2026-08-28T22:10:00Z',
        },
      });
    });

    await waitFor(() => {
      expect(api.history).toHaveBeenCalledTimes(2);
      expect(api.commandCenter).toHaveBeenCalledTimes(2);
      expect(api.sensors).toHaveBeenCalledTimes(2);
      expect(api.events).toHaveBeenCalledTimes(2);
    });
  });
});
