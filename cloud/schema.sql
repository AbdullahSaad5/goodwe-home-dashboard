PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_index (
  idempotency_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  first_utc_ms INTEGER NOT NULL,
  last_utc_ms INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL UNIQUE,
  decoder_hash TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_device_sequence ON archive_index(device_id, last_sequence DESC);

CREATE TABLE IF NOT EXISTS telemetry (
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  timestamp_source INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  reporting_day TEXT NOT NULL,
  pv_w REAL NOT NULL,
  home_w REAL NOT NULL,
  grid_w REAL NOT NULL,
  battery_w REAL NOT NULL,
  backup_w REAL NOT NULL,
  battery_soc_pct REAL NOT NULL,
  grid_voltage_v REAL NOT NULL,
  grid_frequency_hz REAL NOT NULL,
  inverter_temperature_c REAL NOT NULL,
  solar_day_kwh REAL NOT NULL,
  load_day_kwh REAL NOT NULL,
  export_day_kwh REAL NOT NULL,
  import_day_kwh REAL NOT NULL,
  battery_charge_day_kwh REAL NOT NULL,
  battery_discharge_day_kwh REAL NOT NULL,
  snapshot_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(device_id, sequence)
);
CREATE INDEX IF NOT EXISTS telemetry_device_time ON telemetry(device_id, timestamp_ms);

CREATE TABLE IF NOT EXISTS latest_state (
  device_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  first_missing_sequence INTEGER NOT NULL,
  next_received_sequence INTEGER NOT NULL,
  detected_at TEXT NOT NULL,
  UNIQUE(device_id, first_missing_sequence, next_received_sequence)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'error')),
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS ingestion_status (
  device_id TEXT PRIMARY KEY,
  latest_sequence INTEGER NOT NULL,
  latest_timestamp_ms INTEGER NOT NULL,
  total_compressed_bytes INTEGER NOT NULL,
  r2_write_count INTEGER NOT NULL,
  d1_write_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_key TEXT NOT NULL,
  attempted_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_window ON auth_failures(client_key, attempted_at_ms);

CREATE TABLE IF NOT EXISTS aggregates_1m (
  device_id TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(device_id, bucket_ms)
);
CREATE TABLE IF NOT EXISTS aggregates_15m (
  device_id TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(device_id, bucket_ms)
);
CREATE TABLE IF NOT EXISTS aggregates_daily (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(device_id, day)
);
CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  start_soc_pct REAL,
  end_soc_pct REAL,
  confidence REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS grid_observation_state (
  device_id TEXT PRIMARY KEY,
  candidate_since_ms INTEGER,
  candidate_soc_pct REAL,
  recovery_since_ms INTEGER,
  recovery_soc_pct REAL,
  last_observed_ms INTEGER,
  last_soc_pct REAL
);
CREATE TABLE IF NOT EXISTS forecasts (
  forecast_at_ms INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decoder_manifests (
  decoder_hash TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
