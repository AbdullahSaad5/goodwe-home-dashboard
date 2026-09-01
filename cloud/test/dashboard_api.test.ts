import { describe, expect, it, vi } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result, R2Bucket } from '../src/cloudflare';
import { handleDashboardApi } from '../src/dashboard_api';
import type { WorkerEnv } from '../src/env';
import { runScheduledMaintenance } from '../src/maintenance';

class Statement implements D1PreparedStatement {
  values: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly database: Database,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.first(this) as T | null) ?? null;
  }

  async run(): Promise<D1Result> {
    return { success: true };
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: (this.database.all(this) as T[]) ?? [] };
  }
}

class Database implements D1Database {
  readonly prepared: Statement[] = [];
  batched: Statement[] = [];
  latest: unknown = null;
  forecast: unknown = null;
  queryRows: unknown[] = [];
  dailyQueryRows: unknown[] = [];

  prepare(query: string): D1PreparedStatement {
    const statement = new Statement(query, this);
    this.prepared.push(statement);
    return statement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.batched = statements as Statement[];
    return statements.map(() => ({ success: true }));
  }

  first(statement: Statement): unknown {
    if (statement.query.includes('FROM latest_state')) return this.latest;
    if (statement.query.includes('FROM forecasts')) return this.forecast;
    if (statement.query.includes('SUM(compressed_bytes)')) return { bytes: 0 };
    return null;
  }

  all(statement: Statement): unknown[] {
    if (statement.query.includes('aggregates_daily')) return this.dailyQueryRows;
    if (statement.query.includes('FROM telemetry') || statement.query.includes('aggregates_')) {
      return this.queryRows;
    }
    return [];
  }
}

const now = new Date('2026-08-29T12:00:00Z');
const snapshot = {
  headline: 'Live',
  power: { home_w: 1000, pv_w: 800, battery_w: 100, grid_w: -100, battery_soc_pct: 75 },
  battery: { soc_pct: 75, soh_pct: 100 },
  today: {},
  lifetime: {},
  system: { health: 'healthy' },
  connection: {},
};

describe('dashboard cloud API', () => {
  it('serves the latest scheduled forecast through the command center contract', async () => {
    const database = new Database();
    database.latest = {
      sequence: 1,
      timestamp_ms: now.valueOf(),
      snapshot_json: JSON.stringify(snapshot),
      raw_json: '{}',
    };
    database.forecast = {
      provider: 'Open-Meteo',
      fetched_at: new Date(now.valueOf() - 3_600_000).toISOString(),
      payload_json: JSON.stringify({
        points: [
          { timestamp: '2026-08-29T13:00', irradiance_w_m2: 500, pv_w: 1000 },
          { timestamp: '2026-08-29T14:00', irradiance_w_m2: 700, pv_w: 2000 },
          { timestamp: '2026-08-30T13:00', irradiance_w_m2: 300, pv_w: 500 },
        ],
        weather_days: [
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
        ],
      }),
    };
    const response = await handleDashboardApi(
      new Request('https://dashboard.test/api/v1/command-center?range=24h'),
      { deviceId: 'device', reportingTimezone: 'UTC', now: () => now },
      database,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      forecast: {
        status: string;
        provider: string;
        today_kwh: number;
        tomorrow_kwh: number;
        weather_days: Array<{ day: string; temperature_max_c: number }>;
      };
      live: {
        power_balance: string;
        inverter_utilization_pct: number | null;
        battery_reserve: {
          status: string;
          available_kwh: number | null;
          reserve_margin_pct: number | null;
        };
        energy_mix: {
          home_w: number;
          solar_w: number;
          battery_w: number;
          grid_w: number;
          unaccounted_w: number;
        };
      };
      projection: { status: string; lowest_soc_pct: number | null; points: unknown[] };
    };
    expect(body.forecast).toMatchObject({
      status: 'ready',
      provider: 'Open-Meteo',
      today_kwh: 3,
      tomorrow_kwh: 0.5,
    });
    expect(body.forecast.weather_days).toEqual([
      expect.objectContaining({ day: '2026-08-29', temperature_max_c: 33.5 }),
    ]);
    expect(body.live.energy_mix.grid_w).toBeGreaterThanOrEqual(0);
    expect(
      body.live.energy_mix.solar_w +
        body.live.energy_mix.battery_w +
        body.live.energy_mix.grid_w +
        body.live.energy_mix.unaccounted_w,
    ).toBe(body.live.energy_mix.home_w);
    expect(body.live.power_balance).toBe('balanced');

    database.dailyQueryRows = Array.from({ length: 15 }, (_, index) => ({
      day: `2026-08-${String(index + 1).padStart(2, '0')}`,
      payload_json: JSON.stringify({ sample_count: 8640 }),
    }));
    const configured = await handleDashboardApi(
      new Request('https://dashboard.test/api/v1/command-center?range=24h'),
      {
        deviceId: 'device',
        reportingTimezone: 'UTC',
        batteryCapacityKwh: 10,
        batteryReservePct: 20,
        inverterRatedW: 4000,
        now: () => now,
      },
      database,
    );
    const configuredBody = (await configured.json()) as typeof body;
    expect(configuredBody.live.inverter_utilization_pct).toBe(25);
    expect(configuredBody.live.battery_reserve).toMatchObject({
      status: 'ready',
      available_kwh: 5.5,
      reserve_margin_pct: 55,
    });
    expect(configuredBody.projection.status).toBe('ready');
    expect(configuredBody.projection.points).toHaveLength(3);
    expect(configuredBody.projection.lowest_soc_pct).not.toBeNull();
  });

  it('uses retained 15-minute data for day views older than 30 days', async () => {
    const database = new Database();
    const response = await handleDashboardApi(
      new Request('https://dashboard.test/api/v1/history?period=day&anchor=2026-01-01'),
      { deviceId: 'device', reportingTimezone: 'UTC', now: () => now },
      database,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolution: '15m' });
    expect(database.prepared.some((statement) => statement.query.includes('aggregates_15m'))).toBe(
      true,
    );
  });

  it('matches the desktop reporting-timezone bounds for an anchored day', async () => {
    const database = new Database();
    const response = await handleDashboardApi(
      new Request('https://dashboard.test/api/v1/history?period=day&anchor=2026-08-20'),
      { deviceId: 'device', reportingTimezone: 'Asia/Karachi', now: () => now },
      database,
    );

    expect(await response.json()).toMatchObject({
      start: '2026-08-19T19:00:00.000Z',
      end: '2026-08-20T19:00:00.000Z',
    });
  });

  it('validates command-center ranges before requiring a current snapshot', async () => {
    const response = await handleDashboardApi(
      new Request('https://dashboard.test/api/v1/command-center?range=2h&history=14d'),
      { deviceId: 'device', reportingTimezone: 'UTC', now: () => now },
      new Database(),
    );
    expect(response.status).toBe(422);
  });

  it('preserves the daily CSV export contract and empty-summary availability', async () => {
    const database = new Database();
    database.dailyQueryRows = [
      {
        day: '2026-08-20',
        payload_json: JSON.stringify({
          solar_kwh: 4,
          load_kwh: 3,
          export_kwh: 1,
          import_kwh: 0,
          battery_charge_kwh: 1,
          battery_discharge_kwh: 1,
          peak_pv_w: 2000,
          peak_home_w: 1500,
        }),
      },
    ];
    const exported = await handleDashboardApi(
      new Request(
        'https://dashboard.test/api/v1/export.csv?dataset=daily&period=day&anchor=2026-08-20',
      ),
      { deviceId: 'device', reportingTimezone: 'UTC', now: () => now },
      database,
    );
    expect(exported.headers.get('Content-Disposition')).toBe(
      'attachment; filename="goodwe-home-daily-day.csv"',
    );
    expect(await exported.text()).toMatch(/^day,solar_kwh,load_kwh/);

    database.dailyQueryRows = [];
    const summary = await handleDashboardApi(
      new Request('https://dashboard.test/api/v1/summary?period=month&anchor=1990-01-15'),
      { deviceId: 'device', reportingTimezone: 'UTC', now: () => now },
      database,
    );
    expect(await summary.json()).toMatchObject({ availability_pct: 0 });
  });
});

