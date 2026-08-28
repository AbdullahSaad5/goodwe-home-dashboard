import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  BatteryCharging,
  Bell,
  BellRing,
  ChevronDown,
  Database,
  Grid3X3,
  History,
  LayoutDashboard,
  Menu,
  Maximize2,
  Minimize2,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import {
  BatteryPage,
  GridPage,
  HistoryPage,
  LoadingPage,
  OverviewPage,
  RawPage,
  SolarPage,
  SystemPage,
} from './DashboardPages';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { since } from './format';
import { todayInTimeZone } from './period';
import type { CommandHistoryRange, EventItem, Page, Period, Snapshot, TrendRange } from './types';
import { useDashboard } from './useDashboard';

interface NavigationItem {
  page: Page;
  label: string;
  icon: LucideIcon;
}

export const navigation: NavigationItem[] = [
  { page: 'overview', label: 'Overview', icon: LayoutDashboard },
  { page: 'history', label: 'History', icon: History },
  { page: 'solar', label: 'Solar', icon: Sun },
  { page: 'battery', label: 'Battery', icon: BatteryCharging },
  { page: 'grid', label: 'Grid & Loads', icon: Grid3X3 },
  { page: 'system', label: 'System', icon: Settings },
];

const rawItem: NavigationItem = { page: 'raw', label: 'Raw Data', icon: Database };
const mobilePrimary = navigation.slice(0, 4);
const mobileMore = [...navigation.slice(4), rawItem];
const initialClockTime = Date.now();

export type NotificationAvailability =
  'unsupported' | 'insecure' | 'default' | 'denied' | 'granted';

export function notificationAvailability(
  secure: boolean,
  supported: boolean,
  permission: NotificationPermission = 'default',
): NotificationAvailability {
  if (!supported) return 'unsupported';
  if (!secure) return 'insecure';
  return permission;
}

export function isWallModeExitKey(key: string): boolean {
  return key === 'Escape';
}

function useDesktopNotifications(events: EventItem[]) {
  const [availability, setAvailability] = useState<NotificationAvailability>(() =>
    notificationAvailability(
      window.isSecureContext,
      'Notification' in window,
      'Notification' in window ? Notification.permission : 'default',
    ),
  );

  const enable = async () => {
    if (!window.isSecureContext || !('Notification' in window)) return;
    const permission = await Notification.requestPermission();
    setAvailability(permission);
    if (permission === 'granted') {
      const latest = Math.max(0, ...events.map((event) => event.id));
      window.localStorage.setItem('goodwe-last-notified-event', String(latest));
    }
  };

  useEffect(() => {
    if (availability !== 'granted') return;
    const stored = window.localStorage.getItem('goodwe-last-notified-event');
    if (stored == null) {
      const latest = Math.max(0, ...events.map((event) => event.id));
      window.localStorage.setItem('goodwe-last-notified-event', String(latest));
      return;
    }
    const last = Number(stored);
    const alertEvents = events
      .filter((event) => event.severity !== 'info' && event.id > last)
      .sort((left, right) => left.id - right.id);
    for (const event of alertEvents) {
      new Notification('GoodWe Home alert', { body: event.message, tag: `event-${event.id}` });
      window.localStorage.setItem('goodwe-last-notified-event', String(event.id));
    }
  }, [availability, events]);

  return { availability, enable };
}

function Brand() {
  return (
    <div className="brand" aria-label="GoodWe Home">
      <strong className="goodwe-wordmark">GOODWE</strong>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-copy">
        <span className="brand-name">GoodWe Home</span>
        <small>Energy command center</small>
      </span>
    </div>
  );
}

function ConnectionHeader() {
  return (
    <header className="app-header connection-header">
      <Brand />
      <div className="connection-header-status" aria-label="Connection properties">
        <span className="local-pill">
          <Radio /> Local network
        </span>
        <span className="read-only-pill">
          <ShieldCheck /> Read-only
        </span>
      </div>
    </header>
  );
}

