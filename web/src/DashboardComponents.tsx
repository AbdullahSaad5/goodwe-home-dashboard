import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import * as echarts from 'echarts/core';
import { LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import type { HistoryPoint, Period, ProjectionPoint, Snapshot } from './types';
import { formatNumber, formatPower, formatTime } from './format';
import { readableAnchor, shiftAnchor, todayInTimeZone } from './period';
import { palette, type LiveMetric, type SolarUse } from './ui';

echarts.use([
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  AriaComponent,
  GraphicComponent,
  CanvasRenderer,
]);

export function animationDuration(reduceMotion: boolean | null, duration: number): number {
  return reduceMotion ? 0 : duration;
}

export function chartUpdateOptions() {
  return { notMerge: false, lazyUpdate: true, replaceMerge: ['series'] };
}

type ParsedReading = { numeric: number; digits: number; forcePlus: boolean; suffix: string };

function parseReading(value: string): ParsedReading | null {
  const match = value.trim().match(/^([+-]?)([\d,.]+)(.*)$/);
  if (!match || /\d/.test(match[3])) return null;
  const numeric = Number(`${match[1]}${match[2].replaceAll(',', '')}`);
  if (!Number.isFinite(numeric)) return null;
  return {
    numeric,
    digits: match[2].split('.')[1]?.length ?? 0,
    forcePlus: match[1] === '+',
    suffix: match[3],
  };
}

export function AnimatedReading({
  value,
  compactUnit = false,
}: {
  value: string;
  compactUnit?: boolean;
}) {
  const parsed = parseReading(value);
  const isParsed = parsed !== null;
  const reduceMotion = useReducedMotion();
  const target = parsed?.numeric ?? 0;
  const current = useRef(target);
  const frame = useRef<number | null>(null);
  const [displayed, setDisplayed] = useState(target);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!isParsed) return;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    const from = current.current;
    const to = target;
    if (from === to || reduceMotion) {
      current.current = to;
      setDisplayed(to);
      return;
    }
    setDirection(to > from ? 'up' : 'down');
    setRevision((value) => value + 1);
    let started: number | null = null;
    const duration = 520;
    const tick = (timestamp: number) => {
      started ??= timestamp;
      const progress = Math.max(0, Math.min(1, (timestamp - started) / duration));
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (to - from) * eased;
      current.current = next;
      setDisplayed(next);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
      else frame.current = null;
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [isParsed, target, reduceMotion]);

  if (!parsed) return <>{value}</>;
  const rendered = Math.abs(displayed).toLocaleString(undefined, {
    minimumFractionDigits: parsed.digits,
    maximumFractionDigits: parsed.digits,
  });
  const sign = displayed < 0 ? '−' : parsed.forcePlus ? '+' : '';
  return (
    <motion.span
      key={revision}
      className="animated-reading"
      initial={reduceMotion ? false : { opacity: 0.72, y: direction === 'up' ? 5 : -5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: 'easeOut' }}
    >
      {sign}
      {rendered}
      {parsed.suffix && (compactUnit ? <em>{parsed.suffix.trim()}</em> : parsed.suffix)}
    </motion.span>
  );
}

export function Panel({
  title,
  eyebrow,
  children,
  className = '',
  action,
}: {
  title: React.ReactNode;
  eyebrow?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className={`panel ${className}`}>
      <CardHeader className="panel-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        {action}
      </CardHeader>
      <CardContent className="panel-content">{children}</CardContent>
    </Card>
  );
}

export function MetricCard({ metric, icon: Icon }: { metric: LiveMetric; icon: LucideIcon }) {
  return (
    <Card className={`live-metric ${metric.tone}`}>
      <span className="metric-icon">
        <Icon aria-hidden="true" />
      </span>
      <div>
        <span className="metric-label">{metric.label}</span>
        <strong>
          <AnimatedReading value={metric.value} compactUnit />
        </strong>
        <small>{metric.detail}</small>
      </div>
    </Card>
  );
}

export function StatCard({
  label,
  value,
  unit,
  tone = 'neutral',
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'solar' | 'home' | 'battery' | 'grid' | 'neutral';
  note?: string;
}) {
  return (
    <Card className={`stat-card ${tone}`}>
      <span>{label}</span>
      <strong>
        <AnimatedReading value={`${value}${unit ? ` ${unit}` : ''}`} compactUnit />
      </strong>
      {note && <small>{note}</small>}
    </Card>
  );
}

