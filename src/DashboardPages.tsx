import { useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, BatteryCharging, Bell, ChevronRight, CircleCheck, Database, Download,
  Gauge, Grid3X3, HeartPulse, Info, Leaf, Radio, Server, ShieldCheck, Sun,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  AnimatedReading, BatteryFlowSymbol, Detail, EmptyState, EnergyChart, HistoryControls, HomeFlowSymbol,
  LiveFlowCard, Panel, SearchField, SolarFlowSymbol, StatCard,
} from './DashboardComponents';
import { formatDateTime, formatNumber, formatPower, periodLabel } from './format';
import type { EventItem, HistoryPoint, Period, SensorReading, Snapshot, Summary } from './types';
import { comparisonPercent } from './ui';

function PageIntro({ eyebrow, title, description, hero }: { eyebrow: string; title: string; description: string; hero?: React.ReactNode }) {
  return <div className="page-intro"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{hero}</div>;
}

function HealthBadge({ health }: { health: Snapshot['system']['health'] }) {
  return <Badge className={`health-badge ${health}`}><HeartPulse aria-hidden="true" />{health}</Badge>;
}

function EventList({ events, limit }: { events: EventItem[]; limit?: number }) {
  const visible = limit ? events.slice(0, limit) : events;
  if (!visible.length) return <EmptyState compact title="No events recorded" detail="Collector and inverter events will appear here." />;
  return <div className="event-list">{visible.map((event) => <article className={`event ${event.severity}`} key={event.id}>
    <span className="event-icon">{event.severity === 'error' ? <AlertTriangle /> : event.severity === 'warning' ? <Info /> : <CircleCheck />}</span>
    <div><strong>{event.message}</strong><small>{event.event_type}</small></div><time>{formatDateTime(event.created_at)}</time>
  </article>)}</div>;
}

function Comparison({ value, inverse = false, reference }: { value: number | null; inverse?: boolean; reference: string }) {
  if (value == null) return null;
  const positive = value >= 0;
  const desirable = inverse ? !positive : positive;
  return <span className={`comparison ${desirable ? 'positive' : 'negative'}`}>{positive ? '▲' : '▼'} {formatNumber(Math.abs(value), 0)}% vs {reference}</span>;
}

function DailyCard({ title, value, unit, subtitle, tone, icon, comparison, comparisonInverse, comparisonReference, leftLabel, leftValue, rightLabel, rightValue }: {
  title: string; value: string; unit?: string; subtitle: string; tone: string; icon: React.ReactNode; comparison?: number | null; comparisonInverse?: boolean; comparisonReference: string; leftLabel: string; leftValue: string; rightLabel: string; rightValue: string;
}) {
  return <Card className={`daily-card ${tone}`}>
    <div className="daily-card-main"><span className="daily-icon">{icon}</span><div><span className="daily-title">{title}</span><div className="daily-value"><AnimatedReading value={`${value}${unit ? ` ${unit}` : ''}`} compactUnit /></div><p>{subtitle}</p><Comparison value={comparison ?? null} inverse={comparisonInverse} reference={comparisonReference} /></div></div>
    <Separator />
    <dl className="daily-details"><Detail label={leftLabel} value={leftValue} /><Detail label={rightLabel} value={rightValue} /></dl>
  </Card>;
}

function MpptPanel({ snapshot }: { snapshot: Snapshot }) {
  return <Panel title="MPPT Details" className="operational-card mppt-card">
    <div className="mppt-list">{[snapshot.solar.mppt1, snapshot.solar.mppt2].map((mppt, index) => <div className="mppt-item" key={index}><strong>MPPT {index + 1}</strong><Detail label="Voltage" value={`${formatNumber(mppt.voltage_v)} V`} /><Detail label="Current" value={`${formatNumber(mppt.current_a)} A`} /><Detail label="Power" value={formatPower(mppt.power_w)} /></div>)}</div>
    <div className="card-summary"><span>Total power</span><strong><AnimatedReading value={formatPower(snapshot.solar.total_power_w)} /></strong></div>
  </Panel>;
}

