import { describe, expect, it } from 'vitest';
import {
  CloudflareRepository,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
  type R2Bucket,
} from '../src/cloudflare';
import type { Gwr1Archive } from '../src/gwr1';
import type { AcceptedBatch } from '../src/ingestion';

class Statement implements D1PreparedStatement {
  values: unknown[] = [];

  constructor(readonly query: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return null;
  }

  async run(): Promise<D1Result> {
    return { success: true };
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] };
  }
}

class Database implements D1Database {
  batched: Statement[] = [];

  prepare(query: string): D1PreparedStatement {
    return new Statement(query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.batched = statements as Statement[];
    return this.batched.map(() => ({ success: true }));
  }
}

function frame(transaction: number, byteCount: number): Uint8Array {
  const value = new Uint8Array(9 + byteCount);
  const view = new DataView(value.buffer);
  view.setUint16(0, transaction);
  view.setUint16(2, 0);
  view.setUint16(4, byteCount + 3);
  value[6] = 0xf7;
  value[7] = 3;
  value[8] = byteCount;
  return value;
}

describe('Cloudflare persistence transaction', () => {
  it('commits telemetry, gaps, outage transitions, and events in one D1 batch', async () => {
    const database = new Database();
    const repository = new CloudflareRepository(
      database,
      {} as R2Bucket,
      () => new Date('2026-08-29T01:01:00Z'),
      'America/Toronto',
    );
    const firstUtcMs = BigInt(Date.parse('2026-08-29T01:00:00Z'));
    const frames = [frame(1, 250), frame(2, 48), frame(3, 90)];
    const archive: Gwr1Archive = {
      deviceId: new Uint8Array(16),
      inverterFamily: 1,
      transport: 1,
      decoderHash: new Uint8Array(32),
      firmwareVersion: 'test',
      firstUtcMs,
      firstSequence: 10n,
      expectedIntervalMs: 10_000,
      samples: [0, 10_000, 20_000, 30_000].map((timestampDeltaMs, index) => ({
        timestampDeltaMs,
        sequenceDelta: index,
        statusFlags: 0,
        timestampSource: 1,
        frames,
      })),
    };
    const batch: AcceptedBatch = {
      idempotencyKey: 'device:10:13',
      deviceId: 'device',
      firstSequence: 10n,
      lastSequence: 13n,
      firstUtcMs,
      lastUtcMs: firstUtcMs + 30_000n,
      sampleCount: 4,
      compressedBytes: 100,
      bodySha256: 'aa'.repeat(32),
      archiveKey: 'raw/device/batch',
      decoderHash: 'bb'.repeat(32),
      acceptedAt: '2026-08-29T01:01:00Z',
    };

    await repository.commitBatch(batch, archive, [{ expected: 8n, received: 10n }]);

    const telemetry = database.batched.filter((item) => item.query.includes('INTO telemetry'));
    expect(telemetry).toHaveLength(4);
    expect(telemetry[0].values[5]).toBe('2026-08-28');
    expect(database.batched.some((item) => item.query.includes('INTO gaps'))).toBe(true);
    expect(
      database.batched.some(
        (item) =>
          item.query.includes('INTO outages') && item.values[1] === '2026-08-29T01:00:00.000Z',
      ),
    ).toBe(true);
    expect(
      database.batched.some(
        (item) => item.query.includes("'sequence_gap'") && item.query.includes('INTO events'),
      ),
    ).toBe(true);
    expect(
      database.batched.some(
        (item) =>
          item.query.includes("'grid_outage_started'") && item.query.includes('INTO events'),
      ),
    ).toBe(true);
  });
});
