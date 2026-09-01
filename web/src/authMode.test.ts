import { describe, expect, it } from 'vitest';
import { shouldBypassDashboardAuth } from './authMode';

describe('dashboard authentication mode', () => {
  it('bypasses cloud authentication only for development and explicit local builds', () => {
    expect(shouldBypassDashboardAuth({ dev: true, mode: 'development' })).toBe(true);
    expect(shouldBypassDashboardAuth({ dev: false, mode: 'lan' })).toBe(true);
    expect(shouldBypassDashboardAuth({ dev: false, mode: 'production' })).toBe(false);
  });
});