function BatteryStatusPanel({ snapshot }: { snapshot: Snapshot }) {
  const battery = snapshot.battery;
  return <Panel title={<span className="operational-title"><span className="title-icon battery"><BatteryCharging /></span>Battery Status</span>} className="operational-card battery-status-card">
    <dl className="status-list"><Detail label="Temperature" value={`${formatNumber(battery.temperature_c)} °C`} /><Detail label="Health" value={snapshot.insights.cell_balance} /><Detail label="Cell spread" value={`${formatNumber(battery.cell_voltage_spread_mv, 0)} mV`} /><Detail label="Voltage" value={`${formatNumber(battery.voltage_v)} V`} /><Detail label="Current" value={`${formatNumber(battery.current_a)} A`} /></dl>
    <p className="panel-note"><CircleCheck />{battery.warning || battery.error || 'No issues detected'}</p>
  </Panel>;
}

function GridQualityPanel({ snapshot }: { snapshot: Snapshot }) {
  const grid = snapshot.grid;
  return <Panel title={<span className="operational-title"><span className="title-icon grid"><Gauge /></span>Grid Quality</span>} className="operational-card">
    <dl className="status-list"><Detail label="Voltage" value={`${formatNumber(grid.voltage_v)} V`} /><Detail label="Frequency" value={`${formatNumber(grid.frequency_hz, 2)} Hz`} /><Detail label="Reactive power" value={`${formatNumber(grid.reactive_var, 0)} var`} /><Detail label="Apparent power" value={`${formatNumber(grid.apparent_va, 0)} VA`} /><Detail label="Meter link" value={grid.meter_communicating ? 'Communicating' : 'Unavailable'} /></dl>
    <p className="panel-note"><CircleCheck />{grid.meter_communicating ? 'Grid conditions are being monitored' : 'Meter data is unavailable'}</p>
  </Panel>;
}

export function OverviewPage({ snapshot, points, summary, comparisonSummary, events, period, setPeriod, anchor, setAnchor, onViewAlerts }: {
  snapshot: Snapshot; points: HistoryPoint[]; summary: Summary | null; comparisonSummary: Summary | null; events: EventItem[]; period: Period; setPeriod: (period: Period) => void; anchor: string; setAnchor: (anchor: string) => void; onViewAlerts: () => void;
}) {
  const energy = summary?.energy;
  const previous = comparisonSummary?.energy;
  const comparisonReference = period === 'day' ? 'yesterday' : `previous ${period}`;
  return <>
    <h1 className="sr-only">GoodWe Home energy overview</h1>
    <div className="overview-hero-grid">
      <LiveFlowCard snapshot={snapshot} />
      <Panel title={`Energy Flow ${period === 'day' ? 'Today' : periodLabel(period)}`} className="overview-chart-card" action={<HistoryControls period={period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor} />}>
        <div className="chart-legend"><span className="solar"><i />Solar (kW)</span><span className="home"><i />Load (kW)</span><span className="battery"><i />Battery (kW)</span><span className="grid"><i />Grid (kW)</span></div>
        <EnergyChart points={points} height={287} />
      </Panel>
    </div>

    <div className="daily-grid">
      <DailyCard title={`Solar ${periodLabel(period)}`} value={formatNumber(energy?.solar_kwh)} unit="kWh" subtitle="Energy Produced" tone="solar" icon={<SolarFlowSymbol />} comparison={comparisonPercent(energy?.solar_kwh, previous?.solar_kwh)} comparisonReference={comparisonReference} leftLabel="Peak Power" leftValue={formatPower(summary?.peak_pv_w)} rightLabel="Exported" rightValue={`${formatNumber(energy?.export_kwh)} kWh`} />
      <DailyCard title={`Consumption ${periodLabel(period)}`} value={formatNumber(energy?.load_kwh)} unit="kWh" subtitle="Energy Consumed" tone="home" icon={<HomeFlowSymbol />} comparison={comparisonPercent(energy?.load_kwh, previous?.load_kwh)} comparisonInverse comparisonReference={comparisonReference} leftLabel="Current Load" leftValue={formatPower(snapshot.power.home_w)} rightLabel="Peak Power" rightValue={formatPower(summary?.peak_home_w)} />
      <DailyCard title="Grid Independence" value={formatNumber(summary?.grid_independence_pct, 0)} unit="%" subtitle="Self-Sufficiency" tone="battery" icon={<Leaf />} comparison={comparisonPercent(summary?.grid_independence_pct, comparisonSummary?.grid_independence_pct)} comparisonReference={comparisonReference} leftLabel="Imported" leftValue={`${formatNumber(energy?.import_kwh)} kWh`} rightLabel="Exported" rightValue={`${formatNumber(energy?.export_kwh)} kWh`} />
      <DailyCard title="Battery SOC" value={formatNumber(snapshot.battery.soc_pct, 0)} unit="%" subtitle="State of Charge" tone="battery" icon={<BatteryFlowSymbol />} comparisonReference={comparisonReference} leftLabel="Temperature" leftValue={`${formatNumber(snapshot.battery.temperature_c)} °C`} rightLabel="Power" rightValue={formatPower(snapshot.power.battery_w, true)} />
    </div>

    <div className="operations-grid">
      <MpptPanel snapshot={snapshot} />
      <BatteryStatusPanel snapshot={snapshot} />
      <GridQualityPanel snapshot={snapshot} />
      <Panel title={<span className="operational-title"><span className="title-icon notification"><Bell /></span>Alerts & Notifications</span>} className="operational-card event-card"><EventList events={events} limit={3} /><button type="button" className="event-footer" onClick={onViewAlerts}>View all alerts<ChevronRight /></button></Panel>
    </div>
  </>;
}

