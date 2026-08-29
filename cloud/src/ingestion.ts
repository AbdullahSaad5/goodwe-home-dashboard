import { decodeGwr1, type Gwr1Archive } from './gwr1';

export interface IngestionConfig {
  deviceId: string;
  deviceSecret: string;
  maxClockSkewSeconds: number;
  r2GuardBytes: number;
  acceptedDecoderHashes: string[];
  acceptedTimestampSources: number[];
  now: () => Date;
}

export interface AcceptedBatch {
  idempotencyKey: string;
  deviceId: string;
  firstSequence: bigint;
  lastSequence: bigint;
  firstUtcMs: bigint;
  lastUtcMs: bigint;
  sampleCount: number;
  compressedBytes: number;
  bodySha256: string;
  archiveKey: string;
  decoderHash: string;
  acceptedAt: string;
}

export interface SequenceGap {
  expected: bigint;
  received: bigint;
}

export interface IngestionRepository {
  findBatch(idempotencyKey: string): Promise<AcceptedBatch | null>;
  putArchive(key: string, body: Uint8Array, metadata: Record<string, string>): Promise<void>;
  verifyArchive(key: string, bodySha256: string): Promise<boolean>;
  commitBatch(batch: AcceptedBatch, archive: Gwr1Archive, gaps: SequenceGap[]): Promise<void>;
  latestSequence(deviceId: string): Promise<bigint | null>;
  totalStoredBytes(): Promise<number>;
}

