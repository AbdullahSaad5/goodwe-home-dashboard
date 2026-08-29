import type { WorkerEnv } from './env';

async function refreshForecast(env: WorkerEnv, now: Date): Promise<void> {
  if (!env.SITE_LATITUDE || !env.SITE_LONGITUDE) return;
  const previous = await env.DB.prepare(
    'SELECT fetched_at FROM forecasts ORDER BY forecast_at_ms DESC LIMIT 1',
  ).first<{ fetched_at: string }>();
  if (previous && now.valueOf() - Date.parse(previous.fetched_at) < 3 * 3_600_000) return;
  const tilted = env.PV_TILT_DEG !== undefined && env.PV_AZIMUTH_DEG !== undefined;
  const variable = tilted ? 'global_tilted_irradiance' : 'shortwave_radiation';
  const query = new URLSearchParams({
    latitude: env.SITE_LATITUDE,
    longitude: env.SITE_LONGITUDE,
    hourly: variable,
    forecast_days: '3',
    timezone: 'UTC',
  });
  if (tilted) {
    query.set('tilt', env.PV_TILT_DEG!);
    query.set('azimuth', env.PV_AZIMUTH_DEG!);
  }
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`);
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
  const forecast = (await response.json()) as {
    hourly?: { time?: string[]; [key: string]: number[] | string[] | undefined };
  };
  const times = forecast.hourly?.time ?? [];
  const radiation = (forecast.hourly?.[variable] as number[] | undefined) ?? [];
  const capacityWatts = env.PV_ARRAY_KWP ? Number(env.PV_ARRAY_KWP) * 1000 : null;
  const points = times.map((timestamp, index) => ({
    timestamp,
    irradiance_w_m2: radiation[index] ?? 0,
    pv_w:
      capacityWatts === null
        ? null
        : Math.max(
            0,
            Math.min(capacityWatts, ((radiation[index] ?? 0) / 1000) * capacityWatts * 0.8),
          ),
  }));
  await env.DB.prepare(
    `INSERT INTO forecasts (forecast_at_ms, provider, fetched_at, payload_json)
       VALUES (?1, 'Open-Meteo', ?2, ?3)
       ON CONFLICT(forecast_at_ms) DO UPDATE SET fetched_at = excluded.fetched_at, payload_json = excluded.payload_json`,
  )
    .bind(now.valueOf(), now.toISOString(), JSON.stringify({ points, variable }))
    .run();
}

async function rollupAndRetain(env: WorkerEnv, now: Date): Promise<void> {
  const rawRetentionCutoff = now.valueOf() - 30 * 86_400_000;
  const oneMinuteRetentionCutoff = now.valueOf() - 365 * 86_400_000;
  const completeMinuteCutoff = Math.floor(now.valueOf() / 60_000) * 60_000;
  const completeFifteenMinuteCutoff = Math.floor(now.valueOf() / 900_000) * 900_000;
  const minuteOverlapStart = completeMinuteCutoff - 10 * 60_000;
  const fifteenMinuteOverlapStart = completeFifteenMinuteCutoff - 30 * 60_000;
  const dailyOverlapStart = now.valueOf() - 3 * 86_400_000;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO aggregates_1m (device_id, bucket_ms, sample_count, payload_json)
       SELECT device_id, CAST(timestamp_ms / 60000 AS INTEGER) * 60000, COUNT(*),
              json_object('pv_w', AVG(pv_w), 'home_w', AVG(home_w), 'grid_w', AVG(grid_w),
                          'battery_w', AVG(battery_w), 'backup_w', AVG(backup_w),
                          'battery_soc_pct', AVG(battery_soc_pct),
                          'grid_voltage_v', AVG(grid_voltage_v),
                          'grid_frequency_hz', AVG(grid_frequency_hz),
                          'inverter_temperature_c', AVG(inverter_temperature_c),
                          'solar_day_kwh', MAX(solar_day_kwh), 'load_day_kwh', MAX(load_day_kwh),
                          'export_day_kwh', MAX(export_day_kwh), 'import_day_kwh', MAX(import_day_kwh),
                          'battery_charge_day_kwh', MAX(battery_charge_day_kwh),
                          'battery_discharge_day_kwh', MAX(battery_discharge_day_kwh))
       FROM telemetry WHERE timestamp_ms >= ?1 AND timestamp_ms < ?2
       GROUP BY device_id, CAST(timestamp_ms / 60000 AS INTEGER)`,
    ).bind(minuteOverlapStart, completeMinuteCutoff),
    env.DB.prepare(
      `INSERT OR REPLACE INTO aggregates_15m (device_id, bucket_ms, sample_count, payload_json)
       SELECT device_id, CAST(bucket_ms / 900000 AS INTEGER) * 900000, SUM(sample_count),
              json_object(
                'pv_w', AVG(json_extract(payload_json, '$.pv_w')),
                'home_w', AVG(json_extract(payload_json, '$.home_w')),
                'grid_w', AVG(json_extract(payload_json, '$.grid_w')),
                'battery_w', AVG(json_extract(payload_json, '$.battery_w')),
                'backup_w', AVG(json_extract(payload_json, '$.backup_w')),
                'battery_soc_pct', AVG(json_extract(payload_json, '$.battery_soc_pct')),
                'grid_voltage_v', AVG(json_extract(payload_json, '$.grid_voltage_v')),
                'grid_frequency_hz', AVG(json_extract(payload_json, '$.grid_frequency_hz')),
                'inverter_temperature_c', AVG(json_extract(payload_json, '$.inverter_temperature_c')),
                'solar_day_kwh', MAX(json_extract(payload_json, '$.solar_day_kwh')),
                'load_day_kwh', MAX(json_extract(payload_json, '$.load_day_kwh')),
                'export_day_kwh', MAX(json_extract(payload_json, '$.export_day_kwh')),
                'import_day_kwh', MAX(json_extract(payload_json, '$.import_day_kwh')),
                'battery_charge_day_kwh', MAX(json_extract(payload_json, '$.battery_charge_day_kwh')),
                'battery_discharge_day_kwh', MAX(json_extract(payload_json, '$.battery_discharge_day_kwh')))
       FROM aggregates_1m WHERE bucket_ms >= ?1 AND bucket_ms < ?2
       GROUP BY device_id, CAST(bucket_ms / 900000 AS INTEGER)`,
    ).bind(fifteenMinuteOverlapStart, completeFifteenMinuteCutoff),
    env.DB.prepare(
      `INSERT OR REPLACE INTO aggregates_daily (device_id, day, payload_json)
       SELECT device_id, reporting_day,
              json_object(
                'sample_count', COUNT(*),
                'solar_kwh', MAX(solar_day_kwh),
                'load_kwh', MAX(load_day_kwh),
                'export_kwh', MAX(export_day_kwh),
                'import_kwh', MAX(import_day_kwh),
                'battery_charge_kwh', MAX(battery_charge_day_kwh),
                'battery_discharge_kwh', MAX(battery_discharge_day_kwh),
                'peak_pv_w', MAX(pv_w),
                'peak_home_w', MAX(home_w))
       FROM telemetry WHERE timestamp_ms >= ?1 AND timestamp_ms < ?2
       GROUP BY device_id, reporting_day`,
    ).bind(dailyOverlapStart, completeMinuteCutoff),
    env.DB.prepare('DELETE FROM telemetry WHERE timestamp_ms < ?1').bind(rawRetentionCutoff),
    env.DB.prepare('DELETE FROM aggregates_1m WHERE bucket_ms < ?1').bind(oneMinuteRetentionCutoff),
    env.DB.prepare('DELETE FROM auth_failures WHERE attempted_at_ms < ?1').bind(
      now.valueOf() - 86_400_000,
    ),
  ]);
}