export function HistoryPage({ period, setPeriod, anchor, setAnchor, points, summary }: { period: Period; setPeriod: (period: Period) => void; anchor: string; setAnchor: (anchor: string) => void; points: HistoryPoint[]; summary: Summary | null }) {
  return <>
    <PageIntro eyebrow="Explore" title="Energy history" description="Synchronized solar, load, battery and grid data across calendar periods." hero={<HistoryControls period={period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor} />} />
    <Panel title="Generation, demand and exchange" eyebrow={periodLabel(period)} className="feature-panel" action={<a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={`/api/v1/export.csv?period=${period}&anchor=${anchor}`}><Download />CSV</a>}><EnergyChart points={points} height={420} /></Panel>
    <div className="stat-grid"><StatCard label="Generated" value={formatNumber(summary?.energy.solar_kwh)} unit="kWh" tone="solar" /><StatCard label="Consumed" value={formatNumber(summary?.energy.load_kwh)} unit="kWh" tone="home" /><StatCard label="Imported" value={formatNumber(summary?.energy.import_kwh)} unit="kWh" tone="grid" /><StatCard label="Exported" value={formatNumber(summary?.energy.export_kwh)} unit="kWh" tone="battery" /></div>
    <div className="stat-grid"><StatCard label="Peak solar" value={formatPower(summary?.peak_pv_w)} tone="solar" /><StatCard label="Peak home" value={formatPower(summary?.peak_home_w)} tone="home" /><StatCard label="Grid independence" value={formatNumber(summary?.grid_independence_pct)} unit="%" tone="battery" /><StatCard label="Availability" value={formatNumber(summary?.availability_pct)} unit="%" /></div>
  </>;
}

export function SolarPage({ snapshot, points }: { snapshot: Snapshot; points: HistoryPoint[] }) {
  return <><PageIntro eyebrow="Generation" title="Solar array" description="Live array output, MPPT operating details and local production history." hero={<div className="hero-reading solar"><Sun />{formatPower(snapshot.solar.total_power_w)}</div>} /><div className="stat-grid"><StatCard label="Generated today" value={formatNumber(snapshot.solar.today_kwh)} unit="kWh" tone="solar" /><StatCard label="Lifetime yield" value={formatNumber(snapshot.solar.lifetime_kwh)} unit="kWh" tone="solar" /><StatCard label="Operating time" value={formatNumber(snapshot.solar.operating_hours, 0)} unit="hours" /><StatCard label="Current output" value={formatPower(snapshot.solar.total_power_w)} tone="solar" /></div><Panel title="Solar generation" eyebrow="Selected period" className="feature-panel"><EnergyChart points={points} kind="solar" height={380} /></Panel><div className="two-column">{[snapshot.solar.mppt1, snapshot.solar.mppt2].map((mppt, index) => <Panel key={index} title={`MPPT ${index + 1}`} eyebrow={mppt.mode}><dl className="details-grid"><Detail label="Voltage" value={`${formatNumber(mppt.voltage_v)} V`} /><Detail label="Current" value={`${formatNumber(mppt.current_a)} A`} /><Detail label="Power" value={formatPower(mppt.power_w)} /></dl></Panel>)}</div></>;
}