const REQUIRED_HEADERS = [
  'X-Device-ID',
  'X-First-Sequence',
  'X-Last-Sequence',
  'X-Timestamp',
  'X-Body-SHA256',
] as const;

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function parseUnsigned(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}`);
  return BigInt(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function uuidBytes(uuid: string): Uint8Array {
  const compact = uuid.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error('Invalid device ID');
  return Uint8Array.from(compact.match(/../g) ?? [], (value) => Number.parseInt(value, 16));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)));
}

async function verifyHmac(
  canonical: string,
  authorization: string,
  secret: string,
): Promise<boolean> {
  const match = /^HMAC v1=([0-9a-f]{64})$/i.exec(authorization);
  if (!match) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(match[1].match(/../g) ?? [], (value) => Number.parseInt(value, 16)),
    new TextEncoder().encode(canonical),
  );
}

async function inflate(body: Uint8Array): Promise<Uint8Array> {
  try {
    const source = new Blob([body.slice().buffer]).stream();
    const result = await new Response(
      source.pipeThrough(new DecompressionStream('deflate')),
    ).arrayBuffer();
    return new Uint8Array(result);
  } catch {
    throw new Error('Invalid Deflate body');
  }
}

function validateFrame(frame: Uint8Array, expectedBytes: number): boolean {
  if (frame.length !== expectedBytes + 9) return false;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return (
    view.getUint16(2) === 0 &&
    view.getUint16(4) === expectedBytes + 3 &&
    frame[6] === 0xf7 &&
    frame[7] === 0x03 &&
    frame[8] === expectedBytes
  );
}

function validateArchive(
  archive: Gwr1Archive,
  deviceId: string,
  firstSequence: bigint,
  lastSequence: bigint,
  acceptedDecoderHashes: string[],
  acceptedTimestampSources: number[],
): SequenceGap[] {
  if (bytesToHex(archive.deviceId) !== bytesToHex(uuidBytes(deviceId))) {
    throw new Error('Archive device ID does not match request');
  }
  if (archive.inverterFamily !== 1 || archive.transport !== 1 || archive.samples.length === 0) {
    throw new Error('Unsupported or empty GWR1 archive');
  }
  if (!acceptedDecoderHashes.includes(bytesToHex(archive.decoderHash))) {
    throw new Error('Unsupported decoder hash');
  }
  if (archive.firstSequence !== firstSequence) throw new Error('First sequence does not match');

  let previousSequence = -1;
  let previousTimestamp = -1;
  const gaps: SequenceGap[] = [];
  for (const sample of archive.samples) {
    if (sample.sequenceDelta <= previousSequence || sample.timestampDeltaMs < previousTimestamp) {
      throw new Error('GWR1 samples are out of order');
    }
    previousSequence = sample.sequenceDelta;
    previousTimestamp = sample.timestampDeltaMs;
    if (!acceptedTimestampSources.includes(sample.timestampSource)) {
      throw new Error('Unsupported timestamp source');
    }
    const previousSample = archive.samples[archive.samples.indexOf(sample) - 1];
    if (previousSample && sample.sequenceDelta > previousSample.sequenceDelta + 1) {
      gaps.push({
        expected: archive.firstSequence + BigInt(previousSample.sequenceDelta + 1),
        received: archive.firstSequence + BigInt(sample.sequenceDelta),
      });
    }
    if (
      sample.frames.length !== 3 ||
      !validateFrame(sample.frames[0], 250) ||
      !validateFrame(sample.frames[1], 48) ||
      !validateFrame(sample.frames[2], 90)
    ) {
      throw new Error('Invalid GoodWe response frame set');
    }
  }
  if (archive.firstSequence + BigInt(previousSequence) !== lastSequence) {
    throw new Error('Last sequence does not match');
  }
  return gaps;
}

function archiveObjectKey(
  deviceId: string,
  firstUtcMs: bigint,
  firstSequence: bigint,
  lastSequence: bigint,
): string {
  const date = new Date(Number(firstUtcMs));
  if (Number.isNaN(date.valueOf())) throw new Error('Invalid first UTC timestamp');
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `raw/${deviceId}/${year}/${month}/${day}/${firstSequence}-${lastSequence}.gwr.zlib`;
}

export function canonicalIngestionSignature(
  method: string,
  path: string,
  headers: Headers,
): string {
  return [
    'GWI1',
    method.toUpperCase(),
    path,
    ...REQUIRED_HEADERS.map((name) => headers.get(name) ?? ''),
  ].join('\n');
}

export async function handleIngestionRequest(
  request: Request,
  config: IngestionConfig,
  repository: IngestionRepository,
): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/ingest/v1/batches') {
    return json(404, { error: 'not_found' });
  }
  if (request.headers.get('Content-Type') !== 'application/octet-stream') {
    return json(415, { error: 'unsupported_content_type' });
  }
  if (REQUIRED_HEADERS.some((name) => !request.headers.has(name))) {
    return json(400, { error: 'missing_headers' });
  }

  try {
    const deviceId = request.headers.get('X-Device-ID')!;
    const firstSequence = parseUnsigned(request.headers.get('X-First-Sequence')!, 'first sequence');
    const lastSequence = parseUnsigned(request.headers.get('X-Last-Sequence')!, 'last sequence');
    const requestTimestamp = parseUnsigned(request.headers.get('X-Timestamp')!, 'timestamp');
    const claimedHash = request.headers.get('X-Body-SHA256')!.toLowerCase();
    if (deviceId !== config.deviceId || !/^[0-9a-f]{64}$/.test(claimedHash)) {
      return json(401, { error: 'unauthorized' });
    }

    const canonical = canonicalIngestionSignature('POST', '/ingest/v1/batches', request.headers);
    if (
      !(await verifyHmac(
        canonical,
        request.headers.get('Authorization') ?? '',
        config.deviceSecret,
      ))
    ) {
      return json(401, { error: 'unauthorized' });
    }
    const nowSeconds = BigInt(Math.floor(config.now().valueOf() / 1000));
    const skew =
      nowSeconds >= requestTimestamp
        ? nowSeconds - requestTimestamp
        : requestTimestamp - nowSeconds;
    if (skew > BigInt(config.maxClockSkewSeconds)) return json(401, { error: 'clock_skew' });

    const body = new Uint8Array(await request.arrayBuffer());
    const actualHash = await sha256Hex(body);
    if (actualHash !== claimedHash) return json(400, { error: 'body_hash_mismatch' });

    const idempotencyKey = `${deviceId}:${firstSequence}:${lastSequence}`;
    const existing = await repository.findBatch(idempotencyKey);
    if (existing) {
      if (existing.bodySha256 !== actualHash) return json(409, { error: 'sequence_conflict' });
      return json(200, {
        firstSequence: existing.firstSequence.toString(),
        lastSequence: existing.lastSequence.toString(),
        bodySha256: existing.bodySha256,
        duplicate: true,
      });
    }

    if ((await repository.totalStoredBytes()) + body.length > config.r2GuardBytes) {
      return json(507, { error: 'quota_guard' });
    }

    const archive = decodeGwr1(await inflate(body));
    const internalGaps = validateArchive(
      archive,
      deviceId,
      firstSequence,
      lastSequence,
      config.acceptedDecoderHashes,
      config.acceptedTimestampSources,
    );
    const archiveTimestamp = archive.firstUtcMs / 1000n;
    if (archiveTimestamp > nowSeconds + BigInt(config.maxClockSkewSeconds)) {
      return json(401, { error: 'archive_clock_skew' });
    }
    const lastSample = archive.samples.at(-1)!;
    const lastUtcMs = archive.firstUtcMs + BigInt(lastSample.timestampDeltaMs);
    if (lastUtcMs / 1000n > nowSeconds + BigInt(config.maxClockSkewSeconds)) {
      return json(401, { error: 'archive_clock_skew' });
    }
    const archiveKey = archiveObjectKey(deviceId, archive.firstUtcMs, firstSequence, lastSequence);
    const accepted: AcceptedBatch = {
      idempotencyKey,
      deviceId,
      firstSequence,
      lastSequence,
      firstUtcMs: archive.firstUtcMs,
      lastUtcMs,
      sampleCount: archive.samples.length,
      compressedBytes: body.length,
      bodySha256: actualHash,
      archiveKey,
      decoderHash: bytesToHex(archive.decoderHash),
      acceptedAt: config.now().toISOString(),
    };

    const latest = await repository.latestSequence(deviceId);
    if (latest !== null && firstSequence <= latest) {
      return json(409, { error: 'out_of_order_range', latestSequence: latest.toString() });
    }
    const gaps = [...internalGaps];
    if (latest !== null && firstSequence > latest + 1n) {
      gaps.unshift({ expected: latest + 1n, received: firstSequence });
    }
    await repository.putArchive(archiveKey, body, {
      bodySha256: actualHash,
      firstSequence: firstSequence.toString(),
      lastSequence: lastSequence.toString(),
      decoderHash: accepted.decoderHash,
    });
    if (!(await repository.verifyArchive(archiveKey, actualHash))) {
      return json(502, { error: 'archive_verification_failed' });
    }
    await repository.commitBatch(accepted, archive, gaps);

    return json(201, {
      firstSequence: firstSequence.toString(),
      lastSequence: lastSequence.toString(),
      bodySha256: actualHash,
      duplicate: false,
    });
  } catch (error) {
    return json(400, {
      error: 'invalid_batch',
      detail: error instanceof Error ? error.message : 'error',
    });
  }
}
