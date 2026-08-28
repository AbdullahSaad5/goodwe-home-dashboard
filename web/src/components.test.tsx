import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopHeader,
  MobileNavigation,
  RefreshPill,
  connectionMessage,
  isWallModeExitKey,
  notificationAvailability,
  refreshCountdown,
} from './App';
import { OperatingCommandBar, PowerTrendsPanel, ProjectionPanel } from './CommandCenterComponents';
import {
  AnimatedReading,
  HistoryControls,
  LiveFlowCard,
  PeriodControl,
  animationDuration,
} from './DashboardComponents';
import { LoadingPage } from './DashboardPages';
import { demoCommandCenter, demoEvents, demoSnapshot } from './demo';
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
    render(
      <HistoryControls
        period="day"
        setPeriod={vi.fn()}
        anchor="2026-08-28"
        setAnchor={setAnchor}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(setAnchor).toHaveBeenCalledWith('2026-08-27');
  });

  it('disables navigation beyond the current reporting day', () => {
    render(
      <HistoryControls
        period="day"
        setPeriod={vi.fn()}
        anchor={todayInTimeZone()}
        setAnchor={vi.fn()}
      />,
    );
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
    render(
      <TooltipProvider>
        <DesktopHeader
          page="overview"
          setPage={setPage}
          snapshot={demoSnapshot}
          events={demoEvents}
          nextRefreshAt={Date.now() + 10_000}
          wallMode={false}
          onToggleWallMode={vi.fn()}
          notificationStatus="default"
          onEnableNotifications={vi.fn()}
        />
      </TooltipProvider>,
    );
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

  it('explains the safe local connection while waiting for telemetry', () => {
    render(<LoadingPage loading stage="collector" />);
    expect(screen.getByRole('heading', { name: 'Connecting to GoodWe Home' })).toBeInTheDocument();
    expect(screen.getByText('Read-only by design')).toBeInTheDocument();
    expect(
      screen.getByText('No inverter commands are sent and telemetry stays on your network.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Connection progress' })).toBeInTheDocument();
  });

  it('distinguishes overview preparation from inverter connection', () => {
    render(<LoadingPage loading stage="overview" />);
    expect(
      screen.getByRole('heading', { name: 'Preparing your energy overview' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Telemetry connected')).toBeInTheDocument();
    expect(screen.getByText('Preparing')).toBeInTheDocument();
  });

  it('offers an immediate retry when overview preparation fails', async () => {
    const onRetry = vi.fn();
    render(<LoadingPage loading={false} stage="overview" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers an immediate retry when the local collector does not respond', async () => {
    const onRetry = vi.fn();
    render(<LoadingPage loading={false} stage="collector" onRetry={onRetry} />);
    expect(
      screen.getByRole('heading', { name: 'Local collector is not responding' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('gives the connected operating mode a clearly labelled live supply metric', () => {
    render(<OperatingCommandBar data={demoCommandCenter} />);
    expect(screen.getByText('Dominant supply')).toBeInTheDocument();
    expect(screen.getByText('Live now')).toBeInTheDocument();
    expect(screen.getByLabelText('Live system health signals').children).toHaveLength(5);
  });

  it('explains browser notification availability without requesting permission', () => {
    expect(notificationAvailability(false, true)).toBe('insecure');
    expect(notificationAvailability(true, false)).toBe('unsupported');
    expect(notificationAvailability(true, true, 'denied')).toBe('denied');
  });

  it('reserves Escape for leaving wall mode', () => {
    expect(isWallModeExitKey('Escape')).toBe(true);
    expect(isWallModeExitKey('Enter')).toBe(false);
  });

  it('switches the operational trend range and accessible table mode', async () => {
    const setRange = vi.fn();
    render(
      <PowerTrendsPanel
        data={demoCommandCenter}
        range="24h"
        setRange={setRange}
        initialView="table"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '3h' }));
    expect(setRange).toHaveBeenCalledWith('3h');
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it.each(['unconfigured', 'collecting', 'stale', 'unavailable'] as const)(
    'renders the %s projection readiness state without a numeric estimate',
    (status) => {
      const data = structuredClone(demoCommandCenter);
      data.projection = { ...data.projection, status, reason: `${status} reason`, points: [] };
      render(<ProjectionPanel data={data} />);
      expect(
        screen.getByText(status.charAt(0).toUpperCase() + status.slice(1), { exact: true }),
      ).toBeInTheDocument();
      expect(screen.getByText(`${status} reason`)).toBeInTheDocument();
    },
  );

  it('renders a ready projection as a policy-backed result', () => {
    const data = structuredClone(demoCommandCenter);
    data.projection = {
      ...data.projection,
      status: 'ready',
      reason: 'ready',
      lowest_soc_pct: 42,
      lowest_soc_at: new Date().toISOString(),
      points: [],
    };
    render(<ProjectionPanel data={data} />);
    expect(screen.getByText('Reserve policy')).toBeInTheDocument();
    expect(screen.getByText('Protected')).toBeInTheDocument();
  });
});