export function BatteryPage({ snapshot, points }: { snapshot: Snapshot; points: HistoryPoint[] }) {
  const battery = snapshot.battery;
  return <><PageIntro eyebrow="Storage" title="Battery health" description="Charge state, BMS limits, temperature and cell-balance indicators." hero={<div className="hero-reading battery"><BatteryCharging />{formatNumber(battery.soc_pct, 0)}%</div>} /><div className="stat-grid"><StatCard label="State of charge" value={formatNumber(battery.soc_pct, 0)} unit="%" tone="battery" /><StatCard label="State of health" value={formatNumber(battery.soh_pct, 0)} unit="%" tone="battery" /><StatCard label="Battery power" value={formatPower(battery.power_w, true)} note={snapshot.power.battery_direction} /><StatCard label="Temperature" value={formatNumber(battery.temperature_c)} unit="°C" /></div><Panel title="Power and state of charge" eyebrow="Battery history" className="feature-panel"><EnergyChart points={points} kind="battery" height={380} /></Panel><div className="two-column"><Panel title="Electrical"><dl className="details-grid"><Detail label="Voltage" value={`${formatNumber(battery.voltage_v)} V`} /><Detail label="Current" value={`${formatNumber(battery.current_a)} A`} /><Detail label="Charge limit" value={`${formatNumber(battery.charge_limit_a)} A`} /><Detail label="Discharge limit" value={`${formatNumber(battery.discharge_limit_a)} A`} /><Detail label="Modules" value={formatNumber(battery.modules, 0)} /></dl></Panel><Panel title="Cells & BMS"><dl className="details-grid"><Detail label="Cell voltage range" value={`${formatNumber(battery.min_cell_voltage_v, 3)}–${formatNumber(battery.max_cell_voltage_v, 3)} V`} /><Detail label="Voltage spread" value={`${formatNumber(battery.cell_voltage_spread_mv, 0)} mV`} note={snapshot.insights.cell_balance} /><Detail label="Cell temperature" value={`${formatNumber(battery.min_cell_temperature_c)}–${formatNumber(battery.max_cell_temperature_c)} °C`} /><Detail label="Software" value={battery.software_version || '—'} /><Detail label="Hardware" value={battery.hardware_version || '—'} /></dl></Panel></div></>;
}

export function GridPage({ snapshot, points }: { snapshot: Snapshot; points: HistoryPoint[] }) {
  const grid = snapshot.grid;
  return <><PageIntro eyebrow="Grid & loads" title="Where power is going" description="Mains quality, household demand, backup output and utility exchange." hero={<div className="hero-reading grid"><Grid3X3 />{formatPower(snapshot.power.grid_w)}<small>{snapshot.power.grid_direction}</small></div>} /><div className="stat-grid"><StatCard label="Home load" value={formatPower(snapshot.power.home_w)} tone="home" /><StatCard label="Backup load" value={formatPower(snapshot.power.backup_w)} /><StatCard label="Grid exchange" value={formatPower(snapshot.power.grid_w, true)} note={snapshot.power.grid_direction} tone="grid" /><StatCard label="Inverter output" value={formatPower(grid.inverter_output_w)} /></div><Panel title="Load and grid exchange" eyebrow="Negative grid power is import" className="feature-panel"><EnergyChart points={points} kind="grid" height={380} /></Panel><div className="two-column"><Panel title="Mains quality"><dl className="details-grid"><Detail label="Voltage" value={`${formatNumber(grid.voltage_v)} V`} /><Detail label="Current" value={`${formatNumber(grid.current_a)} A`} /><Detail label="Frequency" value={`${formatNumber(grid.frequency_hz, 2)} Hz`} /><Detail label="Meter link" value={grid.meter_communicating ? 'Communicating' : 'Unavailable'} /><Detail label="Grid state" value={grid.grid_mode} /><Detail label="Exchange mode" value={grid.on_grid_mode} /></dl></Panel><Panel title="Power and energy"><dl className="details-grid"><Detail label="Active power" value={`${formatNumber(grid.meter_active_w, 0)} W`} /><Detail label="Reactive power" value={`${formatNumber(grid.reactive_var, 0)} var`} /><Detail label="Apparent power" value={`${formatNumber(grid.apparent_va, 0)} VA`} /><Detail label="Imported today" value={`${formatNumber(snapshot.today.import_kwh)} kWh`} /><Detail label="Exported today" value={`${formatNumber(snapshot.today.export_kwh)} kWh`} /><Detail label="Net export" value={`${formatNumber(snapshot.insights.net_grid_kwh)} kWh`} /></dl></Panel></div></>;
}

