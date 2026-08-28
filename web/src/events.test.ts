import { describe, expect, it } from 'vitest';
import { describeEvent } from './events';
import type { EventItem } from './types';

function event(overrides: Partial<EventItem>): EventItem {
  return {
    id: 1,
    created_at: '2026-08-28T20:25:37.055818Z',
    severity: 'info',
    event_type: 'collector_started',
    message: 'Local energy collector started',
    details: {},
    ...overrides,
  };
}

describe('event explanations', () => {
  it('translates inverter grid faults into plain-language meaning', () => {
    const result = describeEvent(
      event({
        severity: 'error',
        event_type: 'system_health',
        message: 'The inverter reported an error',
        details: {
          warning_code: 0,
          error_code: 537002496,
          errors: 'Utility Loss, Vac Failure, Fac Failure',
          battery_warning: '',
          battery_error: '',
        },
      }),
    );

    expect(result.title).toBe('Grid supply fault reported');
    expect(result.summary).toContain('utility grid was unavailable');
    expect(result.summary).toContain('voltage');
    expect(result.summary).toContain('frequency');
    expect(result.guidance).toContain('grid-connected operation may be interrupted');
    expect(result.facts).toContainEqual({ label: 'Error code', value: '537002496' });
  });

  it('distinguishes telemetry loss from a utility outage', () => {
    const result = describeEvent(
      event({
        severity: 'error',
        event_type: 'connection_lost',
        message: 'Unable to reach the inverter on the local network',
        details: {
          host: '192.168.100.147',
          port: 502,
          failures: 3,
          reason: 'Connection timed out',
        },
      }),
    );

    expect(result.title).toBe('Inverter telemetry connection lost');
    expect(result.summary).toContain('3 consecutive attempts');
    expect(result.guidance).toContain('not recorded as a utility outage');
    expect(result.facts).toContainEqual({ label: 'Inverter', value: '192.168.100.147:502' });
  });

  it('explains ordinary collector startup without exposing an internal event key', () => {
    const result = describeEvent(event({ details: { host: '192.168.100.147', port: 502 } }));

    expect(result.title).toBe('Monitoring started');
    expect(result.typeLabel).toBe('Collector');
    expect(result.summary).toContain('read-only collector started polling');
    expect(result.guidance).toBe('No action is required.');
  });

  it('keeps unknown future events readable', () => {
    const result = describeEvent(
      event({
        event_type: 'future_protocol_notice',
        message: 'A future notice was received',
        details: { protocol_mode: 'Eco' },
      }),
    );

    expect(result.title).toBe('A future notice was received');
    expect(result.typeLabel).toBe('Future protocol notice');
    expect(result.facts).toContainEqual({ label: 'Protocol mode', value: 'Eco' });
  });
});
