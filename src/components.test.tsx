import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DesktopHeader, MobileNavigation, RefreshPill, connectionMessage, refreshCountdown } from './App';
import { AnimatedReading, HistoryControls, LiveFlowCard, PeriodControl, animationDuration } from './DashboardComponents';
import { demoEvents, demoSnapshot } from './demo';
import { TooltipProvider } from './components/ui/tooltip';
import { todayInTimeZone } from './period';

describe('dashboard interactions', () => {
  it('changes the selected chart period', async () => {
    const setPeriod = vi.fn();
    render(<PeriodControl period="day" setPeriod={setPeriod} />);
    await userEvent.click(screen.getByRole('button', { name: 'week' }));
    expect(setPeriod).toHaveBeenCalledWith('week');
  });

  it('exposes secondary sections from the mobile More dialog', async () => {
    const setPage = vi.fn();
    render(<MobileNavigation page="overview" setPage={setPage} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Raw Data' }));
    expect(setPage).toHaveBeenCalledWith('raw');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves the visible chart to the previous anchored period', async () => {
    const setAnchor = vi.fn();
    render(<HistoryControls period="day" setPeriod={vi.fn()} anchor="2026-08-28" setAnchor={setAnchor} />);
    await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(setAnchor).toHaveBeenCalledWith('2026-08-27');
  });

  it('disables navigation beyond the current reporting day', () => {
    render(<HistoryControls period="day" setPeriod={vi.fn()} anchor={todayInTimeZone()} setAnchor={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });

  it('dismisses the mobile More dialog with Escape', async () => {
    render(<MobileNavigation page="overview" setPage={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('navigates desktop sections and exposes Raw Data in profile overflow', async () => {
    const setPage = vi.fn();
    render(<TooltipProvider><DesktopHeader page="overview" setPage={setPage} snapshot={demoSnapshot} events={demoEvents} nextRefreshAt={Date.now() + 10_000} /></TooltipProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(setPage).toHaveBeenCalledWith('history');
    await userEvent.click(screen.getByRole('button', { name: 'Open account and technical menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Raw Data' }));
    expect(setPage).toHaveBeenCalledWith('raw');
  });

  it('turns chart animation off for reduced-motion users', () => {
    expect(animationDuration(true, 320)).toBe(0);
    expect(animationDuration(false, 320)).toBe(320);
  });

  it('shows the live refresh countdown in the header', () => {
    const now = Date.now();
    expect(refreshCountdown(now + 8_100, now)).toBe(9);
    render(<RefreshPill nextRefreshAt={now + 8_100} connectionState="live" />);
    expect(screen.getByText(/Refresh in/)).toHaveTextContent('Refresh in 9s');
  });

  it('labels live flow directions without relying on color', () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.power.grid_direction = 'import';
    snapshot.power.grid_w = -800;
    render(<LiveFlowCard snapshot={snapshot} />);
    expect(screen.getByLabelText(/grid import 800 W/i)).toBeInTheDocument();
    expect(screen.getByText('Importing')).toBeInTheDocument();
  });

  it('counts through intermediate values when a live reading changes', async () => {
    const view = render(<AnimatedReading value="10 W" />);
    view.rerender(<AnimatedReading value="20 W" />);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const intermediate = Number(view.container.textContent?.match(/[+-]?\d+(?:\.\d+)?/)?.[0]);
    expect(intermediate).toBeGreaterThan(10);
    expect(intermediate).toBeLessThan(20);
    await waitFor(() => expect(view.container).toHaveTextContent('20 W'), { timeout: 900 });
  });

  it('provides specific stale and offline messages', () => {
    expect(connectionMessage('live')).toBeNull();
    expect(connectionMessage('stale')).toContain('30 seconds');
    expect(connectionMessage('offline')).toContain('stored history is safe');
  });
});