export function SystemPage({ snapshot, events }: { snapshot: Snapshot; events: EventItem[] }) {
  const system = snapshot.system;
  return <><PageIntro eyebrow="Diagnostics" title="System status" description="Read-only inverter health, temperatures, clocks, firmware and local collector events." hero={<HealthBadge health={system.health} />} /><div className="stat-grid"><StatCard label="Air temperature" value={formatNumber(system.temperature_air_c)} unit="°C" /><StatCard label="Module temperature" value={formatNumber(system.temperature_module_c)} unit="°C" /><StatCard label="Radiator temperature" value={formatNumber(system.temperature_radiator_c)} unit="°C" /><StatCard label="Clock drift" value={formatNumber(snapshot.connection.clock_drift_seconds, 0)} unit="seconds" /></div><div className="system-feature-grid"><Panel title="Inverter" action={<ShieldCheck />}><div className="system-overview-body"><img src="/solar-home.png" alt="" className="solar-home-art" /><dl className="details-grid"><Detail label="Model" value={snapshot.connection.display_model} /><Detail label="Protocol" value={snapshot.connection.protocol_model || '—'} /><Detail label="Firmware" value={snapshot.connection.firmware || '—'} /><Detail label="Work mode" value={system.work_mode} /></dl></div></Panel><Panel title="Connectivity" action={<Radio />}><dl className="details-grid"><Detail label="Connection" value={snapshot.connection.state} /><Detail label="Last reading" value={formatDateTime(snapshot.connection.last_updated)} /><Detail label="Inverter clock" value={formatDateTime(snapshot.connection.inverter_time)} /><Detail label="Meter link" value={snapshot.grid.meter_communicating ? 'Communicating' : 'Unavailable'} /><Detail label="Raw sensors" value={formatNumber(snapshot.raw_count, 0)} /><Detail label="Reporting timezone" value="Asia/Karachi" /></dl></Panel></div><div className="two-column"><Panel title="System details" action={<Server />}><dl className="details-grid"><Detail label="Operation code" value={formatNumber(system.operation_mode_code, 0)} /><Detail label="Safety profile" value={system.safety_country || String(system.safety_country_code)} /><Detail label="Warning code" value={formatNumber(system.warning_code, 0)} /><Detail label="Error code" value={formatNumber(system.error_code, 0)} /></dl></Panel><Panel title="Status registers" action={<Gauge />}><dl className="details-grid"><Detail label="Errors" value={system.errors || 'None'} /><Detail label="Diagnostic flags" value={system.diagnostic || 'None'} note="Informational unless fault registers are set" /></dl></Panel></div><Panel title="Event history" eyebrow={`${events.length} local events`}><EventList events={events} /></Panel></>;
}

export function RawPage({ sensors }: { sensors: SensorReading[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('ALL');
  const categories = useMemo(() => ['ALL', ...Array.from(new Set(sensors.map((sensor) => sensor.category))).sort()], [sensors]);
  const rows = useMemo(() => sensors.filter((sensor) => (category === 'ALL' || sensor.category === category) && `${sensor.id} ${sensor.name} ${sensor.value}`.toLowerCase().includes(query.toLowerCase())), [sensors, query, category]);
  return <><PageIntro eyebrow="Technical" title="Raw sensor data" description="Every original inverter reading, including values hidden from normal single-phase views." hero={<div className="hero-reading neutral"><Database />{sensors.length}<small>readings</small></div>} /><Panel title="Sensor inventory" action={<div className="raw-tools"><SearchField value={query} onChange={setQuery} placeholder="Search name, ID or value" /><select aria-label="Filter category" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></div>}><div className="table-wrap"><table><thead><tr><th>ID</th><th>Friendly name</th><th>Value</th><th>Unit</th><th>Category</th><th>Timestamp</th></tr></thead><tbody>{rows.map((sensor) => <tr key={sensor.id}><td><code>{sensor.id}</code></td><td>{sensor.name}</td><td className="value-cell">{String(sensor.value ?? '—')}</td><td>{sensor.unit}</td><td><span className="category-pill">{sensor.category}</span></td><td>{formatDateTime(sensor.timestamp)}</td></tr>)}</tbody></table>{!rows.length && <EmptyState compact title="No matching sensors" />}</div></Panel></>;
}

export function LoadingPage({ loading }: { loading: boolean }) {
  return <div className="loading-screen"><div className="loading-logo"><Activity /></div><h1>Connecting to GoodWe Home</h1><p>{loading ? 'Starting the local collector…' : 'No telemetry is available yet.'}</p></div>;
}
