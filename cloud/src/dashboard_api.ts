import type { D1Database } from './cloudflare';
import { sensorMetadata } from './et_decoder';

export interface DashboardApiConfig {
  deviceId: string;
  reportingTimezone: string;
  batteryCapacityKwh?: number;
  batteryReservePct?: number;
  inverterRatedW?: number;
  now: () => Date;
}

interface LatestRow {
  sequence: number;
  timestamp_ms: number;
  snapshot_json: string;
  raw_json: string;
}

interface TelemetryRow {
  sample_count: number;
  timestamp_ms: number;
  pv_w: number;
  home_w: number;
  grid_w: number;
  battery_w: number;
  backup_w: number;
  battery_soc_pct: number;
  grid_voltage_v: number;
  grid_frequency_hz: number;
  inverter_temperature_c: number;
  solar_day_kwh: number;
  load_day_kwh: number;
  export_day_kwh: number;
  import_day_kwh: number;
  battery_charge_day_kwh: number;
  battery_discharge_day_kwh: number;
}

interface ForecastPoint {
  timestamp: string;
  irradiance_w_m2: number;
  pv_w: number | null;
}

interface WeatherDay {
  day: string;
  weather_code: number | null;
  temperature_max_c: number | null;
  temperature_min_c: number | null;
  precipitation_probability_max_pct: number | null;
  precipitation_mm: number | null;
  wind_speed_max_kph: number | null;
  sunrise: string | null;
  sunset: string | null;
}

interface ForecastRow {
  provider: string;
  fetched_at: string;
  payload_json: string;
}

interface DailyRow {
  day: string;
  payload_json: string;
}