describe('scheduled retention', () => {
  it('stores a seven-day weather outlook with the scheduled solar forecast', async () => {
    const database = new Database();
    const request = vi.fn(async (input: string | URL | Request) => {
      void input;
      return Response.json({
        hourly: { time: ['2026-08-29T10:00'], shortwave_radiation: [500] },
        daily: {
          time: ['2026-08-29', '2026-08-30'],
          weather_code: [2],
          temperature_2m_max: [33.5],
          temperature_2m_min: [24],
          precipitation_probability_max: [20],
          precipitation_sum: [0.4],
          wind_speed_10m_max: [17],
          sunrise: ['2026-08-29T05:42'],
          sunset: ['2026-08-29T18:31'],
        },
      });
    });
    vi.stubGlobal('fetch', request);
    const env = {
      DB: database,
      ARCHIVES: {} as R2Bucket,
      DEVICE_ID: 'device',
      R2_GUARD_BYTES: '9500000000',
      SITE_LATITUDE: '1',
      SITE_LONGITUDE: '1',
      PV_ARRAY_KWP: '8',
      REPORTING_TIME_ZONE: 'Asia/Karachi',
    } as unknown as WorkerEnv;

    await runScheduledMaintenance(env, now);

    const forecastInsert = database.prepared.find((statement) =>
      statement.query.includes('INSERT INTO forecasts'),
    );
    const payload = JSON.parse(String(forecastInsert?.values[2])) as {
      weather_days: Array<{ day: string; temperature_max_c: number; sunrise: string }>;
    };
    expect(String(request.mock.calls[0]?.[0])).toContain('forecast_days=7');
    expect(String(request.mock.calls[0]?.[0])).toContain('temperature_2m_max');
    expect(payload.weather_days).toEqual([
      expect.objectContaining({
        day: '2026-08-29',
        temperature_max_c: 33.5,
        sunrise: '2026-08-29T00:42:00.000Z',
      }),
      expect.objectContaining({
        day: '2026-08-30',
        weather_code: null,
        temperature_max_c: null,
        precipitation_mm: null,
      }),
    ]);
    vi.unstubAllGlobals();
  });

  it('rolls up only a recent overlap of completed minutes before applying retention cutoffs', async () => {
    const database = new Database();
    const env = {
      DB: database,
      ARCHIVES: {} as R2Bucket,
      DEVICE_ID: 'device',
      R2_GUARD_BYTES: '9500000000',
    } as unknown as WorkerEnv;

    await runScheduledMaintenance(env, now);

    const minute = database.batched.find((statement) =>
      statement.query.includes('INSERT OR REPLACE INTO aggregates_1m'),
    );
    const rawDelete = database.batched.find((statement) =>
      statement.query.includes('DELETE FROM telemetry'),
    );
    expect(minute?.values).toEqual([
      Math.floor(now.valueOf() / 60_000) * 60_000 - 10 * 60_000,
      Math.floor(now.valueOf() / 60_000) * 60_000,
    ]);
    expect(rawDelete?.values[0]).toBe(now.valueOf() - 30 * 86_400_000);
  });
});
