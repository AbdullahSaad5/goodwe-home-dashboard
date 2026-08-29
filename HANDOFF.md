# ESP32 GoodWe Cloud Collector Handoff

## Goal

Replace the always-on laptop collector with the connected ESP32. The ESP32 must:

1. Discover or reconnect to the GoodWe inverter on the local LAN.
2. Poll every 10 seconds using read-only protocol commands.
3. Preserve every raw inverter response losslessly.
4. Decode the readings needed by the dashboard.
5. Upload through outbound authenticated HTTPS.
6. Continue collecting through transient Wi-Fi, Internet, inverter, and cloud failures.
7. Keep normal single-device usage within the current Cloudflare free quotas.

The laptop remains only a development, flashing, and side-by-side verification tool. The production dashboard and persistence move to the cloud.

## Non-negotiable invariants

- Inverter access remains read-only. Do not port or expose setting/control/write commands.
- Never expose the inverter, ESP32, or a LAN port to the public Internet.
- Cloud failure must not delay or stop local inverter polling.
- Every accepted sample has a UTC timestamp, monotonic sequence number, schema/decoder version, and device ID.
- Cloud ingestion is idempotent on device and sequence.
- Raw archives are lossless. Derived JSON may be regenerated from archived wire frames.
- Credentials, Wi-Fi details, inverter addresses, serial numbers, and household telemetry must not enter Git or logs.

## Repository state at handoff

- Repository: `/Users/decimalsols/Documents/goodwe-dashboard`
- Branch: `main`, tracking `origin/main`
- Starting state before this handoff: clean
- Latest commit: `5f8a235 Fix CI frontend shell test setup`
- No firmware or cloud implementation has been added yet.
- This `HANDOFF.md` is the only intended repository addition from the handoff step.

The existing application is a Python/FastAPI/SQLite collector plus a React/TypeScript dashboard. Important source boundaries:

- `server/src/goodwe_home/discovery.py`: current configured/saved/broadcast/subnet discovery flow
- `server/src/goodwe_home/collector.py`: polling, retry, normalization, persistence, and SSE behavior
- `server/src/goodwe_home/normalization.py`: stable sign conventions and application model
- `server/src/goodwe_home/models.py`: Pydantic API contracts
- `server/src/goodwe_home/database.py`: retention, aggregates, events, outages, and history
- `server/src/goodwe_home/analytics.py`: presentation-ready command-center calculations
- `server/src/goodwe_home/main.py`: current read-only API
- `web/src/useDashboard.ts`: coordinated refresh behavior
- `web/src/types.ts`: frontend API contracts

Treat the desktop implementation and tests as the behavioral oracle, not as code that will run unchanged on the ESP32.

## Connected hardware verified on macOS

The board currently enumerates successfully through the USB hub:

- USB bridge: Silicon Labs `CP2102 USB to UART Bridge Controller`
- USB serial: `0001`
- macOS driver: built-in `AppleUSBSLCOM`
- Callout endpoint: `/dev/cu.usbserial-0001`
- Dial-in endpoint: `/dev/tty.usbserial-0001`
- Hub port: 2
- No additional Silicon Labs driver is required.

Useful checks:

```bash
printf '%s\n' /dev/cu.* /dev/tty.*
ioreg -r -c IOUSBHostDevice -l -w 0
ioreg -r -c IOSerialBSDClient -l
lsof /dev/cu.usbserial-0001
```

The exact ESP32 MCU variant, board definition, flash size, RAM/PSRAM, and partition layout have not yet been identified. Determine those before choosing build flags or persistent queue capacity.

## Actual inverter/protocol findings

A live read-only connection was made using the saved inverter address without printing or exposing it.

Observed runtime behavior:

- The `goodwe` library identifies the actual protocol family as `ET`.
- Current connection port: TCP `502`.
- One complete runtime poll performs three response reads.
- Raw wire-frame lengths: `259`, `57`, and `99` bytes.
- Total exact wire bytes per poll: `415` bytes.
- Total decoded response payload: `388` bytes.
- Parsed sensor values produced: `145`.

The existing stored parsed raw snapshot is much larger:

- Average raw JSON size: approximately `3,076.9` bytes per snapshot.
- Average normalized snapshot JSON size: approximately `2,271.8` bytes.
- All `1,409` inspected historical raw snapshots used the same 145-key schema.

### Critical storage decision

Do not use expanded JSON as the permanent raw archive.

Archive the exact binary inverter response frames plus timestamp/sequence metadata. Those frames are the source of truth from which the same 145 parsed sensor values can be reconstructed. This removes repeated field names, labels, units, and derived text without losing source data.

Store versioned decoder manifests separately so old frames remain decodable after firmware or parsing changes.

## Validated lossless compression result

A live experiment collected six complete 10-second polls and packed every raw response frame with timestamp and frame lengths. No sensor or frame bytes were removed.

One-minute block:

| Encoding | Size |
|---|---:|
| Uncompressed binary block | 2,560 bytes |
| Deflate level 1 | 643 bytes |
| Deflate level 6 | 573 bytes |
| Gzip level 6 | 585 bytes |
| LZMA | 488 bytes |

Deflate level 1 achieved a `3.98:1` ratio and is the recommended starting point for ESP32 because it provides strong compression with lower CPU cost than heavier levels.

Measured Deflate level 1 projection at one sample every 10 seconds:

- Approximately 338 MB/year
- Approximately 0.315 GiB/year
- Approximately 29.6 years before 10 decimal GB

Conservative projections:

| Scenario | Annual storage | Approximate years in 10 GB |
|---|---:|---:|
| Measured Deflate level 1 | 338 MB | 29.6 |
| 2× measured archive size | 615 MB | 16.3 |
| 4× measured archive size | 1.23 GB | 8.1 |
| No compression | 1.35 GB | 7.4 |

These are measured/projection figures, not a promise that provider quotas will remain unchanged. Instrument actual stored bytes and alert well before quota exhaustion.

## Proposed `GWR1` archive format

Use a small versioned binary container. Suggested layout:

```text
Archive header
  magic:                 "GWR1"
  format_version:        u8
  device_id:             fixed UUID or compact binary ID
  inverter_family:       enum (ET for the current device)
  transport:             enum (Modbus/TCP or detected protocol)
  decoder_schema_hash:   content-addressed hash
  firmware_version:      compact semantic/build ID
  first_utc_timestamp:   u64 or u32 while safe
  first_sequence:        u64
  expected_interval_ms:  u32
  sample_count:          u16

Each sample
  timestamp_delta_ms:    varint
  sequence_delta:        varint
  status_flags:          bitset
  frame_count:           u8
  repeated:
    frame_length:        u16
    exact_frame_bytes:   bytes

Trailer
  uncompressed_length:   u32
  crc32:                 u32
  optional sha256:       32 bytes or object metadata
```

Compress the entire container with zlib/Deflate. The archive must retain complete frame bytes, including protocol checksums.

### Decoder manifests

Each object references an immutable content-addressed manifest, for example:

```text
manifests/sha256-<decoder-hash>.json
raw/<site>/<device>/<year>/<month>/<day>/<hour-minute>.gwr.zlib
```

The manifest must define:

- Protocol family and transport
- Command/frame identities and register ranges
- Field offsets, widths, signedness, and endianness
- Scaling factors and units
- Enum/bitmap mappings
- Derived sensor formulas
- Decoder source revision
- Compatibility notes

If parsing logic changes, publish a new manifest/hash. Never silently reinterpret old archives using a newer decoder.

## Cloud architecture

```text
GoodWe inverter
    -> local read-only TCP/UDP
ESP32
    -> authenticated outbound HTTPS
Cloudflare Worker
    -> R2 lossless compressed archives
    -> D1 latest/queryable telemetry and archive index
Remote React dashboard
```

Current provider limits were checked in August 2026 and must be rechecked before deployment:

- Workers Free: 100,000 requests/day.
- D1 Free: 100,000 rows written/day, 5 million rows read/day, 5 GB total storage.
- R2 Free: 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, free direct egress.

Official references:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://github.com/marcelblijleven/goodwe

### Upload batching

Recommended production batch: one five-minute archive object containing 30 ten-second polls.

Expected operation volume:

- 288 archive uploads/day
- 8,640 archive writes per 30-day month
- Well below Worker and R2 operation quotas
- Roughly 13 KB uncompressed frame data per five-minute batch before headers/compression

The one-minute compression experiment is the verified baseline. Repeat compression and RAM tests with the final five-minute firmware buffer before locking the format.

### D1 storage shape

Use one wide row per 10-second snapshot for queryable dashboard fields. Do not use an entity-attribute-value table with one row per sensor.

At 145 sensor rows per poll, an EAV design would require about 1,252,800 rows/day and exceed the free write quota. A single snapshot row requires 8,640 base inserts/day; one timestamp/device index adds write amplification but remains comfortably under 100,000/day.

Suggested query table fields:

```text
device_id
timestamp
sequence
connection_state
pv_w
home_w
grid_w
battery_w
backup_w
battery_soc_pct
grid_voltage_v
grid_frequency_hz
inverter_temperature_c
battery_temperature_c
warning_code
error_code
archive_key
archive_sample_index
decoder_schema_hash
```

D1 responsibilities:

- Latest device state
- Queryable chart metrics
- Events, outages, and health state
- Aggregate tables
- Archive object index and sequence coverage
- Ingestion deduplication

R2 responsibilities:

- Every exact raw response frame
- Immutable decoder manifests
- Optional device-info frames and firmware-transition records

A historical raw-sensor request should locate the R2 object through D1, verify/decompress it, select the sample, and decode all 145 values with the referenced manifest.

## ESP32 firmware responsibilities

Prefer ESP-IDF/C++ for the always-on production collector. Arduino C++ is acceptable for the first protocol proof, but do not assume the desktop CPython package can run under MicroPython.

### Startup

1. Load non-secret configuration and credentials from provisioned storage.
2. Connect to Wi-Fi with bounded retry/backoff.
3. Synchronize UTC through NTP and record clock readiness.
4. Try explicit inverter address if provisioned.
5. Try the last protocol-validated address from NVS.
6. Attempt GoodWe broadcast discovery.
7. Fall back to a bounded active-subnet scan on the expected port.
8. Validate candidates using a read-only protocol request.
9. Save only a successfully validated address.
10. Fetch/store device info and select the immutable decoder manifest.

### Poll loop

Every 10 seconds:

1. Issue only the required read commands.
2. Capture complete raw response frames before decoding.
3. Validate frame lengths and protocol checksums.
4. Assign UTC timestamp and monotonic sequence.
5. Decode values needed for live state and health.
6. Append the exact frames to the active `GWR1` batch.
7. Keep cloud work asynchronous from the poll deadline.

### Archive/upload loop

Every five minutes:

1. Finalize the 30-sample `GWR1` block.
2. Add uncompressed length and CRC32.
3. Deflate-compress the complete block.
4. Sign the request over device, sequence range, timestamp, and body hash.
5. Upload through TLS with certificate validation.
6. Accept success only when the Worker confirms the exact sequence range and object checksum.
7. Delete the local durable batch only after acknowledgment.
8. Retry idempotently with exponential backoff and jitter.

### Offline queue

Normal batching can occur in RAM. Exact no-gap recovery through Internet or power failures requires durable staging:

- Best option: microSD spool with append/finalize/acknowledge semantics.
- Acceptable constrained option: LittleFS coarse completed batches with wear leveling.
- Do not write every 10-second sample as a separate internal-flash transaction.

The final hardware decision on microSD is unresolved. Without durable staging, a power loss can lose the active RAM batch even if cloud retry works correctly.

## Ingestion security and idempotency

Each device should have a scoped secret or credential. Suggested request fields:

```text
X-Device-ID
X-First-Sequence
X-Last-Sequence
X-Timestamp
X-Body-SHA256
Authorization: HMAC <signature>
```

The Worker must:

1. Validate TLS-delivered request size and content type.
2. Resolve the device credential without logging it.
3. Verify body hash and HMAC in constant-time style.
4. Reject unreasonable clock skew while allowing an explicit unsynchronized startup mode.
5. Deduplicate by device and sequence range/object hash.
6. Store the R2 object.
7. Read back object metadata or otherwise verify the exact target before acknowledging success.
8. Commit D1 archive-index and query rows transactionally/idempotently.
9. Return the accepted sequence range and hash.
10. Detect/report gaps without fabricating missing samples.