export function Detail({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>
        <AnimatedReading value={value} />
        {note && <small>{note}</small>}
      </dd>
    </div>
  );
}

export function PeriodControl({
  period,
  setPeriod,
}: {
  period: Period;
  setPeriod: (period: Period) => void;
}) {
  return (
    <div className="segmented" aria-label="History period">
      {(['day', 'week', 'month', 'year'] as Period[]).map((item) => (
        <button
          key={item}
          type="button"
          className={period === item ? 'active' : ''}
          onClick={() => setPeriod(item)}
          aria-pressed={period === item}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export function HistoryControls({
  period,
  setPeriod,
  anchor,
  setAnchor,
}: {
  period: Period;
  setPeriod: (period: Period) => void;
  anchor: string;
  setAnchor: (anchor: string) => void;
}) {
  const next = shiftAnchor(anchor, period, 1);
  const nextDisabled = next > todayInTimeZone();
  return (
    <div className="history-controls">
      <label className="date-control">
        <CalendarDays aria-hidden="true" />
        <span className="date-readable">{readableAnchor(anchor)}</span>
        <input
          type="date"
          value={anchor}
          max={todayInTimeZone()}
          onChange={(event) => setAnchor(event.target.value)}
          aria-label="Chart anchor date"
        />
      </label>
      <Button
        variant="ghost"
        size="icon"
        className="date-arrow"
        onClick={() => setAnchor(shiftAnchor(anchor, period, -1))}
        aria-label={`Previous ${period}`}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="date-arrow"
        onClick={() => setAnchor(next)}
        disabled={nextDisabled}
        aria-label={`Next ${period}`}
      >
        <ChevronRight />
      </Button>
      <Select value={period} onValueChange={(value) => setPeriod(value as Period)}>
        <SelectTrigger className="period-select" aria-label="History period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(['day', 'week', 'month', 'year'] as Period[]).map((item) => (
            <SelectItem key={item} value={item}>
              {item[0].toUpperCase() + item.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  compact = false,
}: {
  title: string;
  detail?: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <Activity aria-hidden="true" />
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function EChart({
  option,
  height = 330,
  label,
}: {
  option: echarts.EChartsCoreOption;
  height?: number;
  label: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const chart = echarts.init(root.current);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(root.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    chartRef.current?.setOption(option, chartUpdateOptions());
  }, [option]);
  return <div ref={root} className="chart" style={{ height }} role="img" aria-label={label} />;
}

type ChartKind = 'all' | 'solar' | 'battery' | 'grid';
type SeriesDefinition = {
  key: keyof HistoryPoint;
  name: string;
  color: string;
  axis?: number;
  area?: boolean;
  dashed?: boolean;
};

function describeSignedSeries(name: string, value: number): string {
  if (name === 'Battery') return value < 0 ? 'charging' : value > 0 ? 'discharging' : 'idle';
  if (name === 'Grid') return value < 0 ? 'importing' : value > 0 ? 'exporting' : 'idle';
  return '';
}

export function EnergyChart({
  points,
  kind = 'all',
  height = 340,
  outages = [],
  showSoc = false,
}: {
  points: HistoryPoint[];
  kind?: ChartKind;
  height?: number;
  outages?: Array<{ start: string; end: string | null }>;
  showSoc?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const definitions: SeriesDefinition[] =
    kind === 'solar'
      ? [{ key: 'pv_w', name: 'Solar', color: palette.solar, area: true }]
      : kind === 'battery'
        ? [
            { key: 'battery_w', name: 'Battery', color: palette.battery, area: true },
            { key: 'battery_soc_pct', name: 'SOC', color: palette.soc, axis: 1, dashed: true },
          ]
        : kind === 'grid'
          ? [
              { key: 'home_w', name: 'Load', color: palette.home },
              { key: 'grid_w', name: 'Grid', color: palette.grid, area: true },
              { key: 'backup_w', name: 'Backup', color: palette.backup, dashed: true },
            ]
          : [
              { key: 'pv_w', name: 'Solar', color: palette.solar, area: true },
              { key: 'home_w', name: 'Load', color: palette.home },
              { key: 'battery_w', name: 'Battery', color: palette.battery },
              { key: 'grid_w', name: 'Grid', color: palette.grid },
              ...(showSoc
                ? ([
                    {
                      key: 'battery_soc_pct',
                      name: 'SOC',
                      color: palette.soc,
                      axis: 1,
                      dashed: true,
                    },
                  ] satisfies SeriesDefinition[])
                : []),
            ];
  if (!points.length)
    return (
      <EmptyState
        title="No history yet"
        detail="Charts appear after the collector stores its first readings."
      />
    );

  const option: echarts.EChartsCoreOption = {
    animation: !reduceMotion,
    animationDuration: animationDuration(reduceMotion, 320),
    aria: { enabled: true, decal: { show: false } },
    color: definitions.map((item) => item.color),
    grid: { top: 18, right: kind === 'battery' ? 50 : 18, bottom: 42, left: 52 },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#ffffff',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#172033', fontSize: 12 },
      extraCssText:
        'box-shadow:0 14px 34px rgba(15,23,42,.12);border-radius:12px;padding:12px 14px;',
      axisPointer: { type: 'line', lineStyle: { color: '#94a3b8', type: 'dashed' } },
      formatter: (raw: unknown) => {
        const params = raw as Array<{ seriesName: string; color: string; value: [number, number] }>;
        if (!params.length) return '';
        const rows = params
          .map((item) => {
            const value = Number(item.value[1]);
            const isSoc = item.seriesName === 'SOC';
            const direction = describeSignedSeries(item.seriesName, value);
            const rendered = isSoc
              ? `${formatNumber(value, 0)}%`
              : `${value > 0 && ['Battery', 'Grid'].includes(item.seriesName) ? '+' : ''}${formatNumber(value, 2)} kW`;
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><i style="width:8px;height:8px;border-radius:50%;background:${item.color}"></i><span style="min-width:55px;color:#64748b">${item.seriesName}</span><strong>${rendered}</strong>${direction ? `<small style="color:#94a3b8">${direction}</small>` : ''}</div>`;
          })
          .join('');
        return `<strong>${formatTime(new Date(params[0].value[0]).toISOString())}</strong>${rows}`;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#dfe5ed' } },
      axisTick: { show: false },
      axisLabel: { color: '#667085', fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: 'kW',
        nameTextStyle: { color: '#667085', align: 'right' },
        axisLabel: { color: '#667085', fontSize: 10, formatter: '{value} kW' },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: '#e8edf4', type: 'dashed' } },
      },
      {
        type: 'value',
        name: 'SOC',
        min: 0,
        max: 100,
        show: kind === 'battery' || showSoc,
        axisLabel: { color: '#667085', fontSize: 10, formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    series: definitions.map((item) => ({
      name: item.name,
      type: 'line',
      smooth: 0.24,
      showSymbol: false,
      yAxisIndex: item.axis ?? 0,
      lineStyle: {
        width: item.name === 'Solar' ? 2.3 : 1.9,
        type: item.dashed ? 'dashed' : 'solid',
      },
      areaStyle: item.area
        ? {
            opacity: 0.11,
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: item.color },
              { offset: 1, color: '#ffffff' },
            ]),
          }
        : undefined,
      markLine:
        item.name === definitions[0].name
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#cbd5e1', width: 1 },
              data: [{ yAxis: 0 }],
            }
          : undefined,
      markArea:
        item.name === definitions[0].name && outages.length
          ? {
              silent: true,
              itemStyle: { color: 'rgba(229, 72, 77, 0.09)' },
              data: outages.map((outage) => [
                { xAxis: outage.start },
                { xAxis: outage.end ?? points.at(-1)?.timestamp },
              ]),
            }
          : undefined,
      data: points.map((point) => [
        point.timestamp,
        item.key === 'battery_soc_pct' ? Number(point[item.key]) : Number(point[item.key]) / 1000,
      ]),
    })),
    dataZoom: points.length > 240 ? [{ type: 'inside', filterMode: 'none' }] : [],
  };
  return (
    <EChart
      option={option}
      height={height}
      label={`Interactive ${kind === 'all' ? 'solar, load, battery and grid' : kind} energy history chart`}
    />
  );
}

export function ProjectionChart({
  points,
  height = 330,
}: {
  points: ProjectionPoint[];
  height?: number;
}) {
  const reduceMotion = useReducedMotion();
  if (!points.length)
    return <EmptyState title="No projection yet" detail="Projection data is still collecting." />;
  const series = [
    { name: 'Solar', color: palette.solar, key: 'pv_w', axis: 0 },
    { name: 'Load', color: palette.home, key: 'load_w', axis: 0 },
    { name: 'SOC', color: palette.soc, key: 'soc_pct', axis: 1 },
  ] as const;
  const option: echarts.EChartsCoreOption = {
    animation: !reduceMotion,
    animationDuration: animationDuration(reduceMotion, 320),
    aria: { enabled: true, decal: { show: false } },
    color: series.map((item) => item.color),
    grid: { top: 18, right: 50, bottom: 42, left: 52 },
    legend: { show: false },
    tooltip: { trigger: 'axis', confine: true },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#dfe5ed' } },
      axisTick: { show: false },
      axisLabel: { color: '#667085', fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: 'kW',
        axisLabel: { color: '#667085', fontSize: 10, formatter: '{value} kW' },
        splitLine: { lineStyle: { color: '#e8edf4', type: 'dashed' } },
      },
      {
        type: 'value',
        name: 'SOC',
        min: 0,
        max: 100,
        axisLabel: { color: '#667085', fontSize: 10, formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    series: series.map((item) => ({
      name: item.name,
      type: 'line',
      smooth: 0.24,
      showSymbol: false,
      yAxisIndex: item.axis,
      lineStyle: { width: 2, type: item.name === 'SOC' ? 'dashed' : 'solid' },
      areaStyle: item.name === 'Solar' ? { opacity: 0.1 } : undefined,
      data: points.map((point) => [
        point.timestamp,
        item.axis === 1 ? point[item.key] : point[item.key] / 1000,
      ]),
    })),
  };
  return (
    <EChart
      option={option}
      height={height}
      label="Projected solar, household load, and battery state of charge"
    />
  );
}

function FlowNode({
  label,
  value,
  detail,
  icon,
  tone,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
  tone: string;
  className: string;
}) {
  const reading = value.match(/^(.+?)\s*(kW|W|%)$/);
  return (
    <div className={`flow-node ${tone} ${className}`}>
      <span className="flow-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="flow-copy">
        <span className="flow-label">{label}</span>
        <strong>{reading ? <AnimatedReading value={value} compactUnit /> : value}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </div>
  );
}

export function SolarFlowSymbol() {
  return (
    <svg
      className="flow-symbol"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 17.5h12l2.2 9H7.8l2.2-9Z" />
      <path d="M8.9 22h14.2M16 17.5v9M12 17.5l-1.1 9M20 17.5l1.1 9" />
      <path d="M12 29h8M16 3v3M8.9 6.1l2.2 2.2M23.1 6.1l-2.2 2.2M7 12h3M22 12h3M12 14a4 4 0 0 1 8 0" />
    </svg>
  );
}

export function BatteryFlowSymbol() {
  return (
    <svg
      className="flow-symbol"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 5V3h6v2" />
      <rect x="10" y="5" width="12" height="23" rx="2.4" />
      <path d="m17.5 9-4.2 8h3.4l-2.2 6 4.4-8h-3.4l2-6Z" />
    </svg>
  );
}

export function HomeFlowSymbol() {
  return (
    <svg
      className="flow-symbol"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 15.5 11-9.5 11 9.5" />
      <path d="M8 14v12h16V14M13 26v-8h6v8" />
    </svg>
  );
}

function GridFlowSymbol() {
  return (
    <svg
      className="flow-symbol"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m16 3-8 26M16 3l8 26M10.5 12h11M8.8 18h14.4M7 24h18M10.5 12l12.7 6L7 24M21.5 12 8.8 18 25 24M12 29h8" />
      <path d="M3.5 8.5c1.7 1.5 2.8 3.2 3.2 5.3M28.5 8.5c-1.7 1.5-2.8 3.2-3.2 5.3" />
    </svg>
  );
}

function flowMotionStyle(watts: number): CSSProperties {
  const magnitude = Math.abs(watts);
  const duration =
    magnitude <= 20 ? 0 : Math.max(0.72, 2.35 - Math.min(magnitude, 6000) / 3700) * 1.55;
  return { '--flow-duration': `${duration}s` } as CSSProperties;
}

export function LiveFlowCard({ snapshot }: { snapshot: Snapshot }) {
  const live = snapshot.power;
  const solarActive = live.pv_w > 20;
  const batteryActive = Math.abs(live.battery_w) > 20;
  const gridActive = Math.abs(live.grid_w) > 20;
  return (
    <Panel
      title="Live Power Flow"
      className="live-flow-card"
      action={
        <span className={`system-state ${snapshot.system.health}`}>
          <i />
          System {snapshot.system.health}
        </span>
      }
    >
      <div
        className="power-flow"
        aria-label={`Solar ${formatPower(live.pv_w)}, home ${formatPower(live.home_w)}, battery ${live.battery_direction} ${formatPower(live.battery_w)}, grid ${live.grid_direction} ${formatPower(live.grid_w)}`}
      >
        <img src="/solar-home.png" alt="" className="flow-house" />
        <FlowNode
          label="Solar"
          value={formatPower(live.pv_w)}
          icon={<SolarFlowSymbol />}
          tone="solar"
          className="flow-solar"
        />
        <FlowNode
          label="Battery"
          value={`${formatNumber(live.battery_soc_pct, 0)}%`}
          icon={<BatteryFlowSymbol />}
          tone="battery"
          className="flow-battery"
        />
        <FlowNode
          label="Home"
          value={formatPower(live.home_w)}
          icon={<HomeFlowSymbol />}
          tone="home"
          className="flow-home"
        />
        <FlowNode
          label="Grid"
          value={formatPower(live.grid_w)}
          detail={
            live.grid_direction === 'import'
              ? 'Importing'
              : live.grid_direction === 'export'
                ? 'Exporting'
                : 'Idle'
          }
          icon={<GridFlowSymbol />}
          tone="grid"
          className="flow-grid"
        />
        <div
          className={`flow-line solar-line ${solarActive ? 'active' : 'idle'}`}
          style={flowMotionStyle(live.pv_w)}
        >
          <i className="flow-arrow" />
        </div>
        <div
          className={`flow-line battery-line ${batteryActive ? `active ${live.battery_direction}` : 'idle'}`}
          style={flowMotionStyle(live.battery_w)}
        >
          <i className="flow-arrow" />
        </div>
        <div
          className={`flow-line grid-line ${gridActive ? `active ${live.grid_direction}` : 'idle'}`}
          style={flowMotionStyle(live.grid_w)}
        >
          <i className="flow-arrow" />
        </div>
      </div>
    </Panel>
  );
}

export function SolarUseChart({ data }: { data: SolarUse }) {
  const reduceMotion = useReducedMotion();
  if (data.retainedPct == null || data.exportedPct == null)
    return (
      <EmptyState
        compact
        title="No solar generation"
        detail="Solar-use estimates appear once generation is recorded."
      />
    );
  const option: echarts.EChartsCoreOption = {
    animation: !reduceMotion,
    animationDuration: animationDuration(reduceMotion, 300),
    tooltip: { trigger: 'item', valueFormatter: (value: number) => `${formatNumber(value)}%` },
    series: [
      {
        type: 'pie',
        radius: ['62%', '84%'],
        center: ['50%', '48%'],
        label: { show: false },
        itemStyle: { borderColor: '#fff', borderWidth: 3, borderRadius: 5 },
        data: [
          { name: 'Kept at home', value: data.retainedPct, itemStyle: { color: palette.battery } },
          { name: 'Exported', value: data.exportedPct, itemStyle: { color: palette.solar } },
        ],
      },
    ],
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '39%',
        style: {
          text: `${formatNumber(data.retainedPct, 0)}%`,
          fill: '#172033',
          fontSize: 27,
          fontWeight: 650,
        },
      },
      {
        type: 'text',
        left: 'center',
        top: '56%',
        style: { text: 'retained', fill: '#667085', fontSize: 10 },
      },
    ],
  };
  return (
    <EChart
      option={option}
      height={174}
      label={`${formatNumber(data.retainedPct, 0)} percent of solar energy retained at home`}
    />
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search">
      <Search aria-hidden="true" />
      <span className="sr-only">Search sensors</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
