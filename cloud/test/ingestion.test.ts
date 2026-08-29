import { describe, expect, it } from 'vitest';
import { encodeGwr1, type Gwr1Archive } from '../src/gwr1';
import {
  canonicalIngestionSignature,
  handleIngestionRequest,
  type AcceptedBatch,
  type IngestionRepository,
  type SequenceGap,
} from '../src/ingestion';

const DEVICE_UUID = '00010203-0405-0607-0809-0a0b0c0d0e0f';
const SECRET = 'test-device-secret-with-high-entropy';

class MemoryRepository implements IngestionRepository {
  readonly archives = new Map<string, Uint8Array>();
  readonly batches = new Map<string, AcceptedBatch>();
  readonly gaps: Array<{ expected: bigint; received: bigint }> = [];
  storedBytes = 0;

  async findBatch(key: string): Promise<AcceptedBatch | null> {
    return this.batches.get(key) ?? null;
  }

  async putArchive(key: string, body: Uint8Array): Promise<void> {
    this.archives.set(key, body);
  }

  async verifyArchive(key: string, bodySha256: string): Promise<boolean> {
    const body = this.archives.get(key);
    return body !== undefined && (await sha256Hex(body)) === bodySha256;
  }

  async commitBatch(
    batch: AcceptedBatch,
    _archive: Gwr1Archive,
    gaps: SequenceGap[],
  ): Promise<void> {
    this.batches.set(batch.idempotencyKey, batch);
    this.storedBytes += batch.compressedBytes;
    this.gaps.push(...gaps);
  }

  async latestSequence(): Promise<bigint | null> {
    const values = [...this.batches.values()].map((batch) => batch.lastSequence);
    return values.length === 0
      ? null
      : values.reduce((left, right) => (left > right ? left : right));
  }

  async totalStoredBytes(): Promise<number> {
    return this.storedBytes;
  }
}

function modbusFrame(transaction: number, registers: number): Uint8Array {
  const byteCount = registers * 2;
  const frame = new Uint8Array(9 + byteCount);
  const view = new DataView(frame.buffer);
  view.setUint16(0, transaction);
  view.setUint16(2, 0);
  view.setUint16(4, byteCount + 3);
  frame[6] = 0xf7;
  frame[7] = 0x03;
  frame[8] = byteCount;
  return frame;
}

function archive(): Gwr1Archive {
  return {
    deviceId: Uint8Array.from({ length: 16 }, (_, index) => index),
    inverterFamily: 1,
    transport: 1,
    decoderHash: new Uint8Array(32).fill(0xaa),
    firmwareVersion: '0.1.0',
    firstUtcMs: 1_700_000_000_000n,
    firstSequence: 42n,
    expectedIntervalMs: 10_000,
    samples: [
      {
        timestampDeltaMs: 0,
        sequenceDelta: 0,
        statusFlags: 1,
        timestampSource: 1,
        frames: [modbusFrame(1, 125), modbusFrame(2, 24), modbusFrame(3, 45)],
      },
    ],
  };
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Buffer.from(digest).toString('hex');
}

async function signedRequest(
  body: Uint8Array,
  secret = SECRET,
  firstSequence = '42',
  lastSequence = '42',
): Promise<Request> {
  const bodyHash = await sha256Hex(body);
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'X-Device-ID': DEVICE_UUID,
    'X-First-Sequence': firstSequence,
    'X-Last-Sequence': lastSequence,
    'X-Timestamp': '1700000000',
    'X-Body-SHA256': bodyHash,
  });
  const canonical = canonicalIngestionSignature('POST', '/ingest/v1/batches', headers);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  headers.set('Authorization', `HMAC v1=${Buffer.from(signature).toString('hex')}`);
  return new Request('https://ingest.example.test/ingest/v1/batches', {
    method: 'POST',
    headers,
    body: body.slice().buffer,
  });
}

