import type { AuthThrottle } from './auth';
import { decodeEtFrames } from './et_decoder';
import type { Gwr1Archive } from './gwr1';
import type { AcceptedBatch, IngestionRepository, SequenceGap } from './ingestion';

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2Object {
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2Object | null>;
}

interface ArchiveRow {
  idempotency_key: string;
  device_id: string;
  first_sequence: number;
  last_sequence: number;
  first_utc_ms: number;
  last_utc_ms: number;
  sample_count: number;
  compressed_bytes: number;
  body_sha256: string;
  archive_key: string;
  decoder_hash: string;
  accepted_at: string;
}

interface GridObservationState {
  candidate_since_ms: number | null;
  candidate_soc_pct: number | null;
  recovery_since_ms: number | null;
  recovery_soc_pct: number | null;
  last_observed_ms: number | null;
  last_soc_pct: number | null;
}

interface GridObservation {
  timestamp: number;
  soc: number;
  available: boolean;
}

function localDay(timestamp: number, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export class CloudflareRepository implements IngestionRepository, AuthThrottle {
  constructor(
    readonly database: D1Database,
    private readonly archives: R2Bucket,
    private readonly now: () => Date = () => new Date(),
    private readonly reportingTimezone = 'UTC',
  ) {}

  async findBatch(idempotencyKey: string): Promise<AcceptedBatch | null> {
    const row = await this.database
      .prepare('SELECT * FROM archive_index WHERE idempotency_key = ?1')
      .bind(idempotencyKey)
      .first<ArchiveRow>();
    return row
      ? {
          idempotencyKey: row.idempotency_key,
          deviceId: row.device_id,
          firstSequence: BigInt(row.first_sequence),
          lastSequence: BigInt(row.last_sequence),
          firstUtcMs: BigInt(row.first_utc_ms),
          lastUtcMs: BigInt(row.last_utc_ms),
          sampleCount: row.sample_count,
          compressedBytes: row.compressed_bytes,
          bodySha256: row.body_sha256,
          archiveKey: row.archive_key,
          decoderHash: row.decoder_hash,
          acceptedAt: row.accepted_at,
        }
      : null;
  }

  async putArchive(key: string, body: Uint8Array, metadata: Record<string, string>): Promise<void> {
    await this.archives.put(key, body, {
      customMetadata: metadata,
      httpMetadata: { contentType: 'application/octet-stream' },
    });
  }

  async verifyArchive(key: string, bodySha256: string): Promise<boolean> {
    const object = await this.archives.get(key);
    if (!object || object.customMetadata?.bodySha256 !== bodySha256) return false;
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', await object.arrayBuffer()),
    );
    const actual = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
    return actual === bodySha256;
  }

  async commitBatch(
    batch: AcceptedBatch,
    archive: Gwr1Archive,
    gaps: SequenceGap[],
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    const previousLatest = await this.database
      .prepare('SELECT snapshot_json FROM latest_state WHERE device_id = ?1')
      .bind(batch.deviceId)
      .first<{ snapshot_json: string }>();
    const gridState =
      (await this.database
        .prepare('SELECT * FROM grid_observation_state WHERE device_id = ?1')
        .bind(batch.deviceId)
        .first<GridObservationState>()) ??
      ({
        candidate_since_ms: null,
        candidate_soc_pct: null,
        recovery_since_ms: null,
        recovery_soc_pct: null,
        last_observed_ms: null,
        last_soc_pct: null,
      } satisfies GridObservationState);
    let outageOpen = Boolean(
      await this.database
        .prepare('SELECT id FROM outages WHERE device_id = ?1 AND end_at IS NULL LIMIT 1')
        .bind(batch.deviceId)
        .first<{ id: number }>(),
    );
    const observations: GridObservation[] = [];
    let latestSnapshot = '';
    let latestRaw = '';
    let latestTimestamp = Number(batch.firstUtcMs);
    let latestSequence = Number(batch.firstSequence);
    for (const sample of archive.samples) {
      const timestamp = Number(archive.firstUtcMs) + sample.timestampDeltaMs;
      const sequence = Number(archive.firstSequence) + sample.sequenceDelta;
      const decoded = decodeEtFrames(
        sample.frames[0],
        sample.frames[1],
        sample.frames[2],
        timestamp,
      );
      latestSnapshot = JSON.stringify(decoded.snapshot);
      latestRaw = JSON.stringify(decoded.raw);
      const grid = decoded.snapshot.grid as Record<string, unknown>;
      const power = decoded.snapshot.power;
      const gridMode = String(grid.grid_mode ?? '').toLowerCase();
      observations.push({
        timestamp,
        soc: Number(power.battery_soc_pct),
        available:
          Number(grid.voltage_v) >= 180 &&
          Number(grid.frequency_hz) >= 45 &&
          Number(grid.frequency_hz) <= 55 &&
          !gridMode.includes('not connected') &&
          !gridMode.includes('off grid'),
      });
      latestTimestamp = timestamp;
      latestSequence = sequence;
      const today = decoded.snapshot.today as Record<string, number>;
      statements.push(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO telemetry (
              device_id, sequence, timestamp_ms, timestamp_source, flags, reporting_day,
              pv_w, home_w, grid_w, battery_w, backup_w, battery_soc_pct,
              grid_voltage_v, grid_frequency_hz, inverter_temperature_c,
              solar_day_kwh, load_day_kwh, export_day_kwh, import_day_kwh,
              battery_charge_day_kwh, battery_discharge_day_kwh, snapshot_json, raw_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
          )
          .bind(
            batch.deviceId,
            sequence,
            timestamp,
            sample.timestampSource,
            sample.statusFlags,
            localDay(timestamp, this.reportingTimezone),
            power.pv_w,
            power.home_w,
            power.grid_w,
            power.battery_w,
            power.backup_w,
            power.battery_soc_pct,
            decoded.history.grid_voltage_v,
            decoded.history.grid_frequency_hz,
            decoded.history.inverter_temperature_c,
            today.solar_kwh,
            today.load_kwh,
            today.export_kwh,
            today.import_kwh,
            today.battery_charge_kwh,
            today.battery_discharge_kwh,
            latestSnapshot,
            latestRaw,
          ),
      );
    }
    statements.push(
      this.database
        .prepare(
          `INSERT INTO archive_index VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .bind(
          batch.idempotencyKey,
          batch.deviceId,
          Number(batch.firstSequence),
          Number(batch.lastSequence),
          Number(batch.firstUtcMs),
          Number(batch.lastUtcMs),
          batch.sampleCount,
          batch.compressedBytes,
          batch.bodySha256,
          batch.archiveKey,
          batch.decoderHash,
          batch.acceptedAt,
        ),
      this.database
        .prepare(
          `INSERT INTO latest_state VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(device_id) DO UPDATE SET
             sequence = excluded.sequence, timestamp_ms = excluded.timestamp_ms,
             snapshot_json = excluded.snapshot_json, raw_json = excluded.raw_json
           WHERE excluded.sequence > latest_state.sequence`,
        )
        .bind(batch.deviceId, latestSequence, latestTimestamp, latestSnapshot, latestRaw),
      this.database
        .prepare(
          `INSERT INTO ingestion_status
             (device_id, latest_sequence, latest_timestamp_ms, total_compressed_bytes,
              r2_write_count, d1_write_count, updated_at)
           SELECT ?1, ?2, ?3,
                  COALESCE((SELECT SUM(compressed_bytes) FROM archive_index WHERE device_id = ?1), 0),
                  (SELECT COUNT(*) FROM archive_index WHERE device_id = ?1),
                  (SELECT COUNT(*) FROM telemetry WHERE device_id = ?1) +
                    (SELECT COUNT(*) FROM archive_index WHERE device_id = ?1),
                  ?4
           ON CONFLICT(device_id) DO UPDATE SET
             latest_sequence = MAX(latest_sequence, excluded.latest_sequence),
             latest_timestamp_ms = MAX(latest_timestamp_ms, excluded.latest_timestamp_ms),
             total_compressed_bytes = excluded.total_compressed_bytes,
             r2_write_count = excluded.r2_write_count,
             d1_write_count = excluded.d1_write_count,
             updated_at = excluded.updated_at`,
        )
        .bind(batch.deviceId, latestSequence, latestTimestamp, batch.acceptedAt),
    );
    for (const gap of gaps) {
      const detectedAt = this.now().toISOString();
      statements.push(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO gaps
             (device_id, first_missing_sequence, next_received_sequence, detected_at)
             VALUES (?1, ?2, ?3, ?4)`,
          )
          .bind(batch.deviceId, Number(gap.expected), Number(gap.received), detectedAt),
        this.database
          .prepare(
            `INSERT INTO events
             (device_id, created_at, severity, event_type, message, details_json)
             VALUES (?1, ?2, 'warning', 'sequence_gap', ?3, ?4)`,
          )
          .bind(
            batch.deviceId,
            detectedAt,
            `Collector sequence gap ${gap.expected}–${gap.received - 1n} was recorded.`,
            JSON.stringify({
              first_missing_sequence: gap.expected.toString(),
              next_received_sequence: gap.received.toString(),
            }),
          ),
      );
    }
    if (
      observations.length > 0 &&
      gridState.last_observed_ms !== null &&
      observations[0].timestamp - gridState.last_observed_ms > 30_000
    ) {
      gridState.candidate_since_ms = null;
      gridState.candidate_soc_pct = null;
      gridState.recovery_since_ms = null;
      gridState.recovery_soc_pct = null;
      if (outageOpen) {
        const endedAt = new Date(gridState.last_observed_ms).toISOString();
        statements.push(
          this.database
            .prepare(
              `UPDATE outages SET end_at = ?1, end_soc_pct = ?2
               WHERE device_id = ?3 AND end_at IS NULL`,
            )
            .bind(endedAt, gridState.last_soc_pct, batch.deviceId),
          this.database
            .prepare(
              `INSERT INTO events
               (device_id, created_at, severity, event_type, message, details_json)
               VALUES (?1, ?2, 'warning', 'outage_observation_ended', ?3, ?4)`,
            )
            .bind(
              batch.deviceId,
              endedAt,
              'An open grid outage observation ended when telemetry was interrupted.',
              JSON.stringify({ reason: 'telemetry_gap' }),
            ),
        );
        outageOpen = false;
      }
    }
    for (const observation of observations) {
      if (!observation.available) {
        gridState.recovery_since_ms = null;
        gridState.recovery_soc_pct = null;
        if (!outageOpen && gridState.candidate_since_ms === null) {
          gridState.candidate_since_ms = observation.timestamp;
          gridState.candidate_soc_pct = observation.soc;
        } else if (
          !outageOpen &&
          gridState.candidate_since_ms !== null &&
          observation.timestamp - gridState.candidate_since_ms >= 30_000
        ) {
          const startedAt = new Date(gridState.candidate_since_ms).toISOString();
          statements.push(
            this.database
              .prepare(
                `INSERT INTO outages
                 (device_id, start_at, end_at, start_soc_pct, end_soc_pct, confidence)
                 VALUES (?1, ?2, NULL, ?3, NULL, 1)`,
              )
              .bind(batch.deviceId, startedAt, gridState.candidate_soc_pct),
            this.database
              .prepare(
                `INSERT INTO events
                 (device_id, created_at, severity, event_type, message, details_json)
                 VALUES (?1, ?2, 'warning', 'grid_outage_started', ?3, ?4)`,
              )
              .bind(
                batch.deviceId,
                startedAt,
                'Grid loss remained present for 30 seconds.',
                JSON.stringify({ start_soc_pct: gridState.candidate_soc_pct }),
              ),
          );
          outageOpen = true;
          gridState.candidate_since_ms = null;
          gridState.candidate_soc_pct = null;
        }
      } else {
        gridState.candidate_since_ms = null;
        gridState.candidate_soc_pct = null;
        if (outageOpen && gridState.recovery_since_ms === null) {
          gridState.recovery_since_ms = observation.timestamp;
          gridState.recovery_soc_pct = observation.soc;
        } else if (
          outageOpen &&
          gridState.recovery_since_ms !== null &&
          observation.timestamp - gridState.recovery_since_ms >= 30_000
        ) {
          const endedAt = new Date(gridState.recovery_since_ms).toISOString();
          statements.push(
            this.database
              .prepare(
                `UPDATE outages SET end_at = ?1, end_soc_pct = ?2
                 WHERE device_id = ?3 AND end_at IS NULL`,
              )
              .bind(endedAt, gridState.recovery_soc_pct, batch.deviceId),
            this.database
              .prepare(
                `INSERT INTO events
                 (device_id, created_at, severity, event_type, message, details_json)
                 VALUES (?1, ?2, 'info', 'grid_outage_ended', ?3, ?4)`,
              )
              .bind(
                batch.deviceId,
                endedAt,
                'Grid recovery remained present for 30 seconds.',
                JSON.stringify({ end_soc_pct: gridState.recovery_soc_pct }),
              ),
          );
          outageOpen = false;
          gridState.recovery_since_ms = null;
          gridState.recovery_soc_pct = null;
        }
      }
      gridState.last_observed_ms = observation.timestamp;
      gridState.last_soc_pct = observation.soc;
    }
    statements.push(
      this.database
        .prepare(
          `INSERT INTO grid_observation_state VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(device_id) DO UPDATE SET
             candidate_since_ms = excluded.candidate_since_ms,
             candidate_soc_pct = excluded.candidate_soc_pct,
             recovery_since_ms = excluded.recovery_since_ms,
             recovery_soc_pct = excluded.recovery_soc_pct,
             last_observed_ms = excluded.last_observed_ms,
             last_soc_pct = excluded.last_soc_pct`,
        )
        .bind(
          batch.deviceId,
          gridState.candidate_since_ms,
          gridState.candidate_soc_pct,
          gridState.recovery_since_ms,
          gridState.recovery_soc_pct,
          gridState.last_observed_ms,
          gridState.last_soc_pct,
        ),
    );
    const previousHealth = previousLatest
      ? String(
          (
            JSON.parse(previousLatest.snapshot_json) as {
              system?: { health?: string };
            }
          ).system?.health ?? 'unknown',
        )
      : 'unknown';
    const currentHealth = String(
      (JSON.parse(latestSnapshot) as { system?: { health?: string } }).system?.health ?? 'unknown',
    );
    if (previousHealth !== currentHealth) {
      const severity =
        currentHealth === 'error' ? 'error' : currentHealth === 'warning' ? 'warning' : 'info';
      statements.push(
        this.database
          .prepare(
            `INSERT INTO events
             (device_id, created_at, severity, event_type, message, details_json)
             VALUES (?1, ?2, ?3, 'health_transition', ?4, ?5)`,
          )
          .bind(
            batch.deviceId,
            new Date(latestTimestamp).toISOString(),
            severity,
            `Inverter health changed from ${previousHealth} to ${currentHealth}.`,
            JSON.stringify({ previous: previousHealth, current: currentHealth }),
          ),
      );
    }
    await this.database.batch(statements);
  }

  async latestSequence(deviceId: string): Promise<bigint | null> {
    const row = await this.database
      .prepare('SELECT latest_sequence AS sequence FROM ingestion_status WHERE device_id = ?1')
      .bind(deviceId)
      .first<{ sequence: number }>();
    return row ? BigInt(row.sequence) : null;
  }

  async totalStoredBytes(): Promise<number> {
    const row = await this.database
      .prepare('SELECT COALESCE(SUM(compressed_bytes), 0) AS bytes FROM archive_index')
      .first<{ bytes: number }>();
    return row?.bytes ?? 0;
  }

  async failedAttempts(key: string, sinceMs: number): Promise<number> {
    const row = await this.database
      .prepare(
        'SELECT COUNT(*) AS attempts FROM auth_failures WHERE client_key = ?1 AND attempted_at_ms >= ?2',
      )
      .bind(key, sinceMs)
      .first<{ attempts: number }>();
    return row?.attempts ?? 0;
  }

  async recordFailure(key: string, atMs: number): Promise<void> {
    await this.database
      .prepare('INSERT INTO auth_failures (client_key, attempted_at_ms) VALUES (?1, ?2)')
      .bind(key, atMs)
      .run();
  }

  async clearFailures(key: string): Promise<void> {
    await this.database.prepare('DELETE FROM auth_failures WHERE client_key = ?1').bind(key).run();
  }
}
