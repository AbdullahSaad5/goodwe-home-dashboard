#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${name ?? 'end of command'}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function sqlText(value) {
  return `'${String(value).replaceAll('\0', '\ufffd').replaceAll("'", "''")}'`;
}

function sqlNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : String(fallback);
}

function sqlOptionalNumber(value) {
  return value === null || value === undefined ? 'NULL' : sqlNumber(value);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const dayFormatters = new Map();
function reportingDay(timestampMs, timezone) {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function severity(value) {
  return ['info', 'warning', 'error'].includes(value) ? value : 'info';
}

function writeStatement(file, statement) {
  writeSync(file, `${statement.trim()}\n`);
}

function telemetryTuple(row, deviceId) {
  const timestampMs = Math.round(Number(row.collected_ts) * 1000);
  const snapshot = parseObject(row.snapshot_json);
  const power = snapshot.power ?? {};
  const today = snapshot.today ?? {};
  const timezone = snapshot.connection?.reporting_timezone ?? 'UTC';
  return `(${[
    sqlText(deviceId),
    String(-timestampMs),
    String(timestampMs),
    '2',
    '0',
    sqlText(reportingDay(timestampMs, timezone)),
    sqlNumber(row.pv_w ?? power.pv_w),
    sqlNumber(row.home_w ?? power.home_w),
    sqlNumber(row.grid_w ?? power.grid_w),
    sqlNumber(row.battery_w ?? power.battery_w),
    sqlNumber(row.backup_w ?? power.backup_w),
    sqlNumber(row.battery_soc_pct ?? power.battery_soc_pct),
    sqlNumber(row.grid_voltage_v),
    sqlNumber(row.grid_frequency_hz),
    sqlNumber(row.inverter_temperature_c),
    sqlNumber(today.solar_kwh),
    sqlNumber(today.load_kwh),
    sqlNumber(today.export_kwh),
    sqlNumber(today.import_kwh),
    sqlNumber(today.battery_charge_kwh),
    sqlNumber(today.battery_discharge_kwh),
    sqlText(row.snapshot_json),
    sqlText(row.raw_json ?? '{}'),
  ].join(',')})`;
}

function rollupStatements(deviceId, firstTimestampMs, beforeMs) {
  const device = sqlText(deviceId);
  const range = `device_id = ${device} AND timestamp_ms >= ${firstTimestampMs} AND timestamp_ms < ${beforeMs}`;
  return [
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
     FROM telemetry WHERE ${range}
     GROUP BY device_id, CAST(timestamp_ms / 60000 AS INTEGER);`,
    `INSERT OR REPLACE INTO aggregates_15m (device_id, bucket_ms, sample_count, payload_json)
     SELECT device_id, CAST(bucket_ms / 900000 AS INTEGER) * 900000, SUM(sample_count),
            json_object('pv_w', AVG(json_extract(payload_json, '$.pv_w')),
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
     FROM aggregates_1m
     WHERE device_id = ${device} AND bucket_ms >= ${firstTimestampMs} AND bucket_ms < ${beforeMs}
     GROUP BY device_id, CAST(bucket_ms / 900000 AS INTEGER);`,
    `INSERT OR REPLACE INTO aggregates_daily (device_id, day, payload_json)
     SELECT device_id, reporting_day,
            json_object('sample_count', COUNT(*), 'solar_kwh', MAX(solar_day_kwh),
                        'load_kwh', MAX(load_day_kwh), 'export_kwh', MAX(export_day_kwh),
                        'import_kwh', MAX(import_day_kwh),
                        'battery_charge_kwh', MAX(battery_charge_day_kwh),
                        'battery_discharge_kwh', MAX(battery_discharge_day_kwh),
                        'peak_pv_w', MAX(pv_w), 'peak_home_w', MAX(home_w))
     FROM telemetry WHERE ${range}
     GROUP BY device_id, reporting_day;`,
  ];
}

function main() {
  const values = argumentsFrom(process.argv.slice(2));
  const source = resolve(required(values, 'source'));
  const output = resolve(required(values, 'output'));
  const identity = parseObject(readFileSync(resolve(required(values, 'identity')), 'utf8'));
  const deviceId = identity.device_id ?? identity.DEVICE_ID;
  const beforeMs = Number(required(values, 'before-ms'));
  if (!deviceId || !Number.isSafeInteger(beforeMs) || beforeMs <= 0) {
    throw new Error('The identity or --before-ms cutoff is invalid');
  }

  const database = new DatabaseSync(source, { readOnly: true });
  const file = openSync(output, 'wx', 0o600);
  const counts = { telemetry: 0, events: 0, outages: 0, forecasts: 0 };
  let firstTimestampMs = beforeMs;
  try {
    writeStatement(file, 'PRAGMA defer_foreign_keys = TRUE;');
    const telemetryColumns = `device_id, sequence, timestamp_ms, timestamp_source, flags,
      reporting_day, pv_w, home_w, grid_w, battery_w, backup_w, battery_soc_pct,
      grid_voltage_v, grid_frequency_hz, inverter_temperature_c, solar_day_kwh, load_day_kwh,
      export_day_kwh, import_day_kwh, battery_charge_day_kwh, battery_discharge_day_kwh,
      snapshot_json, raw_json`;
    const tuples = [];
    const flushTelemetry = () => {
      if (!tuples.length) return;
      writeStatement(
        file,
        `INSERT OR IGNORE INTO telemetry (${telemetryColumns}) VALUES\n${tuples.join(',\n')};`,
      );
      tuples.length = 0;
    };
    const samples = database.prepare(
      `SELECT * FROM samples WHERE collected_ts * 1000 < ? ORDER BY collected_ts`,
    );
    for (const row of samples.iterate(beforeMs)) {
      const timestampMs = Math.round(Number(row.collected_ts) * 1000);
      firstTimestampMs = Math.min(firstTimestampMs, timestampMs);
      tuples.push(telemetryTuple(row, deviceId));
      counts.telemetry += 1;
      if (tuples.length === 20) flushTelemetry();
    }
    flushTelemetry();

    for (const statement of rollupStatements(deviceId, firstTimestampMs, beforeMs)) {
      writeStatement(file, statement);
    }

    const events = database.prepare(
      'SELECT * FROM events WHERE created_ts * 1000 < ? ORDER BY created_ts, id',
    );
    for (const row of events.iterate(beforeMs)) {
      const createdAt = new Date(Number(row.created_ts) * 1000).toISOString();
      writeStatement(
        file,
        `INSERT INTO events (device_id, created_at, severity, event_type, message, details_json)
         SELECT ${sqlText(deviceId)}, ${sqlText(createdAt)}, ${sqlText(severity(row.severity))},
                ${sqlText(row.event_type)}, ${sqlText(row.message)}, ${sqlText(row.details_json ?? '{}')}
         WHERE NOT EXISTS (SELECT 1 FROM events WHERE device_id = ${sqlText(deviceId)}
           AND created_at = ${sqlText(createdAt)} AND event_type = ${sqlText(row.event_type)}
           AND message = ${sqlText(row.message)});`,
      );
      counts.events += 1;
    }

    const outages = database.prepare(
      'SELECT * FROM outages WHERE start_ts * 1000 < ? ORDER BY start_ts',
    );
    for (const row of outages.iterate(beforeMs)) {
      writeStatement(
        file,
        `INSERT INTO outages (device_id, start_at, end_at, start_soc_pct, end_soc_pct, confidence)
         SELECT ${sqlText(deviceId)}, ${sqlText(row.start_at)}, ${row.end_at ? sqlText(row.end_at) : 'NULL'},
                ${sqlOptionalNumber(row.start_soc_pct)}, ${sqlOptionalNumber(row.end_soc_pct)}, ${sqlNumber(row.confidence, 1)}
         WHERE NOT EXISTS (SELECT 1 FROM outages WHERE device_id = ${sqlText(deviceId)}
           AND start_at = ${sqlText(row.start_at)});`,
      );
      counts.outages += 1;
    }

    const forecasts = database.prepare(
      'SELECT * FROM forecast_runs WHERE issued_ts * 1000 < ? ORDER BY issued_ts',
    );
    for (const row of forecasts.iterate(beforeMs)) {
      const payload = JSON.stringify({
        points: JSON.parse(row.points_json),
        metadata: parseObject(row.metadata_json),
      });
      writeStatement(
        file,
        `INSERT OR IGNORE INTO forecasts (forecast_at_ms, provider, fetched_at, payload_json)
         VALUES (${Math.round(Number(row.issued_ts) * 1000)}, ${sqlText(row.provider)},
                 ${sqlText(row.issued_at)}, ${sqlText(payload)});`,
      );
      counts.forecasts += 1;
    }
    fsyncSync(file);
  } finally {
    closeSync(file);
    database.close();
  }
  console.log(JSON.stringify({ ...counts, bytes: statSync(output).size }));
}

main();
