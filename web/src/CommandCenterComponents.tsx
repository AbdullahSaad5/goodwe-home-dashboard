import { useMemo, useState } from 'react';
import {
  Activity,
  BatteryCharging,
  BellRing,
  Clock3,
  CloudSun,
  Download,
  Gauge,
  Grid3X3,
  House,
  Maximize2,
  ShieldCheck,
  Sun,
  Table2,
  ThermometerSun,
  Zap,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { EnergyChart, Panel, ProjectionChart, StatCard } from './DashboardComponents';
import { formatDateTime, formatNumber, formatPower, formatTime } from './format';
import { useReportingTimeZone } from './reportingTimeZone';
import type {
  CommandCenterResponse,
  CommandHistoryRange,
  Page,
  Snapshot,
  TrendRange,
} from './types';

const healthSignalIcons: Record<string, React.ReactNode> = {
  grid: <Grid3X3 />,
  reserve: <BatteryCharging />,
  thermal: <ThermometerSun />,
  daylight: <CloudSun />,
  inverter: <ShieldCheck />,
};

function statusLabel(status: string, observed?: number | null, required?: number | null) {
  if (status === 'collecting' && observed != null && required != null)
    return `Collecting · ${observed}/${required}`;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function Readiness({ status, reason }: { status: string; reason: string }) {
  return (
    <div className={`readiness ${status}`}>
      <span>{statusLabel(status)}</span>
      <p>{reason}</p>
    </div>
  );
}

export function OperatingCommandBar({ data }: { data: CommandCenterResponse }) {
  return (
    <>
      <section className="command-banner" aria-labelledby="operating-mode-title">
        <div className="command-banner-icon">
          <Activity />
        </div>
        <div>
          <span>Current operating mode</span>
          <h1 id="operating-mode-title">{data.live.headline}</h1>
          <p>{data.live.explanation}</p>
        </div>
        <div className="command-banner-power">
          <span>Dominant supply</span>
          <strong>{formatPower(data.live.dominant_power_w)}</strong>
          <small>Live now</small>
        </div>
      </section>
      <div className="health-strip" aria-label="Live system health signals">
        {data.health.map((signal) => (
          <article className={`health-signal ${signal.status}`} key={signal.id}>
            <span className="health-signal-icon">
              {healthSignalIcons[signal.id] ?? <Gauge />}
              <i className="status-dot" />
            </span>
            <div className="health-signal-copy">
              <strong>{signal.label}</strong>
              <span>{signal.value}</span>
              <small>{signal.detail}</small>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

export function EnergyMixPanel({ data }: { data: CommandCenterResponse }) {
  const mix = data.live.energy_mix;
  return (
    <Panel title="Home energy mix" eyebrow="Instantaneous supply" className="energy-mix-panel">
      <div
        className="mix-ring"
        style={{
          background: `conic-gradient(var(--solar) 0 ${mix.solar_pct}%, var(--battery) ${mix.solar_pct}% ${mix.solar_pct + mix.battery_pct}%, var(--grid) ${mix.solar_pct + mix.battery_pct}% ${mix.solar_pct + mix.battery_pct + mix.grid_pct}%, var(--subtle) ${mix.solar_pct + mix.battery_pct + mix.grid_pct}% 100%)`,
        }}
      >
        <div>
          <strong>{formatNumber(mix.solar_pct, 0)}%</strong>
          <span>solar share</span>
        </div>
      </div>
      <div className="mix-list">
        {[
          ['solar', 'Solar PV', mix.solar_w, mix.solar_pct],
          ['battery', 'Battery', mix.battery_w, mix.battery_pct],
          ['grid', 'Grid', mix.grid_w, mix.grid_pct],
          ['unaccounted', 'Meter variance', mix.unaccounted_w, mix.unaccounted_pct],
        ].map(([tone, label, watts, percent]) => (
          <div className={`mix-row ${tone}`} key={String(tone)}>
            <i />
            <span>{label}</span>
            <small>{formatPower(Number(watts))}</small>
            <strong>{formatNumber(Number(percent), 0)}%</strong>
          </div>
        ))}
      </div>
      <p className="panel-note">{data.live.explanation}</p>
    </Panel>
  );
}

const trendRanges: TrendRange[] = ['15m', '1h', '3h', '6h', '12h', '24h'];

export function PowerTrendsPanel({
  data,
  range,
  setRange,
  initialView = 'chart',
}: {
  data: CommandCenterResponse;
  range: TrendRange;
  setRange: (range: TrendRange) => void;
  initialView?: 'chart' | 'table';
}) {
  const timeZone = useReportingTimeZone();
  const [table, setTable] = useState(initialView === 'table');
  return (
    <Panel
      title="Power trends"
      eyebrow={`${data.trend.resolution} samples`}
      className="feature-panel command-trends"
      action={
        <div className="command-chart-actions">
          <div className="segmented compact" aria-label="Power trend range">
            {trendRanges.map((item) => (
              <button
                type="button"
                key={item}
                className={range === item ? 'active' : ''}
                onClick={() => setRange(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="table-toggle"
            onClick={() => setTable((value) => !value)}
          >
            <Table2 /> {table ? 'Chart' : 'Table'}
          </button>
        </div>
      }
    >
      {table ? (
        <div className="trend-table-wrap">
          <table className="trend-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Solar</th>
                <th>Load</th>
                <th>Battery</th>
                <th>Grid</th>
                <th>SOC</th>
              </tr>
            </thead>
            <tbody>
              {data.trend.points.slice(-120).map((point) => (
                <tr key={point.timestamp}>
                  <td>{formatTime(point.timestamp, timeZone)}</td>
                  <td>{formatPower(point.pv_w)}</td>
                  <td>{formatPower(point.home_w)}</td>
                  <td>{formatPower(point.battery_w, true)}</td>
                  <td>{formatPower(point.grid_w, true)}</td>
                  <td>{formatNumber(point.battery_soc_pct, 0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EnergyChart
          key={`power-trends:${range}`}
          points={data.trend.points}
          outages={data.trend.outages}
          showSoc
          height={390}
        />
      )}
    </Panel>
  );
}

export function ProjectionPanel({ data }: { data: CommandCenterResponse }) {
  const timeZone = useReportingTimeZone();
  const points = useMemo(() => data.projection.points, [data.projection.points]);
  return (
    <Panel
      title="Next 24 hours"
      eyebrow="Conservative outage-reserve model"
      className="feature-panel"
    >
      {data.projection.status === 'ready' ? (
        <>
          <div className="insight-callouts">
            <StatCard
              label="Lowest SOC"
              value={formatNumber(data.projection.lowest_soc_pct, 0)}
              unit="%"
              tone="battery"
            />
            <StatCard
              label="Expected at"
              value={formatTime(data.projection.lowest_soc_at, timeZone)}
            />
            <StatCard label="Reserve policy" value="Protected" tone="battery" />
          </div>
          <ProjectionChart points={points} height={330} />
        </>
      ) : (
        <Readiness status={data.projection.status} reason={data.projection.reason} />
      )}
    </Panel>
  );
}

const historyRanges: CommandHistoryRange[] = ['14d', '30d', '60d', '12m'];

export function DailyHistoryPanel({
  data,
  historyRange,
  setHistoryRange,
  onNavigate,
}: {
  data: CommandCenterResponse;
  historyRange: CommandHistoryRange;
  setHistoryRange: (range: CommandHistoryRange) => void;
  onNavigate: (page: Page) => void;
}) {
  const maximum = Math.max(
    1,
    ...data.daily_history.flatMap((point) => [point.energy.solar_kwh, point.energy.load_kwh]),
  );
  return (
    <Panel
      title="Daily history"
      eyebrow={`${data.daily_history.length} recorded periods`}
      className="feature-panel daily-history-panel"
      action={
        <div className="command-chart-actions">
          <div className="segmented compact" aria-label="Daily history range">
            {historyRanges.map((item) => (
              <button
                type="button"
                key={item}
                className={historyRange === item ? 'active' : ''}
                onClick={() => setHistoryRange(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href="/api/v1/export.csv?dataset=daily&period=month"
          >
            <Download /> CSV
          </a>
        </div>
      }
    >
      <div
        className="daily-bars"
        role="img"
        aria-label="Daily solar production and home consumption"
      >
        {data.daily_history.map((point) => (
          <button
            type="button"
            key={point.day}
            className="daily-bar-day"
            onClick={() => onNavigate('history')}
            title={`${point.day}: solar ${formatNumber(point.energy.solar_kwh)} kWh, load ${formatNumber(point.energy.load_kwh)} kWh`}
          >
            <span className="bar-pair">
              <i
                className="solar"
                style={{ height: `${(point.energy.solar_kwh / maximum) * 100}%` }}
              />
              <i
                className="home"
                style={{ height: `${(point.energy.load_kwh / maximum) * 100}%` }}
              />
            </span>
            <small>{point.day.slice(5)}</small>
          </button>
        ))}
      </div>
      <div className="lifetime-grid period-total-grid">
        <StatCard
          label="Period PV"
          value={formatNumber(data.period_totals.solar_kwh, 0)}
          unit="kWh"
          tone="solar"
        />
        <StatCard
          label="Period consumption"
          value={formatNumber(data.period_totals.load_kwh, 0)}
          unit="kWh"
          tone="home"
        />
        <StatCard
          label="Period import"
          value={formatNumber(data.period_totals.import_kwh, 0)}
          unit="kWh"
          tone="grid"
        />
        <StatCard
          label="Period export"
          value={formatNumber(data.period_totals.export_kwh, 0)}
          unit="kWh"
          tone="battery"
        />
      </div>
      <div className="lifetime-grid">
        <StatCard
          label="Lifetime PV"
          value={formatNumber(data.lifetime.solar_kwh, 0)}
          unit="kWh"
          tone="solar"
        />
        <StatCard
          label="Lifetime consumption"
          value={formatNumber(data.lifetime.load_kwh, 0)}
          unit="kWh"
          tone="home"
        />
        <StatCard
          label="Lifetime import"
          value={formatNumber(data.lifetime.import_kwh, 0)}
          unit="kWh"
          tone="grid"
        />
        <StatCard
          label="Lifetime export"
          value={formatNumber(data.lifetime.export_kwh, 0)}
          unit="kWh"
          tone="battery"
        />
      </div>
      {data.records.length > 0 && (
        <div className="records-grid">
          {data.records.map((record) => (
            <article key={record.id}>
              <span>{record.label}</span>
              <strong>
                {formatNumber(record.value)} {record.unit}
              </strong>
              <small>{record.day}</small>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function OutageLogPanel({
  data,
  onNavigate,
}: {
  data: CommandCenterResponse;
  onNavigate: (page: Page) => void;
}) {
  const timeZone = useReportingTimeZone();
  return (
    <Panel
      title="Grid outage log"
      eyebrow={`${data.outages.length} most recent`}
      className="feature-panel"
    >
      {data.outages.length ? (
        <div className="trend-table-wrap">
          <table className="trend-table outage-table">
            <thead>
              <tr>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
                <th>Battery SOC</th>
              </tr>
            </thead>
            <tbody>
              {data.outages.map((outage) => (
                <tr key={outage.id}>
                  <td>{formatDateTime(outage.start_at, timeZone)}</td>
                  <td>{outage.ongoing ? 'Ongoing' : formatDateTime(outage.end_at, timeZone)}</td>
                  <td>
                    {outage.duration_seconds == null
                      ? '—'
                      : `${formatNumber(outage.duration_seconds / 60, 0)} min`}
                  </td>
                  <td>
                    {formatNumber(outage.start_soc_pct, 0)}% → {formatNumber(outage.end_soc_pct, 0)}
                    %
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Readiness
          status="collecting"
          reason="No confirmed grid-outage interval has been completed yet."
        />
      )}
      <button type="button" className="event-footer" onClick={() => onNavigate('grid')}>
        Open Grid & Loads <Grid3X3 />
      </button>
    </Panel>
  );
}

export function ForecastPanel({
  data,
  onNavigate,
}: {
  data: CommandCenterResponse;
  onNavigate: (page: Page) => void;
}) {
  return (
    <Panel
      title="Solar forecast"
      eyebrow={data.forecast.provider ?? 'Opt-in weather data'}
      className="feature-panel"
    >
      {data.forecast.status === 'ready' || data.forecast.status === 'stale' ? (
        <div className="forecast-grid">
          <article>
            <span>Today</span>
            <strong>{formatNumber(data.forecast.today_kwh)} kWh</strong>
            <small>{data.forecast.reason}</small>
          </article>
          <article>
            <span>Tomorrow</span>
            <strong>{formatNumber(data.forecast.tomorrow_kwh)} kWh</strong>
            <small>{data.forecast.calibration_days} calibration days</small>
          </article>
        </div>
      ) : (
        <Readiness status={data.forecast.status} reason={data.forecast.reason} />
      )}
      <p className="privacy-note">
        <CloudSun /> Coordinates are sent to Open-Meteo only when forecasting is configured;
        inverter telemetry remains local.
      </p>
      <button type="button" className="event-footer" onClick={() => onNavigate('solar')}>
        Open Solar <Sun />
      </button>
    </Panel>
  );
}

export function OutlookWatchdogGrid({
  data,
  onNavigate,
}: {
  data: CommandCenterResponse;
  onNavigate: (page: Page) => void;
}) {
  const timeZone = useReportingTimeZone();
  return (
    <div className="two-column command-two-column">
      <Panel
        title="Loadshedding outlook"
        eyebrow={`${data.outage_outlook.outage_count} confirmed outages`}
      >
        {data.outage_outlook.status === 'ready' ? (
          <>
            <div className="outage-heatmap">
              {data.outage_outlook.buckets.map((bucket) => (
                <i
                  key={bucket.minute_of_day}
                  style={{ opacity: 0.12 + bucket.probability_pct / 115 }}
                  title={`${Math.floor(bucket.minute_of_day / 60)
                    .toString()
                    .padStart(
                      2,
                      '0',
                    )}:${(bucket.minute_of_day % 60).toString().padStart(2, '0')} · ${formatNumber(bucket.probability_pct, 0)}%`}
                />
              ))}
            </div>
            <strong className="outlook-window">
              {formatDateTime(data.outage_outlook.next_window_start, timeZone)} –{' '}
              {formatTime(data.outage_outlook.next_window_end, timeZone)}
            </strong>
            <p className="panel-note">
              Typical duration {formatNumber(data.outage_outlook.typical_duration_minutes, 0)}{' '}
              minutes.
            </p>
          </>
        ) : (
          <Readiness status={data.outage_outlook.status} reason={data.outage_outlook.reason} />
        )}
      </Panel>
      <Panel title="System health watchdog" eyebrow={statusLabel(data.watchdog.status)}>
        <div className="watchdog-list">
          {data.watchdog.metrics.map((metric) => (
            <article key={metric.id} className={metric.status}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </article>
          ))}
        </div>
        <p className="panel-note">{data.watchdog.recommendation}</p>
        <button type="button" className="event-footer" onClick={() => onNavigate('system')}>
          Open System <ShieldCheck />
        </button>
      </Panel>
    </div>
  );
}

export function PerformanceSummaryGrid({
  data,
  snapshot,
}: {
  data: CommandCenterResponse;
  snapshot: Snapshot;
}) {
  const timeZone = useReportingTimeZone();
  const reserve = data.live.battery_reserve;
  return (
    <div className="performance-summary-grid">
      <Panel title="Thermal health" action={<ThermometerSun />}>
        <div className="thermal-readings">
          <article>
            <Gauge />
            <strong>{formatNumber(snapshot.system.temperature_radiator_c)}°</strong>
            <span>Inverter</span>
          </article>
          <article>
            <BatteryCharging />
            <strong>{formatNumber(snapshot.battery.temperature_c)}°</strong>
            <span>Battery / BMS</span>
          </article>
        </div>
      </Panel>
      <Panel title="Live performance" action={<Activity />}>
        <div className="mini-stat-grid">
          <StatCard
            label="Solar coverage"
            value={formatNumber(data.live.solar_coverage_pct, 0)}
            unit="%"
            tone="solar"
          />
          <StatCard
            label="Inverter utilisation"
            value={formatNumber(data.live.inverter_utilization_pct, 0)}
            unit="%"
          />
          <StatCard
            label="Power balance"
            value={data.live.power_balance === 'balanced' ? 'Balanced' : 'Check'}
            tone="battery"
          />
        </div>
      </Panel>
      <Panel title="Daily energy summary" action={<Zap />}>
        <div className="summary-counter-grid">
          {[
            ['PV production', data.today.energy.solar_kwh],
            ['Load usage', data.today.energy.load_kwh],
            ['Grid import', data.today.energy.import_kwh],
            ['Grid export', data.today.energy.export_kwh],
            ['Battery charged', data.today.energy.battery_charge_kwh],
            ['Battery discharged', data.today.energy.battery_discharge_kwh],
          ].map(([label, value]) => (
            <article key={String(label)}>
              <span>{label}</span>
              <strong>{formatNumber(Number(value))} kWh</strong>
            </article>
          ))}
        </div>
      </Panel>
      <Panel title="Battery reserve" action={<BatteryCharging />}>
        {reserve.status === 'ready' ? (
          <div className="reserve-layout">
            <strong>
              {formatNumber(reserve.available_kwh)}
              <small> kWh available</small>
            </strong>
            <div>
              <span>Current SOC {formatNumber(snapshot.battery.soc_pct, 0)}%</span>
              <span>Reserve margin {formatNumber(reserve.reserve_margin_pct, 0)}%</span>
              <span>
                Runtime{' '}
                {reserve.runtime_hours == null
                  ? 'Standby'
                  : `${formatNumber(reserve.runtime_hours)} h`}
              </span>
            </div>
          </div>
        ) : (
          <Readiness status={reserve.status} reason={reserve.reason} />
        )}
      </Panel>
      <Panel title="Today’s peaks" action={<Maximize2 />} className="peaks-panel">
        <div className="peaks-grid">
          {data.today.peaks.map((peak) => (
            <article key={peak.metric}>
              <span>{peak.metric.replaceAll('_', ' ')}</span>
              <strong>
                {formatNumber(peak.value)} {peak.unit}
              </strong>
              <small>{formatTime(peak.occurred_at, timeZone)}</small>
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function CommandCenterFooter({
  data,
  snapshot,
}: {
  data: CommandCenterResponse;
  snapshot: Snapshot;
}) {
  const timeZone = useReportingTimeZone();
  return (
    <div className="command-footer-strip">
      <span>
        <ShieldCheck /> Read-only
      </span>
      <span>
        <BatteryCharging /> {formatNumber(snapshot.battery.current_a)} A
      </span>
      <span>
        <Grid3X3 /> {formatNumber(snapshot.grid.frequency_hz, 2)} Hz
      </span>
      <span>
        <Sun /> {formatNumber(snapshot.solar.mppt1.voltage_v, 0)} /{' '}
        {formatNumber(snapshot.solar.mppt2.voltage_v, 0)} V
      </span>
      <span>
        <Clock3 /> {formatDateTime(data.generated_at, timeZone)}
      </span>
      <span>
        <BellRing /> {statusLabel(data.watchdog.status)}
      </span>
      <span>
        <House /> Local collector
      </span>
    </div>
  );
}