interface OutageRow {
  id: number;
  start_at: string;
  end_at: string | null;
  start_soc_pct: number | null;
  end_soc_pct: number | null;
  confidence: number;
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function starting(config: DashboardApiConfig): Response {
  return json(503, {
    connection: {
      state: 'starting',
      consecutive_failures: 0,
      display_model: 'GoodWe ET',
      reporting_timezone: config.reportingTimezone,
    },
    message: 'Waiting for the first inverter reading',
  });
}

function range(
  url: URL,
  now: Date,
  reportingTimezone: string,
): { period: string; start: Date; end: Date; resolution: string } {
  const period = url.searchParams.get('period') ?? 'day';
  const anchorText = url.searchParams.get('anchor');
  let start: Date;
  let end: Date;
  if (!anchorText) {
    const durationDays =
      period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365;
    end = now;
    start = new Date(now.valueOf() - durationDays * 86_400_000);
  } else if (period === 'week') {
    const anchor = parseDate(anchorText);
    end = zonedMidnight(shiftDate(anchor, 1), reportingTimezone);
    start = zonedMidnight(shiftDate(anchor, -6), reportingTimezone);
  } else if (period === 'month') {
    const anchor = parseDate(anchorText);
    start = zonedMidnight({ ...anchor, day: 1 }, reportingTimezone);
    end = zonedMidnight(nextMonth(anchor.year, anchor.month), reportingTimezone);
  } else if (period === 'year') {
    const anchor = parseDate(anchorText);
    start = zonedMidnight({ year: anchor.year, month: 1, day: 1 }, reportingTimezone);
    end = zonedMidnight({ year: anchor.year + 1, month: 1, day: 1 }, reportingTimezone);
  } else {
    const anchor = parseDate(anchorText);
    start = zonedMidnight(anchor, reportingTimezone);
    end = zonedMidnight(shiftDate(anchor, 1), reportingTimezone);
  }
  const rawRetentionStart = now.valueOf() - 30 * 86_400_000;
  const minuteRetentionStart = now.valueOf() - 365 * 86_400_000;
  const resolution =
    period === 'day'
      ? start.valueOf() >= rawRetentionStart
        ? '10s'
        : '15m'
      : (period === 'week' || period === 'month') && start.valueOf() >= minuteRetentionStart
        ? '1m'
        : '15m';
  return {
    period,
    start,
    end,
    resolution,
  };
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseDate(value: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('invalid_anchor');
  const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const probe = new Date(Date.UTC(result.year, result.month - 1, result.day));
  if (
    probe.getUTCFullYear() !== result.year ||
    probe.getUTCMonth() + 1 !== result.month ||
    probe.getUTCDate() !== result.day
  ) {
    throw new Error('invalid_anchor');
  }
  return result;
}

function shiftDate(value: DateParts, days: number): DateParts {
  const shifted = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function nextMonth(year: number, month: number): DateParts {
  return month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
}

function zonedMidnight(value: DateParts, timezone: string): Date {
  const target = Date.UTC(value.year, value.month - 1, value.day);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    candidate += target - represented;
  }
  return new Date(candidate);
}

async function latest(database: D1Database, deviceId: string): Promise<LatestRow | null> {
  return database
    .prepare(
      'SELECT sequence, timestamp_ms, snapshot_json, raw_json FROM latest_state WHERE device_id = ?1',
    )
    .bind(deviceId)
    .first<LatestRow>();
}

async function rows(
  database: D1Database,
  deviceId: string,
  start: Date,
  end: Date,
  resolution = '10s',
): Promise<TelemetryRow[]> {
  if (resolution === '1m' || resolution === '15m') {
    const table = resolution === '1m' ? 'aggregates_1m' : 'aggregates_15m';
    const aggregate = await database
      .prepare(
        `SELECT sample_count, bucket_ms AS timestamp_ms,
                json_extract(payload_json, '$.pv_w') AS pv_w,
                json_extract(payload_json, '$.home_w') AS home_w,
                json_extract(payload_json, '$.grid_w') AS grid_w,
                json_extract(payload_json, '$.battery_w') AS battery_w,
                json_extract(payload_json, '$.backup_w') AS backup_w,
                json_extract(payload_json, '$.battery_soc_pct') AS battery_soc_pct,
                json_extract(payload_json, '$.grid_voltage_v') AS grid_voltage_v,
                json_extract(payload_json, '$.grid_frequency_hz') AS grid_frequency_hz,
                json_extract(payload_json, '$.inverter_temperature_c') AS inverter_temperature_c,
                json_extract(payload_json, '$.solar_day_kwh') AS solar_day_kwh,
                json_extract(payload_json, '$.load_day_kwh') AS load_day_kwh,
                json_extract(payload_json, '$.export_day_kwh') AS export_day_kwh,
                json_extract(payload_json, '$.import_day_kwh') AS import_day_kwh,
                json_extract(payload_json, '$.battery_charge_day_kwh') AS battery_charge_day_kwh,
                json_extract(payload_json, '$.battery_discharge_day_kwh') AS battery_discharge_day_kwh
         FROM ${table} WHERE device_id = ?1 AND bucket_ms >= ?2 AND bucket_ms < ?3
         ORDER BY bucket_ms`,
      )
      .bind(deviceId, start.valueOf(), end.valueOf())
      .all<TelemetryRow>();
    const bucketMs = resolution === '1m' ? 60_000 : 900_000;
    const overlapMs = resolution === '1m' ? 10 * 60_000 : 30 * 60_000;
    const tail = await rawRows(
      database,
      deviceId,
      new Date(Math.max(start.valueOf(), end.valueOf() - overlapMs)),
      end,
    );
    const merged = new Map(
      (aggregate.results ?? []).map((row) => [row.timestamp_ms, row] as const),
    );
    for (const row of aggregateRows(tail, bucketMs)) merged.set(row.timestamp_ms, row);
    return [...merged.values()].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  }
  return rawRows(database, deviceId, start, end);
}

async function rawRows(
  database: D1Database,
  deviceId: string,
  start: Date,
  end: Date,
): Promise<TelemetryRow[]> {
  const result = await database
    .prepare(
      `SELECT 1 AS sample_count, timestamp_ms, pv_w, home_w, grid_w, battery_w, backup_w, battery_soc_pct,
              grid_voltage_v, grid_frequency_hz, inverter_temperature_c,
              solar_day_kwh, load_day_kwh, export_day_kwh, import_day_kwh,
              battery_charge_day_kwh, battery_discharge_day_kwh
       FROM telemetry WHERE device_id = ?1 AND timestamp_ms >= ?2 AND timestamp_ms < ?3
       ORDER BY timestamp_ms`,
    )
    .bind(deviceId, start.valueOf(), end.valueOf())
    .all<TelemetryRow>();
  return result.results ?? [];
}

function aggregateRows(raw: TelemetryRow[], bucketMs: number): TelemetryRow[] {
  const groups = new Map<number, TelemetryRow[]>();
  for (const row of raw) {
    const bucket = Math.floor(row.timestamp_ms / bucketMs) * bucketMs;
    const values = groups.get(bucket) ?? [];
    values.push(row);
    groups.set(bucket, values);
  }
  const averages: Array<keyof TelemetryRow> = [
    'pv_w',
    'home_w',
    'grid_w',
    'battery_w',
    'backup_w',
    'battery_soc_pct',
    'grid_voltage_v',
    'grid_frequency_hz',
    'inverter_temperature_c',
  ];
  return [...groups.entries()].map(([timestamp_ms, values]) => {
    const latest = values.at(-1)!;
    const result = { ...latest, timestamp_ms, sample_count: values.length };
    for (const key of averages) {
      result[key] = values.reduce((sum, row) => sum + row[key], 0) / values.length;
    }
    return result;
  });
}

function energy(row?: TelemetryRow): Record<string, number> {
  return {
    solar_kwh: row?.solar_day_kwh ?? 0,
    load_kwh: row?.load_day_kwh ?? 0,
    export_kwh: row?.export_day_kwh ?? 0,
    import_kwh: row?.import_day_kwh ?? 0,
    battery_charge_kwh: row?.battery_charge_day_kwh ?? 0,
    battery_discharge_kwh: row?.battery_discharge_day_kwh ?? 0,
  };
}

function periodEnergy(telemetry: TelemetryRow[], timezone: string): Record<string, number> {
  const daily = new Map<string, TelemetryRow>();
  for (const row of telemetry) daily.set(localDay(new Date(row.timestamp_ms), timezone), row);
  return [...daily.values()].reduce((total, row) => {
    const value = energy(row);
    for (const key of Object.keys(total)) total[key] += value[key] ?? 0;
    return total;
  }, energy());
}

async function latestForecast(database: D1Database): Promise<ForecastRow | null> {
  return database
    .prepare(
      `SELECT provider, fetched_at, payload_json
       FROM forecasts ORDER BY forecast_at_ms DESC LIMIT 1`,
    )
    .first<ForecastRow>();
}

function forecastResponse(
  row: ForecastRow | null,
  now: Date,
  reportingTimezone: string,
): Record<string, unknown> {
  if (!row) {
    return {
      status: 'collecting',
      reason: 'The forecast scheduler has not produced a forecast yet.',
      provider: 'Open-Meteo',
      updated_at: null,
      today_kwh: null,
      tomorrow_kwh: null,
      calibration_days: 0,
      points: [],
      weather_days: [],
    };
  }
  const payload = JSON.parse(row.payload_json) as {
    points?: ForecastPoint[];
    weather_days?: WeatherDay[];
  };
  const points = payload.points ?? [];
  const today = localDay(now, reportingTimezone);
  const tomorrowParts = shiftDate(parseDate(today), 1);
  const tomorrow = `${tomorrowParts.year}-${String(tomorrowParts.month).padStart(2, '0')}-${String(tomorrowParts.day).padStart(2, '0')}`;
  const energyForDay = (day: string): number =>
    points
      .filter(
        (point) =>
          localDay(
            new Date(point.timestamp.endsWith('Z') ? point.timestamp : `${point.timestamp}Z`),
            reportingTimezone,
          ) === day,
      )
      .reduce((sum, point) => sum + Math.max(0, point.pv_w ?? 0) / 1000, 0);
  const ageHours = Math.max(0, (now.valueOf() - Date.parse(row.fetched_at)) / 3_600_000);
  return {
    status: ageHours <= 6 ? 'ready' : 'stale',
    reason:
      ageHours <= 6
        ? 'Estimated from the latest Open-Meteo irradiance forecast.'
        : 'The latest forecast is older than six hours.',
    provider: row.provider,
    updated_at: row.fetched_at,
    today_kwh: energyForDay(today),
    tomorrow_kwh: energyForDay(tomorrow),
    calibration_days: 0,
    points,
    weather_days: payload.weather_days ?? [],
  };
}

function historyPoint(row: TelemetryRow): Record<string, number | string> {
  return {
    timestamp: new Date(row.timestamp_ms).toISOString(),
    pv_w: row.pv_w,
    home_w: row.home_w,
    grid_w: row.grid_w,
    battery_w: row.battery_w,
    backup_w: row.backup_w,
    battery_soc_pct: row.battery_soc_pct,
    grid_voltage_v: row.grid_voltage_v,
    grid_frequency_hz: row.grid_frequency_hz,
    inverter_temperature_c: row.inverter_temperature_c,
  };
}

function localDay(value: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function forecastTimestamp(value: string): number {
  return Date.parse(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
}

function localMinute(value: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts.hour * 60 + Math.floor(parts.minute / 30) * 30;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

async function dailyRows(
  database: D1Database,
  deviceId: string,
  start: Date,
  end: Date,
  timezone: string,
): Promise<Array<Record<string, number | string>>> {
  const result = await database
    .prepare(
      `SELECT day, payload_json FROM aggregates_daily
       WHERE device_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day`,
    )
    .bind(deviceId, localDay(start, timezone), localDay(new Date(end.valueOf() - 1), timezone))
    .all<DailyRow>();
  return (result.results ?? []).map((row) => ({
    day: row.day,
    ...(JSON.parse(row.payload_json) as Record<string, number>),
  }));
}

async function outageRows(database: D1Database, deviceId: string): Promise<OutageRow[]> {
  const result = await database
    .prepare(
      `SELECT id, start_at, end_at, start_soc_pct, end_soc_pct, confidence
       FROM outages WHERE device_id = ?1 ORDER BY start_at DESC LIMIT 100`,
    )
    .bind(deviceId)
    .all<OutageRow>();
  return result.results ?? [];
}

export async function handleDashboardApi(
  request: Request,
  config: DashboardApiConfig,
  database: D1Database,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const periodRoutes = ['/api/v1/history', '/api/v1/summary', '/api/v1/export.csv'];
  const requestedPeriod = url.searchParams.get('period') ?? 'day';
  if (
    periodRoutes.includes(url.pathname) &&
    !['day', 'week', 'month', 'year'].includes(requestedPeriod)
  ) {
    return json(422, { error: 'invalid_period' });
  }

  if (url.pathname === '/api/v1/health') {
    const value = await latest(database, config.deviceId);
    const age = value ? Math.max(0, (config.now().valueOf() - value.timestamp_ms) / 1000) : null;
    return json(200, {
      ok: age !== null && age <= 30,
      state: age === null ? 'starting' : age <= 30 ? 'live' : age <= 300 ? 'stale' : 'offline',
      host: null,
      read_only: true,
    });
  }

  if (url.pathname === '/api/v1/status') {
    const value = await latest(database, config.deviceId);
    if (!value) return starting(config);
    const snapshot = JSON.parse(value.snapshot_json) as Record<string, unknown> & {
      connection: Record<string, unknown>;
    };
    const age = Math.max(0, (config.now().valueOf() - value.timestamp_ms) / 1000);
    snapshot.connection = {
      ...snapshot.connection,
      age_seconds: age,
      state: age <= 30 ? 'live' : age <= 300 ? 'stale' : 'offline',
      reporting_timezone: config.reportingTimezone,
    };
    return json(200, snapshot);
  }

  if (url.pathname === '/api/v1/sensors') {
    const value = await latest(database, config.deviceId);
    if (!value) return json(200, []);
    const raw = JSON.parse(value.raw_json) as Record<string, unknown>;
    const timestamp = new Date(value.timestamp_ms).toISOString();
    return json(
      200,
      Object.entries(raw).map(([id, sensorValue]) => ({
        id,
        name: sensorMetadata.get(id)?.name ?? id.replaceAll('_', ' '),
        value: sensorValue,
        unit: sensorMetadata.get(id)?.unit ?? '',
        category: sensorMetadata.get(id)?.category ?? 'OTHER',
        timestamp,
      })),
    );
  }

  if (url.pathname === '/api/v1/events') {
    const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
      return json(422, { error: 'invalid_limit' });
    }
    const limit = requestedLimit;
    const result = await database
      .prepare(
        `SELECT id, created_at, severity, event_type, message, details_json
         FROM events WHERE device_id = ?1 ORDER BY id DESC LIMIT ?2`,
      )
      .bind(config.deviceId, limit)
      .all<{
        id: number;
        created_at: string;
        severity: string;
        event_type: string;
        message: string;
        details_json: string;
      }>();
    return json(
      200,
      (result.results ?? []).map(({ details_json, ...event }) => ({
        ...event,
        details: JSON.parse(details_json),
      })),
    );
  }

  if (url.pathname === '/api/v1/command-center') {
    const requestedRange = url.searchParams.get('range') ?? '24h';
    const rangeHours: Record<string, number> = {
      '15m': 0.25,
      '1h': 1,
      '3h': 3,
      '6h': 6,
      '12h': 12,
      '24h': 24,
    };
    const requestedHistory = url.searchParams.get('history') ?? '30d';
    if (
      !(requestedRange in rangeHours) ||
      !['14d', '30d', '60d', '12m'].includes(requestedHistory)
    ) {
      return json(422, { error: 'invalid_range' });
    }
    const value = await latest(database, config.deviceId);
    if (!value) return starting(config);
    const snapshot = JSON.parse(value.snapshot_json) as {
      headline: string;
      power: Record<string, number | string>;
      battery: { soc_pct: number; soh_pct: number };
      insights?: { grid_independence_pct?: number; solar_retention_pct?: number };
      today: Record<string, number>;
      lifetime: Record<string, number>;
      system: { health: string };
    };
    const hours = rangeHours[requestedRange];
    const now = config.now();
    const trendResolution = hours <= 1 ? '10s' : '1m';
    const historyDays: Record<string, number> = { '14d': 14, '30d': 30, '60d': 60, '12m': 365 };
    const [recent, forecast, daily, storedOutages] = await Promise.all([
      rows(
        database,
        config.deviceId,
        new Date(now.valueOf() - hours * 3_600_000),
        now,
        trendResolution,
      ),
      latestForecast(database),
      dailyRows(
        database,
        config.deviceId,
        new Date(now.valueOf() - historyDays[requestedHistory] * 86_400_000),
        now,
        config.reportingTimezone,
      ),
      outageRows(database, config.deviceId),
    ]);
    const home = Number(snapshot.power.home_w);
    const solar = Number(snapshot.power.pv_w);
    const battery = Number(snapshot.power.battery_w);
    const grid = Number(snapshot.power.grid_w);
    const demand = Math.max(0, home);
    const pv = Math.max(0, solar);
    const solarSupply = Math.min(Math.max(0, pv - Math.max(0, grid)), demand);
    const batterySupply = Math.min(Math.max(0, battery), Math.max(0, demand - solarSupply));
    const gridSupply = Math.min(
      Math.max(0, -grid),
      Math.max(0, demand - solarSupply - batterySupply),
    );
    const unaccounted = Math.max(0, demand - solarSupply - batterySupply - gridSupply);
    const denominator = Math.max(1, demand);
    const measuredBalance = pv + battery - grid;
    const powerBalance =
      Math.abs(measuredBalance - demand) <= Math.max(50, demand * 0.05) ? 'balanced' : 'mismatch';
    const dominant = Math.max(solarSupply, batterySupply, gridSupply);
    const dominantName =
      dominant === solarSupply ? 'Solar' : dominant === batterySupply ? 'Battery' : 'Grid';
    const dailyHistory = daily.map((row) => ({
      day: String(row.day),
      energy: {
        solar_kwh: Number(row.solar_kwh ?? 0),
        load_kwh: Number(row.load_kwh ?? 0),
        export_kwh: Number(row.export_kwh ?? 0),
        import_kwh: Number(row.import_kwh ?? 0),
        battery_charge_kwh: Number(row.battery_charge_kwh ?? 0),
        battery_discharge_kwh: Number(row.battery_discharge_kwh ?? 0),
      },
      peak_pv_w: Number(row.peak_pv_w ?? 0),
      peak_home_w: Number(row.peak_home_w ?? 0),
      coverage_pct: Math.min(100, (Number(row.sample_count ?? 0) / 8640) * 100),
    }));
    const periodTotals = dailyHistory.reduce<Record<string, number>>((total, day) => {
      for (const key of Object.keys(total))
        total[key] += day.energy[key as keyof typeof day.energy];
      return total;
    }, energy());
    const outages = storedOutages.map((outage) => ({
      ...outage,
      duration_seconds: outage.end_at
        ? Math.max(0, (Date.parse(outage.end_at) - Date.parse(outage.start_at)) / 1000)
        : null,
      ongoing: outage.end_at === null,
    }));
    const completedDurations = outages
      .map((outage) => outage.duration_seconds)
      .filter((duration): duration is number => duration !== null);
    const todayDay = localDay(now, config.reportingTimezone);
    const validLearningDays = dailyHistory.filter(
      (day) => day.day !== todayDay && day.coverage_pct >= 90,
    ).length;
    const completedOutages = outages.filter((outage) => !outage.ongoing);
    const outageBucketDays = new Map<number, Set<string>>(
      Array.from({ length: 48 }, (_, index) => [index * 30, new Set<string>()]),
    );
    for (const outage of completedOutages) {
      const end = Date.parse(outage.end_at!);
      for (let cursor = Date.parse(outage.start_at); cursor <= end; cursor += 30 * 60_000) {
        outageBucketDays
          .get(localMinute(new Date(cursor), config.reportingTimezone))!
          .add(localDay(new Date(cursor), config.reportingTimezone));
      }
    }
    const outageBuckets = [...outageBucketDays].map(([minute_of_day, days]) => ({
      minute_of_day,
      probability_pct: validLearningDays ? (days.size / validLearningDays) * 100 : 0,
    }));
    const likelyOutageMinutes = new Set(
      outageBuckets
        .filter((bucket) => bucket.probability_pct >= 50)
        .map((bucket) => bucket.minute_of_day),
    );
    let nextOutageStart: string | null = null;
    let nextOutageEnd: string | null = null;
    if (validLearningDays >= 14 && completedOutages.length >= 3 && likelyOutageMinutes.size) {
      const firstCandidate = Math.ceil(now.valueOf() / (30 * 60_000)) * 30 * 60_000;
      for (let offset = 0; offset <= 48; offset += 1) {
        const candidate = new Date(firstCandidate + offset * 30 * 60_000);
        if (!likelyOutageMinutes.has(localMinute(candidate, config.reportingTimezone))) continue;
        nextOutageStart = candidate.toISOString();
        let end = new Date(candidate.valueOf() + 30 * 60_000);
        while (
          end.valueOf() < candidate.valueOf() + 24 * 3_600_000 &&
          likelyOutageMinutes.has(localMinute(end, config.reportingTimezone))
        ) {
          end = new Date(end.valueOf() + 30 * 60_000);
        }
        nextOutageEnd = end.toISOString();
        break;
      }
    }
    const peakPv = dailyHistory.reduce(
      (best, day) => (day.peak_pv_w > best.peak_pv_w ? day : best),
      dailyHistory[0] ?? {
        day: '',
        peak_pv_w: 0,
        peak_home_w: 0,
        energy: energy(),
        coverage_pct: 0,
      },
    );
    const peakHome = dailyHistory.reduce(
      (best, day) => (day.peak_home_w > best.peak_home_w ? day : best),
      dailyHistory[0] ?? {
        day: '',
        peak_pv_w: 0,
        peak_home_w: 0,
        energy: energy(),
        coverage_pct: 0,
      },
    );
    const batteryCapacityKwh = Number(config.batteryCapacityKwh);
    const batteryReservePct = Math.min(100, Math.max(0, Number(config.batteryReservePct ?? 20)));
    const batterySocPct = Number(snapshot.battery.soc_pct);
    const hasBatteryPolicy =
      Number.isFinite(batteryCapacityKwh) &&
      batteryCapacityKwh > 0 &&
      Number.isFinite(batterySocPct);
    const reserveMarginPct = hasBatteryPolicy
      ? Math.max(0, batterySocPct - batteryReservePct)
      : null;
    const availableKwh =
      reserveMarginPct === null
        ? null
        : (batteryCapacityKwh *
            Math.max(0, Number(snapshot.battery.soh_pct) || 100) *
            reserveMarginPct) /
          10_000;
    const averageLoadW = recent.length
      ? recent.reduce((sum, point) => sum + Math.max(0, point.home_w), 0) / recent.length
      : demand;
    const batteryDischargeW = Math.max(0, battery);
    const runtimeHours =
      availableKwh === null || batteryDischargeW <= 50
        ? null
        : availableKwh / (batteryDischargeW / 1000);
    const inverterRatedW = Number(config.inverterRatedW);
    const inverterUtilizationPct =
      Number.isFinite(inverterRatedW) && inverterRatedW > 0
        ? Math.min(100, (demand / inverterRatedW) * 100)
        : null;
    const forecastPoints = forecast
      ? ((JSON.parse(forecast.payload_json) as { points?: ForecastPoint[] }).points ?? [])
      : [];
    let projectedSoc = batterySocPct;
    let previousTimestamp = now.valueOf();
    const projectionReady =
      hasBatteryPolicy && validLearningDays >= 15 && forecastPoints.length > 0;
    const projectionPoints = projectionReady
      ? forecastPoints
          .filter((point) => forecastTimestamp(point.timestamp) > now.valueOf())
          .slice(0, 24)
          .map((point) => {
            const timestamp = forecastTimestamp(point.timestamp);
            const hoursElapsed = Math.min(
              3,
              Math.max(0, (timestamp - previousTimestamp) / 3_600_000),
            );
            previousTimestamp = timestamp;
            projectedSoc = Math.min(
              100,
              Math.max(
                batteryReservePct,
                projectedSoc +
                  (((Math.max(0, point.pv_w ?? 0) - averageLoadW) * hoursElapsed) /
                    1000 /
                    batteryCapacityKwh) *
                    100,
              ),
            );
            return {
              timestamp: new Date(timestamp).toISOString(),
              pv_w: Math.max(0, point.pv_w ?? 0),
              load_w: averageLoadW,
              soc_pct: projectedSoc,
              outage_likely: false,
            };
          })
      : [];
    const lowestProjection = projectionPoints.reduce<(typeof projectionPoints)[number] | null>(
      (lowest, point) => (!lowest || point.soc_pct < lowest.soc_pct ? point : lowest),
      null,
    );
    return json(200, {
      generated_at: now.toISOString(),
      live: {
        headline: snapshot.headline,
        explanation:
          demand <= 0
            ? 'No household demand is currently measured.'
            : `${dominantName} is supplying most of the current home demand.`,
        dominant_power_w: dominant,
        energy_mix: {
          home_w: demand,
          solar_w: solarSupply,
          battery_w: batterySupply,
          grid_w: gridSupply,
          unaccounted_w: unaccounted,
          solar_pct: demand > 0 ? (solarSupply / denominator) * 100 : 0,
          battery_pct: demand > 0 ? (batterySupply / denominator) * 100 : 0,
          grid_pct: demand > 0 ? (gridSupply / denominator) * 100 : 0,
          unaccounted_pct: demand > 0 ? (unaccounted / denominator) * 100 : 0,
        },
        solar_coverage_pct: demand > 0 ? (solarSupply / demand) * 100 : null,
        inverter_utilization_pct: inverterUtilizationPct,
        power_balance: powerBalance,
        battery_reserve: {
          status: hasBatteryPolicy ? 'ready' : 'unconfigured',
          reason: hasBatteryPolicy
            ? `Energy above the configured ${batteryReservePct}% reserve floor.`
            : 'Battery capacity is configured privately during deployment.',
          available_kwh: availableKwh,
          reserve_margin_pct: reserveMarginPct,
          runtime_hours: runtimeHours,
        },
      },
      health: [
        {
          id: 'reserve',
          label: 'Battery reserve',
          status: !hasBatteryPolicy ? 'unknown' : reserveMarginPct! <= 5 ? 'warning' : 'healthy',
          value:
            reserveMarginPct === null ? 'Not configured' : `${reserveMarginPct.toFixed(0)}% margin`,
          detail: hasBatteryPolicy
            ? 'Calculated from configured capacity, reserve floor, SOC, and SOH.'
            : 'Battery capacity is not configured.',
        },
        {
          id: 'inverter',
          label: 'Inverter',
          status: snapshot.system.health,
          value: snapshot.system.health,
          detail: 'Derived from inverter warning and error registers.',
        },
      ],
      trend: {
        range: requestedRange,
        resolution: trendResolution,
        points: recent.map(historyPoint),
        outages: outages.map((outage) => ({ start: outage.start_at, end: outage.end_at })),
      },
      today: {
        energy: snapshot.today,
        yesterday_same_time: null,
        grid_independence_pct:
          snapshot.insights?.grid_independence_pct ??
          (Number(snapshot.today.load_kwh) > 0
            ? Math.max(
                0,
                (1 - Number(snapshot.today.import_kwh) / Number(snapshot.today.load_kwh)) * 100,
              )
            : null),
        solar_self_consumption_pct:
          snapshot.insights?.solar_retention_pct ??
          (Number(snapshot.today.solar_kwh) > 0
            ? Math.max(
                0,
                (1 - Number(snapshot.today.export_kwh) / Number(snapshot.today.solar_kwh)) * 100,
              )
            : null),
        peaks: recent.length
          ? [
              {
                metric: 'pv_w',
                value: Math.max(...recent.map((point) => point.pv_w)),
                unit: 'W',
                occurred_at: new Date(
                  recent.reduce((peak, point) => (point.pv_w > peak.pv_w ? point : peak))
                    .timestamp_ms,
                ).toISOString(),
              },
              {
                metric: 'home_w',
                value: Math.max(...recent.map((point) => point.home_w)),
                unit: 'W',
                occurred_at: new Date(
                  recent.reduce((peak, point) => (point.home_w > peak.home_w ? point : peak))
                    .timestamp_ms,
                ).toISOString(),
              },
            ]
          : [],
      },
      daily_history: dailyHistory,
      period_totals: dailyHistory.length ? periodTotals : snapshot.today,
      lifetime: snapshot.lifetime,
      records: dailyHistory.length
        ? [
            {
              id: 'peak_pv_w',
              label: 'Peak solar power',
              value: peakPv.peak_pv_w,
              unit: 'W',
              day: peakPv.day,
            },
            {
              id: 'peak_home_w',
              label: 'Peak home demand',
              value: peakHome.peak_home_w,
              unit: 'W',
              day: peakHome.day,
            },
          ]
        : [],
      outages,
      outage_outlook: {
        status: validLearningDays >= 14 && completedOutages.length >= 3 ? 'ready' : 'collecting',
        reason:
          validLearningDays >= 14 && completedOutages.length >= 3
            ? 'Calculated from confirmed local outage intervals.'
            : 'Fourteen valid days and three confirmed outages are required.',
        observed_days: validLearningDays,
        outage_count: completedOutages.length,
        next_window_start: nextOutageStart,
        next_window_end: nextOutageEnd,
        typical_duration_minutes: median(completedDurations.map((value) => value / 60)),
        buckets: outageBuckets,
      },
      forecast: forecastResponse(forecast, now, config.reportingTimezone),
      projection: {
        status: !hasBatteryPolicy ? 'unconfigured' : projectionReady ? 'ready' : 'collecting',
        reason: !hasBatteryPolicy
          ? 'Battery capacity must be configured privately before projecting state of charge.'
          : projectionReady
            ? 'Conservative estimate from forecast solar, recent demand, and the reserve floor.'
            : 'Projection needs a forecast and fifteen coverage-valid days.',
        lowest_soc_pct: lowestProjection?.soc_pct ?? null,
        lowest_soc_at: lowestProjection?.timestamp ?? null,
        points: projectionPoints,
      },
      watchdog: {
        status: 'ready',
        reason: 'Collector telemetry is current.',
        metrics: [],
        recommendation: 'No action required.',
      },
      readiness: {
        live: {
          status: 'ready',
          reason: 'Live inverter telemetry',
          observed: null,
          required: null,
        },
        health: {
          status: 'ready',
          reason: 'Health registers are present in every poll.',
          observed: null,
          required: null,
        },
        trend: {
          status: recent.length ? 'ready' : 'collecting',
          reason: recent.length
            ? 'Retained telemetry is available.'
            : 'Waiting for retained telemetry.',
          observed: recent.length,
          required: 1,
        },
        today: {
          status: 'ready',
          reason: "Reported by the inverter's daily counters.",
          observed: null,
          required: null,
        },
        lifetime: {
          status: 'ready',
          reason: "Reported by the inverter's retained counters.",
          observed: null,
          required: null,
        },
      },
    });
  }

  let selected: ReturnType<typeof range>;
  try {
    selected = range(url, config.now(), config.reportingTimezone);
  } catch {
    return json(422, { error: 'invalid_anchor' });
  }
  const dataset = url.searchParams.get('dataset') ?? 'telemetry';
  if (url.pathname === '/api/v1/export.csv' && !['telemetry', 'daily'].includes(dataset)) {
    return json(422, { error: 'invalid_dataset' });
  }
  if (url.pathname === '/api/v1/export.csv' && dataset === 'daily') {
    const daily = await dailyRows(
      database,
      config.deviceId,
      selected.start,
      selected.end,
      config.reportingTimezone,
    );
    const header =
      'day,solar_kwh,load_kwh,export_kwh,import_kwh,battery_charge_kwh,battery_discharge_kwh,peak_pv_w,peak_home_w';
    return new Response([header, ...daily.map((row) => Object.values(row).join(','))].join('\n'), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="goodwe-home-daily-${selected.period}.csv"`,
      },
    });
  }
  const summaryResolution =
    selected.start.valueOf() >= config.now().valueOf() - 365 * 86_400_000 ? '1m' : '15m';
  const telemetry = await rows(
    database,
    config.deviceId,
    selected.start,
    selected.end,
    url.pathname === '/api/v1/summary' ? summaryResolution : selected.resolution,
  );
  if (url.pathname === '/api/v1/history') {
    return json(200, {
      period: selected.period,
      resolution: selected.resolution,
      start: selected.start.toISOString(),
      end: selected.end.toISOString(),
      points: telemetry.map(historyPoint),
    });
  }

  if (url.pathname === '/api/v1/summary') {
    const periodTotal = periodEnergy(telemetry, config.reportingTimezone);
    const load = periodTotal.load_kwh;
    const solar = periodTotal.solar_kwh;
    const samples = telemetry.reduce((sum, row) => sum + row.sample_count, 0);
    const observedSeconds = telemetry.length
      ? (telemetry.at(-1)!.timestamp_ms - telemetry[0].timestamp_ms) / 1000
      : 0;
    const expectedSamples = Math.max(1, observedSeconds / 10 + 1);
    return json(200, {
      period: selected.period,
      energy: periodTotal,
      peak_pv_w: Math.max(0, ...telemetry.map((row) => row.pv_w)),
      peak_home_w: Math.max(0, ...telemetry.map((row) => row.home_w)),
      minimum_soc_pct: telemetry.length
        ? Math.min(...telemetry.map((row) => row.battery_soc_pct))
        : null,
      maximum_soc_pct: telemetry.length
        ? Math.max(...telemetry.map((row) => row.battery_soc_pct))
        : null,
      availability_pct: telemetry.length ? Math.min(100, (samples / expectedSamples) * 100) : 0,
      grid_independence_pct:
        load > 0
          ? Math.max(0, Math.min(100, ((load - periodTotal.import_kwh) / load) * 100))
          : null,
      solar_retention_pct:
        solar > 0
          ? Math.max(0, Math.min(100, ((solar - periodTotal.export_kwh) / solar) * 100))
          : null,
    });
  }

  if (url.pathname === '/api/v1/export.csv') {
    const header =
      'timestamp,pv_w,home_w,grid_w,battery_w,backup_w,battery_soc_pct,grid_voltage_v,grid_frequency_hz,inverter_temperature_c';
    const lines = telemetry.map((row) => Object.values(historyPoint(row)).join(','));
    return new Response([header, ...lines].join('\n'), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="goodwe-home-${selected.period}.csv"`,
      },
    });
  }

  return json(404, { error: 'not_found' });
}
