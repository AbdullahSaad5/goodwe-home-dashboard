const MAGIC = Uint8Array.of(0x47, 0x57, 0x52, 0x31);
const FORMAT_VERSION = 1;
const HEADER_LENGTH = 98;
const FIRMWARE_LENGTH = 16;
const TRAILER_LENGTH = 8;

export interface Gwr1Sample {
  timestampDeltaMs: number;
  sequenceDelta: number;
  statusFlags: number;
  timestampSource: number;
  frames: Uint8Array[];
}

export interface Gwr1Archive {
  deviceId: Uint8Array;
  inverterFamily: number;
  transport: number;
  decoderHash: Uint8Array;
  firmwareVersion: string;
  firstUtcMs: bigint;
  firstSequence: bigint;
  expectedIntervalMs: number;
  samples: Gwr1Sample[];
}

class ByteWriter {
  readonly bytes: number[] = [];

  writeBytes(value: Uint8Array): void {
    this.bytes.push(...value);
  }

  writeU8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  writeU16(value: number): void {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  writeU32(value: number): void {
    this.bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  }

  writeU64(value: bigint): void {
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      this.bytes.push(Number((value >> shift) & 0xffn));
    }
  }

  writeVarUint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid varuint');
    let remaining = value;
    do {
      const next = remaining % 128;
      remaining = Math.floor(remaining / 128);
      this.writeU8(next | (remaining > 0 ? 0x80 : 0));
    } while (remaining > 0);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class ByteReader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) throw new Error('Truncated GWR1');
    const value = Uint8Array.from(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  readU8(): number {
    return this.readBytes(1)[0];
  }

  readU16(): number {
    const value = this.readBytes(2);
    return value[0] * 0x100 + value[1];
  }

  readU32(): number {
    const value = this.readBytes(4);
    return (value[0] * 0x1000000 + value[1] * 0x10000 + value[2] * 0x100 + value[3]) >>> 0;
  }

  readU64(): bigint {
    let value = 0n;
    for (const byte of this.readBytes(8)) value = (value << 8n) | BigInt(byte);
    return value;
  }

  readVarUint(): number {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.readU8();
      value += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new Error('Invalid GWR1 varuint');
        return value;
      }
      factor *= 128;
    }
    throw new Error('Invalid GWR1 varuint');
  }
}

function requireLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) throw new Error(`${name} must contain ${expected} bytes`);
}

function fixedUtf8(value: string, length: number): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > length) throw new Error(`Firmware version exceeds ${length} bytes`);
  const result = new Uint8Array(length);
  result.set(encoded);
  return result;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeGwr1(archive: Gwr1Archive): Uint8Array {
  requireLength('deviceId', archive.deviceId, 16);
  requireLength('decoderHash', archive.decoderHash, 32);
  if (archive.samples.length > 0xffff) throw new Error('Too many GWR1 samples');

  const writer = new ByteWriter();
  writer.writeBytes(MAGIC);
  writer.writeU8(FORMAT_VERSION);
  writer.writeU8(0);
  writer.writeU16(HEADER_LENGTH);
  writer.writeBytes(archive.deviceId);
  writer.writeU8(archive.inverterFamily);
  writer.writeU8(archive.transport);
  writer.writeBytes(archive.decoderHash);
  writer.writeBytes(fixedUtf8(archive.firmwareVersion, FIRMWARE_LENGTH));
  writer.writeU64(archive.firstUtcMs);
  writer.writeU64(archive.firstSequence);
  writer.writeU32(archive.expectedIntervalMs);
  writer.writeU16(archive.samples.length);
  writer.writeU16(0);

  for (const sample of archive.samples) {
    if (sample.frames.length > 0xff) throw new Error('Too many frames in GWR1 sample');
    writer.writeVarUint(sample.timestampDeltaMs);
    writer.writeVarUint(sample.sequenceDelta);
    writer.writeU16(sample.statusFlags);
    writer.writeU8(sample.timestampSource);
    writer.writeU8(sample.frames.length);
    for (const frame of sample.frames) {
      if (frame.length > 0xffff) throw new Error('GWR1 frame is too large');
      writer.writeU16(frame.length);
      writer.writeBytes(frame);
    }
  }

  const body = writer.toUint8Array();
  writer.writeU32(body.length);
  writer.writeU32(crc32(body));
  return writer.toUint8Array();
}

export function decodeGwr1(input: Uint8Array): Gwr1Archive {
  if (input.length < HEADER_LENGTH + TRAILER_LENGTH) throw new Error('Truncated GWR1');
  const trailer = new ByteReader(input.slice(input.length - TRAILER_LENGTH));
  const declaredLength = trailer.readU32();
  const declaredCrc = trailer.readU32();
  const body = input.slice(0, input.length - TRAILER_LENGTH);
  if (declaredLength !== body.length) throw new Error('Invalid GWR1 uncompressed length');
  if (declaredCrc !== crc32(body)) throw new Error('Invalid GWR1 CRC32');

  const reader = new ByteReader(body);
  if (!reader.readBytes(4).every((byte, index) => byte === MAGIC[index])) {
    throw new Error('Invalid GWR1 magic');
  }
  const version = reader.readU8();
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported GWR1 version ${version}`);
  reader.readU8();
  if (reader.readU16() !== HEADER_LENGTH) throw new Error('Invalid GWR1 header length');

  const deviceId = reader.readBytes(16);
  const inverterFamily = reader.readU8();
  const transport = reader.readU8();
  const decoderHash = reader.readBytes(32);
  const firmwareBytes = reader.readBytes(FIRMWARE_LENGTH);
  const firmwareEnd = firmwareBytes.indexOf(0);
  const firmwareVersion = new TextDecoder().decode(
    firmwareBytes.slice(0, firmwareEnd === -1 ? firmwareBytes.length : firmwareEnd),
  );
  const firstUtcMs = reader.readU64();
  const firstSequence = reader.readU64();
  const expectedIntervalMs = reader.readU32();
  const sampleCount = reader.readU16();
  reader.readU16();

  const samples: Gwr1Sample[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const timestampDeltaMs = reader.readVarUint();
    const sequenceDelta = reader.readVarUint();
    const statusFlags = reader.readU16();
    const timestampSource = reader.readU8();
    const frameCount = reader.readU8();
    const frames: Uint8Array[] = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      frames.push(reader.readBytes(reader.readU16()));
    }
    samples.push({ timestampDeltaMs, sequenceDelta, statusFlags, timestampSource, frames });
  }
  if (reader.remaining() !== 0) throw new Error('Unexpected bytes in GWR1 body');

  return {
    deviceId,
    inverterFamily,
    transport,
    decoderHash,
    firmwareVersion,
    firstUtcMs,
    firstSequence,
    expectedIntervalMs,
    samples,
  };
}
