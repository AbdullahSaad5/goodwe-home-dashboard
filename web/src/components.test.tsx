import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopHeader,
  HeaderClock,
  MobileNavigation,
  RefreshPill,
  ThemeToggle,
  connectionMessage,
  isWallModeExitKey,
  notificationAvailability,
  refreshCountdown,
} from './App';
import {
  ForecastPanel,
  OperatingCommandBar,
  PowerTrendsPanel,
  ProjectionPanel,
} from './CommandCenterComponents';
import {
  AnimatedReading,
  HistoryControls,
  LiveFlowCard,
  PeriodControl,
  animationDuration,
} from './DashboardComponents';
import { EventList, LoadingPage, SystemPage } from './DashboardPages';
import { demoCommandCenter, demoEvents, demoSnapshot } from './demo';
import { TooltipProvider } from './components/ui/tooltip';
import { todayInTimeZone } from './period';
import { ReportingTimeZoneProvider } from './reportingTimeZone';

describe('dashboard interactions', () => {
  it('shows daily weather while the solar estimate is still calibrating', () => {
    const data = structuredClone(demoCommandCenter);
    data.forecast.status = 'collecting';
    data.forecast.reason =
      'Seven valid days are required before showing calibrated solar estimates';
    data.forecast.weather_days = [
      {
        day: '2026-08-29',
        weather_code: 2,
        temperature_max_c: 33.5,
        temperature_min_c: 24,
        precipitation_probability_max_pct: 20,
        precipitation_mm: 0.4,
        wind_speed_max_kph: 17,
        sunrise: '2026-08-29T00:42:00.000Z',
        sunset: '2026-08-29T13:31:00.000Z',
      },
    ];

    render(<ForecastPanel data={data} onNavigate={vi.fn()} />);

    const outlook = screen.getByRole('region', { name: 'Seven-day weather outlook' });
    expect(within(outlook).getByText('Today')).toBeInTheDocument();
    expect(within(outlook).getByText('Partly cloudy')).toBeInTheDocument();
    expect(within(outlook).getByText('34° / 24°')).toBeInTheDocument();
    expect(within(outlook).getByText('20% rain')).toBeInTheDocument();
    expect(within(outlook).getByText('17 km/h')).toBeInTheDocument();
    expect(screen.getByText(/Seven valid days are required/)).toBeInTheDocument();
  });

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
    const enableNotifications = vi.fn();
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
          onEnableNotifications={enableNotifications}
          theme="light"
          onToggleTheme={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getAllByRole('button', { name: 'Open alerts and notification settings' }),
    ).toHaveLength(1);
    await userEvent.click(
      screen.getByRole('button', { name: 'Open alerts and notification settings' }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Enable desktop notifications' }),
    );
    expect(enableNotifications).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole('button', { name: 'Open alerts and notification settings' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: /View alerts and events/ }));
    expect(setPage).toHaveBeenCalledWith('system');
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

  it('offers an accessible light and dark mode toggle', async () => {
    const onToggle = vi.fn();
    const view = render(
      <TooltipProvider>
        <ThemeToggle theme="light" onToggle={onToggle} />
      </TooltipProvider>,
    );
    const toggle = screen.getByRole('button', { name: 'Dark mode' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();

    view.rerender(
      <TooltipProvider>
        <ThemeToggle theme="dark" onToggle={onToggle} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the live refresh countdown in the header', () => {
    const now = Date.now();
    expect(refreshCountdown(now + 8_100, now)).toBe(9);
    render(<RefreshPill nextRefreshAt={now + 8_100} connectionState="live" />);
    expect(screen.getByText(/Refresh in/)).toHaveTextContent('Refresh in 9s');
  });

  it('renders the header clock in the configured reporting timezone', () => {
    render(
      <ReportingTimeZoneProvider timeZone="Asia/Karachi">
        <HeaderClock now={new Date('2026-08-29T10:00:00Z').getTime()} />
      </ReportingTimeZoneProvider>,
    );
    expect(screen.getByText(/3:00:00 PM/)).toBeInTheDocument();
  });

  it('uses the configured timezone for the reporting label and calendar boundary', () => {
    render(
      <ReportingTimeZoneProvider timeZone="America/Toronto">
        <SystemPage snapshot={demoSnapshot} events={[]} />
        <HistoryControls
          period="day"
          setPeriod={vi.fn()}
          anchor="2026-08-28"
          setAnchor={vi.fn()}
          now={new Date('2026-08-29T02:00:00Z')}
        />
      </ReportingTimeZoneProvider>,
    );
    expect(screen.getByText('America/Toronto')).toBeInTheDocument();
    expect(screen.getByLabelText('Chart anchor date')).toHaveAttribute('max', '2026-08-28');
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
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
    expect(screen.getByText('GoodWe Home')).toBeInTheDocument();
    expect(screen.queryByText('Local energy link')).not.toBeInTheDocument();
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

  it('renders event history with meaning and relevant inverter facts', () => {
    render(
      <EventList
        events={[
          {
            id: 25,
            created_at: '2026-08-28T20:25:37.055818Z',
            severity: 'error',
            event_type: 'system_health',
            message: 'The inverter reported an error',
            details: {
              error_code: 537002496,
              errors: 'Utility Loss, Vac Failure, Fac Failure',
            },
          },
        ]}
      />,
    );

    expect(screen.getByText('Grid supply fault reported')).toBeInTheDocument();
    expect(screen.getByText(/utility grid was unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('What this means:')).toBeInTheDocument();
    expect(screen.getByText('Reported faults')).toBeInTheDocument();
    expect(screen.queryByText('system_health')).not.toBeInTheDocument();
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
