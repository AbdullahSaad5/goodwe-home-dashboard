import { describe, expect, it } from 'vitest';
import { decodeGwr1, encodeGwr1, type Gwr1Archive } from '../src/gwr1';

const DEVICE_ID = Uint8Array.from({ length: 16 }, (_, index) => index);
const DECODER_HASH = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);

const ARCHIVE: Gwr1Archive = {
  deviceId: DEVICE_ID,
  inverterFamily: 1,
  transport: 1,
  decoderHash: DECODER_HASH,
  firmwareVersion: '1.2.3',
  firstUtcMs: 1_700_000_000_000n,
  firstSequence: 42n,
  expectedIntervalMs: 10_000,
  samples: [
    {
      timestampDeltaMs: 0,
      sequenceDelta: 0,
      statusFlags: 1,
      timestampSource: 1,
      frames: [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(0xfe, 0xff)],
    },
  ],
};

// Produced independently with Python's struct and zlib.crc32 implementations.
const EXPECTED_HEX =
  '4757523101000062000102030405060708090a0b0c0d0e0f0101' +
  'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf' +
  '312e322e3300000000000000000000000000018bcfe56800000000000000002a' +
  '00002710000100000000000101020004000102030002feff00000072c10e613d';

describe('GWR1 archive', () => {
  it('encodes the versioned wire format deterministically', () => {
    expect(Buffer.from(encodeGwr1(ARCHIVE)).toString('hex')).toBe(EXPECTED_HEX);
  });

  it('round-trips complete frame bytes and metadata', () => {
    expect(decodeGwr1(Buffer.from(EXPECTED_HEX, 'hex'))).toEqual(ARCHIVE);
  });

  it('rejects a corrupted archive', () => {
    const corrupted = Buffer.from(EXPECTED_HEX, 'hex');
    corrupted[105] ^= 0xff;
    expect(() => decodeGwr1(corrupted)).toThrow(/CRC32/);
  });
});