async function recordQuotaWarnings(env: WorkerEnv, now: Date): Promise<void> {
  const status = await env.DB.prepare(
    'SELECT COALESCE(SUM(compressed_bytes), 0) AS bytes FROM archive_index',
  ).first<{ bytes: number }>();
  const guard = Number(env.R2_GUARD_BYTES);
  const usage = guard > 0 ? (status?.bytes ?? 0) / guard : 0;
  const threshold = usage >= 0.85 ? 85 : usage >= 0.75 ? 75 : usage >= 0.5 ? 50 : 0;
  if (!threshold) return;
  const eventType = `r2_quota_${threshold}`;
  const existing = await env.DB.prepare(
    'SELECT id FROM events WHERE device_id = ?1 AND event_type = ?2 LIMIT 1',
  )
    .bind(env.DEVICE_ID, eventType)
    .first<{ id: number }>();
  if (existing) return;
  await env.DB.prepare(
    `INSERT INTO events (device_id, created_at, severity, event_type, message, details_json)
       VALUES (?1, ?2, 'warning', ?3, ?4, ?5)`,
  )
    .bind(
      env.DEVICE_ID,
      now.toISOString(),
      eventType,
      `Raw archive storage has reached ${threshold}% of its zero-cost guard.`,
      JSON.stringify({ threshold, guard_bytes: guard }),
    )
    .run();
}

export async function runScheduledMaintenance(env: WorkerEnv, now: Date): Promise<void> {
  const results = await Promise.allSettled([
    refreshForecast(env, now),
    rollupAndRetain(env, now),
    recordQuotaWarnings(env, now),
  ]);
  const maintenanceErrors = results.filter((result) => result.status === 'rejected');
  if (maintenanceErrors.length === results.length)
    throw new Error('All scheduled maintenance tasks failed');
}
