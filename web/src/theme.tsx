import { createContext, useContext, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'goodwe-theme';

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readStoredTheme(storage?: ThemeStorage): string | null {
  try {
    return (storage ?? window.localStorage).getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistTheme(theme: Theme, storage?: ThemeStorage): boolean {
  try {
    (storage ?? window.localStorage).setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

export const chartTheme = {
  light: {
    tooltipBackground: '#ffffff',
    tooltipBorder: '#e2e8f0',
    tooltipText: '#172033',
    tooltipMuted: '#64748b',
    tooltipSubtle: '#94a3b8',
    axis: '#dfe5ed',
    label: '#667085',
    grid: '#e8edf4',
    zero: '#cbd5e1',
    areaEnd: '#ffffff',
    pieBorder: '#ffffff',
  },
  dark: {
    tooltipBackground: '#172235',
    tooltipBorder: '#334155',
    tooltipText: '#f1f5f9',
    tooltipMuted: '#b6c2d2',
    tooltipSubtle: '#94a3b8',
    axis: '#3a4a61',
    label: '#9cacc1',
    grid: '#2a394e',
    zero: '#52627a',
    areaEnd: '#111b2b',
    pieBorder: '#111b2b',
  },
} as const;

const ThemeContext = createContext<Theme>('light');

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
