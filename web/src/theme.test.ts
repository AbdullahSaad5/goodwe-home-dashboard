import { describe, expect, it } from 'vitest';
import { chartTheme, persistTheme, readStoredTheme, resolveTheme } from './theme';

describe('dashboard theme', () => {
  it('uses a saved choice before the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('uses the system preference when no valid choice is saved', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme('unknown', false)).toBe('light');
  });

  it('provides dark canvas colors for chart-rendered content', () => {
    expect(chartTheme.dark.tooltipBackground).not.toBe(chartTheme.light.tooltipBackground);
    expect(chartTheme.dark.tooltipText).toBe('#f1f5f9');
    expect(chartTheme.dark.areaEnd).toBe('#111b2b');
  });

  it('falls back safely when browser storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    };

    expect(readStoredTheme(storage)).toBeNull();
    expect(persistTheme('dark', storage)).toBe(false);
  });

  it('falls back safely when accessing localStorage itself is blocked', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
    });

    try {
      expect(readStoredTheme()).toBeNull();
      expect(persistTheme('dark')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});