describe('ingestion HTTP contract', () => {
  const config = {
    deviceId: DEVICE_UUID,
    deviceSecret: SECRET,
    maxClockSkewSeconds: 300,
    r2GuardBytes: 9_000_000_000,
    acceptedDecoderHashes: ['aa'.repeat(32)],
    acceptedTimestampSources: [1],
    now: () => new Date('2023-11-14T22:13:20Z'),
  };

  it('stores an authenticated archive once and acknowledges idempotent retries', async () => {
    const body = await deflate(encodeGwr1(archive()));
    const repository = new MemoryRepository();
    const first = await handleIngestionRequest(await signedRequest(body), config, repository);
    const retry = await handleIngestionRequest(await signedRequest(body), config, repository);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ firstSequence: '42', lastSequence: '42' });
    expect(repository.archives).toHaveLength(1);
    expect(repository.batches).toHaveLength(1);
  });

  it('rejects invalid authentication before writing anything', async () => {
    const repository = new MemoryRepository();
    const body = await deflate(encodeGwr1(archive()));
    const response = await handleIngestionRequest(
      await signedRequest(body, 'wrong-secret'),
      config,
      repository,
    );

    expect(response.status).toBe(401);
    expect(repository.archives).toHaveLength(0);
    expect(repository.batches).toHaveLength(0);
  });

  it('records sequence holes inside an otherwise valid batch', async () => {
    const value = archive();
    value.samples.push({
      ...value.samples[0],
      timestampDeltaMs: 20_000,
      sequenceDelta: 2,
      frames: [modbusFrame(4, 125), modbusFrame(5, 24), modbusFrame(6, 45)],
    });
    const repository = new MemoryRepository();
    const body = await deflate(encodeGwr1(value));
    const response = await handleIngestionRequest(
      await signedRequest(body, SECRET, '42', '44'),
      config,
      repository,
    );
    expect(response.status).toBe(201);
    expect(repository.gaps).toEqual([{ expected: 43n, received: 44n }]);
  });

  it('rejects out-of-order samples and quota overflow without committing D1 state', async () => {
    const value = archive();
    value.samples = [
      { ...value.samples[0], sequenceDelta: 1 },
      { ...value.samples[0], sequenceDelta: 0, timestampDeltaMs: 10_000 },
    ];
    const body = await deflate(encodeGwr1(value));
    const outOfOrderRepository = new MemoryRepository();
    const rejected = await handleIngestionRequest(
      await signedRequest(body),
      config,
      outOfOrderRepository,
    );
    expect(rejected.status).toBe(400);
    expect(outOfOrderRepository.batches).toHaveLength(0);

    const quotaRepository = new MemoryRepository();
    const validBody = await deflate(encodeGwr1(archive()));
    const full = await handleIngestionRequest(
      await signedRequest(validBody),
      { ...config, r2GuardBytes: validBody.length - 1 },
      quotaRepository,
    );
    expect(full.status).toBe(507);
    expect(quotaRepository.archives).toHaveLength(0);
  });

  it('rejects a batch range that overlaps an already committed sequence', async () => {
    const repository = new MemoryRepository();
    const current = archive();
    const currentBody = await deflate(encodeGwr1(current));
    expect(
      (await handleIngestionRequest(await signedRequest(currentBody), config, repository)).status,
    ).toBe(201);

    const older = archive();
    older.firstSequence = 41n;
    const olderBody = await deflate(encodeGwr1(older));
    const response = await handleIngestionRequest(
      await signedRequest(olderBody, SECRET, '41', '41'),
      config,
      repository,
    );

    expect(response.status).toBe(409);
    expect(repository.batches).toHaveLength(1);
  });

  it('rejects an archive whose final sample is beyond the clock policy', async () => {
    const value = archive();
    value.samples.push({
      ...value.samples[0],
      timestampDeltaMs: 600_000,
      sequenceDelta: 1,
      frames: [modbusFrame(4, 125), modbusFrame(5, 24), modbusFrame(6, 45)],
    });
    const repository = new MemoryRepository();
    const body = await deflate(encodeGwr1(value));
    const response = await handleIngestionRequest(
      await signedRequest(body, SECRET, '42', '43'),
      config,
      repository,
    );

    expect(response.status).toBe(401);
    expect(repository.archives).toHaveLength(0);
  });
});