function NavigationButton({
  item,
  active,
  select,
  compact = false,
}: {
  item: NavigationItem;
  active: boolean;
  select: (page: Page) => void;
  compact?: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className={`nav-button ${active ? 'active' : ''} ${compact ? 'compact' : ''}`}
      onClick={() => select(item.page)}
      aria-current={active ? 'page' : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
    </button>
  );
}

export function MobileNavigation({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <nav className="mobile-nav" aria-label="Mobile dashboard sections">
      {mobilePrimary.map((item) => (
        <NavigationButton
          key={item.page}
          item={item}
          active={page === item.page}
          select={setPage}
          compact
        />
      ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className={`nav-button compact ${mobileMore.some((item) => item.page === page) ? 'active' : ''}`}
          >
            <Menu aria-hidden="true" />
            <span>More</span>
          </button>
        </DialogTrigger>
        <DialogContent className="more-dialog">
          <div className="dialog-heading">
            <div>
              <DialogTitle>More sections</DialogTitle>
              <DialogDescription>System details and technical readings</DialogDescription>
            </div>
          </div>
          <div className="more-grid">
            {mobileMore.map((item) => (
              <NavigationButton
                key={item.page}
                item={item}
                active={page === item.page}
                select={(next) => {
                  setPage(next);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="dialog-read-only">
            <span className="status-dot" />
            <span>
              <strong>LAN only</strong> · Read-only inverter access
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </nav>
  );
}

export function refreshCountdown(nextRefreshAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((nextRefreshAt - now) / 1_000));
}

export function RefreshPill({
  nextRefreshAt,
  connectionState,
}: {
  nextRefreshAt: number;
  connectionState: Snapshot['connection']['state'];
}) {
  const [now, setNow] = useState(initialClockTime);
  const seconds = refreshCountdown(nextRefreshAt, now);
  const waiting = seconds === 0;
  const action = connectionState === 'live' ? 'Refresh' : 'Retry';

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className={`refresh-pill ${waiting ? 'refreshing' : ''} ${connectionState}`}
      aria-label={waiting ? `${action} due now` : `${action} in ${seconds} seconds`}
    >
      <RefreshCw aria-hidden="true" />
      <span>
        {waiting ? (
          `${action}ing…`
        ) : (
          <>
            {action} in <strong>{seconds}s</strong>
          </>
        )}
      </span>
    </div>
  );
}

function HeaderClock() {
  const [now, setNow] = useState(initialClockTime);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="header-clock">
      <span className="status-dot live" />
      {new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(now)}
    </span>
  );
}

export function DesktopHeader({
  page,
  setPage,
  snapshot,
  events,
  nextRefreshAt,
  wallMode,
  onToggleWallMode,
  notificationStatus,
  onEnableNotifications,
}: {
  page: Page;
  setPage: (page: Page) => void;
  snapshot: Snapshot;
  events: EventItem[];
  nextRefreshAt: number;
  wallMode: boolean;
  onToggleWallMode: () => void;
  notificationStatus: NotificationAvailability;
  onEnableNotifications: () => void;
}) {
  const eventCount = events.filter((event) => event.severity !== 'info').length;
  return (
    <header className="app-header">
      <Brand />
      <nav className="desktop-nav" aria-label="Dashboard sections">
        {navigation.map((item) => (
          <NavigationButton
            key={item.page}
            item={item}
            active={page === item.page}
            select={setPage}
          />
        ))}
      </nav>
      <div className="header-actions">
        <div className="header-status-cluster">
          <span className="read-only-pill">
            <ShieldCheck /> Read-only
          </span>
          <RefreshPill nextRefreshAt={nextRefreshAt} connectionState={snapshot.connection.state} />
          <HeaderClock />
        </div>
        <span className="header-action-divider" aria-hidden="true" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={`header-icon notifications-${notificationStatus}`}
              aria-label="Open alerts and notification settings"
            >
              <Bell />
              <span className="event-count">{eventCount}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Alerts & notifications</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPage('system')}>
              <Bell />
              View alerts and events
              <span className="menu-count">{eventCount}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onEnableNotifications}
              disabled={notificationStatus !== 'default'}
            >
              <BellRing />
              {notificationStatus === 'insecure'
                ? 'Requires localhost or HTTPS'
                : notificationStatus === 'granted'
                  ? 'Desktop notifications enabled'
                  : notificationStatus === 'denied'
                    ? 'Desktop notifications blocked'
                    : notificationStatus === 'unsupported'
                      ? 'Desktop notifications unavailable'
                      : 'Enable desktop notifications'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="header-icon wall-mode-button"
              onClick={onToggleWallMode}
              aria-label={wallMode ? 'Exit wall mode' : 'Enter wall mode'}
            >
              {wallMode ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{wallMode ? 'Exit wall mode' : 'Wall mode'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="header-icon"
              onClick={() => setPage('system')}
              aria-label="Open system settings"
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>System</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="profile-trigger"
              aria-label="Open account and technical menu"
            >
              <span className="avatar">GH</span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>GoodWe Home</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPage('raw')}>
              <Database />
              Raw Data
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPage('system')}>
              <Settings />
              System diagnostics
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              <span className="menu-status">
                <span className={`status-dot ${snapshot.connection.state}`} />
                {snapshot.connection.state} · {since(snapshot.connection.age_seconds)}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export function connectionMessage(state: 'starting' | 'live' | 'stale' | 'offline'): string | null {
  if (state === 'live') return null;
  if (state === 'stale')
    return 'Readings are more than 30 seconds old. Reconnecting automatically.';
  if (state === 'offline')
    return 'The inverter is currently unreachable. Your stored history is safe.';
  return 'The local collector is starting. Your stored history remains available.';
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [period, setPeriod] = useState<Period>('day');
  const [anchor, setAnchor] = useState(() => todayInTimeZone());
  const [trendRange, setTrendRange] = useState<TrendRange>('24h');
  const [commandHistoryRange, setCommandHistoryRange] = useState<CommandHistoryRange>('30d');
  const [wallMode, setWallMode] = useState(false);
  const reduceMotion = useReducedMotion();
  const {
    snapshot,
    history,
    summary,
    sensors,
    events,
    commandCenter,
    commandCenterLoading,
    preview,
    loading,
    nextRefreshAt,
    refreshSnapshot,
    refreshCommandCenter,
  } = useDashboard(period, anchor, trendRange, commandHistoryRange);
  const notifications = useDesktopNotifications(events);
  useEffect(() => {
    const update = () => setWallMode(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    if (!wallMode) return;
    const exitWithEscape = (event: KeyboardEvent) => {
      if (!isWallModeExitKey(event.key)) return;
      if (document.fullscreenElement) void document.exitFullscreen();
      setWallMode(false);
    };
    document.addEventListener('keydown', exitWithEscape);
    return () => document.removeEventListener('keydown', exitWithEscape);
  }, [wallMode]);
  const points = history?.points ?? [];
  if (!snapshot)
    return (
      <TooltipProvider delayDuration={300}>
        <div className="app-shell connection-shell">
          <ConnectionHeader />
          <main className="connection-main">
            <LoadingPage
              loading={loading}
              stage="collector"
              onRetry={() => void refreshSnapshot()}
            />
          </main>
        </div>
      </TooltipProvider>
    );

  const toggleWallMode = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setWallMode(false);
      return;
    }
    if (document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        // Wall layout still works when fullscreen is unavailable or denied.
      }
    }
    setWallMode(true);
    setPage('overview');
  };

  const detailHistory = { period, setPeriod, anchor, setAnchor, points };
  const sharedHistory = { ...detailHistory, summary };
  const content =
    page === 'overview' ? (
      commandCenter ? (
        <OverviewPage
          snapshot={snapshot}
          events={events}
          commandCenter={commandCenter}
          trendRange={trendRange}
          setTrendRange={setTrendRange}
          commandHistoryRange={commandHistoryRange}
          setCommandHistoryRange={setCommandHistoryRange}
          onNavigate={setPage}
          onViewAlerts={() => setPage('system')}
        />
      ) : (
        <LoadingPage
          loading={commandCenterLoading}
          stage="overview"
          onRetry={() => void refreshCommandCenter()}
        />
      )
    ) : page === 'history' ? (
      <HistoryPage {...sharedHistory} />
    ) : page === 'solar' ? (
      <SolarPage snapshot={snapshot} {...detailHistory} />
    ) : page === 'battery' ? (
      <BatteryPage snapshot={snapshot} {...detailHistory} />
    ) : page === 'grid' ? (
      <GridPage snapshot={snapshot} {...detailHistory} />
    ) : page === 'system' ? (
      <SystemPage snapshot={snapshot} events={events} />
    ) : (
      <RawPage sensors={sensors} />
    );

  return (
    <TooltipProvider delayDuration={300}>
      <div className={`app-shell ${wallMode ? 'wall-mode' : ''}`}>
        <DesktopHeader
          page={page}
          setPage={setPage}
          snapshot={snapshot}
          events={events}
          nextRefreshAt={nextRefreshAt}
          wallMode={wallMode}
          onToggleWallMode={() => void toggleWallMode()}
          notificationStatus={notifications.availability}
          onEnableNotifications={() => void notifications.enable()}
        />

        <main className="app-main">
          {preview && <Badge className="preview-pill">Preview data</Badge>}
          {connectionMessage(snapshot.connection.state) && (
            <div className={`alert ${snapshot.connection.state}`} role="status">
              <span className={`status-dot ${snapshot.connection.state}`} />
              <div>
                <strong>
                  {snapshot.connection.state === 'offline'
                    ? 'Live connection unavailable'
                    : 'Live readings delayed'}
                </strong>
                <span>{connectionMessage(snapshot.connection.state)}</span>
              </div>
              <RefreshCw aria-hidden="true" />
            </div>
          )}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={page}
              className="page"
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        </main>
        <MobileNavigation page={page} setPage={setPage} />
      </div>
    </TooltipProvider>
  );
}