## Implementation phases and acceptance gates

### Phase 1: identify and flash the board

- Determine ESP32 variant, flash, RAM/PSRAM, and partition layout.
- Establish an ESP-IDF project and serial logging without secrets.
- Confirm watchdog/reboot behavior.

Gate: firmware boots repeatedly and the serial endpoint remains stable.

### Phase 2: read-only GoodWe protocol proof

- Port only discovery, device-info reads, and the three runtime reads.
- Validate frame checksums and lengths.
- Capture exact wire frames.

Gate: the firmware identifies the inverter using a protocol response, not merely an open port.

### Phase 3: desktop-oracle comparison

- Run ESP32 and desktop collector side by side.
- Compare all 145 decoded fields where available.
- Exercise daytime/nighttime, import/export, charging/discharging, stale/offline, and warning/error states.
- Preserve the existing sign conventions: grid positive export/negative import; battery positive discharge/negative charge.

Gate: fixture-based and live comparisons agree, with explicit handling of unavailable values.

### Phase 4: `GWR1` and compression

- Implement deterministic encoder/decoder tests.
- Round-trip arbitrary and captured frames byte-for-byte.
- Test truncated, corrupt, duplicate, missing, and out-of-order records.
- Measure five-minute peak RAM and compressed size on the actual board.

Gate: decompression reproduces every original byte and corruption is rejected.

### Phase 5: Worker, R2, and D1

- Build authenticated ingestion.
- Create D1 query/index tables and R2 object naming.
- Store immutable decoder manifests.
- Verify exact read-back after writes.
- Add quota metrics and alerts.

Gate: retries do not duplicate samples or objects; a stored object decodes back to the original captured frames.

### Phase 6: remote dashboard

- Replace local FastAPI transport with remote Worker API while preserving frontend contracts where practical.
- Keep analytics server-side and readiness-explicit.
- Provide raw historical decoding/export from R2.
- Host the compiled React application remotely.

Gate: live, history, command-center, raw sensors, events, and exports function without the laptop collector running.

### Phase 7: failure testing

Test each independently:

- Wi-Fi disconnect/reconnect
- Internet outage
- Cloud 4xx/5xx/timeouts
- Inverter disconnect/readdressing
- ESP32 reset during active batch
- Power loss during durable queue write
- Duplicate upload
- Corrupt upload
- Sequence gap
- NTP unavailable at boot
- R2/D1 quota warning thresholds

Gate: recovery is automatic, duplicates are harmless, missing samples are explicit, and no failure path sends inverter write commands.

## Existing project verification status

Backend test run during orientation:

- 44 pytest tests passed.

Frontend test run:

- 48 Vitest tests passed under Node 22.13.0.

The currently active local Node was 22.11.0, below the package requirement `>=22.13.0`, and caused jsdom worker startup failures when running `make test` directly. Use a supported Node version before treating frontend failures as application defects.

Standard project checks:

```bash
make format
make lint
make test
make build
```

Do not alter the existing retention/database behavior until the cloud design has equivalent tests.

## Unresolved decisions

1. Exact ESP32 MCU/board, flash, RAM, and PSRAM.
2. ESP-IDF production path versus Arduino proof followed by ESP-IDF port.
3. Whether to add microSD for durable no-gap offline buffering.
4. Cloudflare account, deployment domain, and dashboard authentication model.
5. Device provisioning and credential rotation process.
6. Five-minute versus longer archive chunks after actual-board RAM and compression tests.
7. D1 recent-query retention duration.
8. Whether the cloud decodes every batch on ingestion or decodes only dashboard fields plus on-demand raw history.
9. Operational policy when R2 approaches quota; never silently delete raw history.

## Recommended immediate next action

Identify the board with a read-only chip-info tool over `/dev/cu.usbserial-0001`, then create the smallest ESP-IDF firmware that performs the current inverter's three read-only runtime requests and emits only frame lengths/checksum validity over serial. Do not start with cloud code. First establish a byte-for-byte side-by-side oracle against the desktop collector; the whole archive design depends on capturing and validating the exact source frames correctly.
