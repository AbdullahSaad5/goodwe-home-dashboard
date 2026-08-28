import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  BatteryCharging,
  Bell,
  ChevronDown,
  Database,
  Grid3X3,
  History,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Settings,
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
import type { EventItem, Page, Period, Snapshot } from './types';
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

function Brand() {
  return (
    <div className="brand" aria-label="GoodWe Home">
      <strong className="goodwe-wordmark">GOODWE</strong>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-name">GoodWe Home</span>
    </div>
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

export function DesktopHeader({
  page,
  setPage,
  snapshot,
  events,
  nextRefreshAt,
}: {
  page: Page;
  setPage: (page: Page) => void;
  snapshot: Snapshot;
  events: EventItem[];
  nextRefreshAt: number;
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
        <RefreshPill nextRefreshAt={nextRefreshAt} connectionState={snapshot.connection.state} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="header-icon"
              onClick={() => setPage('system')}
              aria-label="Open alerts"
            >
              <Bell />
              <span className="event-count">{eventCount}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Alerts and events</TooltipContent>
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
  const reduceMotion = useReducedMotion();
  const {
    snapshot,
    history,
    summary,
    comparisonSummary,
    sensors,
    events,
    preview,
    loading,
    nextRefreshAt,
  } = useDashboard(period, anchor);
  const points = history?.points ?? [];
  if (!snapshot) return <LoadingPage loading={loading} />;

  const sharedHistory = { period, setPeriod, anchor, setAnchor, points, summary };
  const content =
    page === 'overview' ? (
      <OverviewPage
        snapshot={snapshot}
        events={events}
        comparisonSummary={comparisonSummary}
        onViewAlerts={() => setPage('system')}
        {...sharedHistory}
      />
    ) : page === 'history' ? (
      <HistoryPage {...sharedHistory} />
    ) : page === 'solar' ? (
      <SolarPage snapshot={snapshot} points={points} />
    ) : page === 'battery' ? (
      <BatteryPage snapshot={snapshot} points={points} />
    ) : page === 'grid' ? (
      <GridPage snapshot={snapshot} points={points} />
    ) : page === 'system' ? (
      <SystemPage snapshot={snapshot} events={events} />
    ) : (
      <RawPage sensors={sensors} />
    );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-shell">
        <DesktopHeader
          page={page}
          setPage={setPage}
          snapshot={snapshot}
          events={events}
          nextRefreshAt={nextRefreshAt}
        />

        <main className="app-main">
          {preview && <Badge className="preview-pill">Preview data</Badge>}
          {connectionMessage(snapshot.connection.state) && (
            <div className={`alert ${snapshot.connection.state}`}>
              <span className="status-dot" />
              {connectionMessage(snapshot.connection.state)}
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
