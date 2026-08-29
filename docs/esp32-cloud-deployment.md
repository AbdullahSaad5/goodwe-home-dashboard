# ESP32 cloud deployment

This runbook deliberately keeps Wi-Fi credentials, coordinates, inverter identifiers, HMAC keys,
and the household passphrase out of Git and shell history.

## Verified hardware profile

- ESP32-D0WDQ6-V3, revision 3.0
- 4 MB, 3.3 V flash
- DIO flash mode, no PSRAM, USB updates only
- Secure Boot and flash encryption remain disabled for v1
- Partition layout: 24 KB NVS, 1.875 MB factory app, 2 MB LittleFS, 64 KB core dump

Before any write, keep the 4 MB original flash image and its SHA-256 file outside this repository.

The checked-in decoder manifest is generated from the validated desktop database without copying
telemetry into Git. If the desktop oracle schema changes, regenerate both artifacts and review the
new content hash:

```bash
.venv/bin/python cloud/tools/generate_decoder_manifest.py --oracle-db /path/to/goodwe.sqlite3
.venv/bin/python cloud/tools/generate_oracle_fixture.py
```

## Local checks

```bash
npm test
npm run typecheck
npm run build
.venv/bin/pytest
cmake -S firmware/host_tests -B firmware/build-host
cmake --build firmware/build-host
ctest --test-dir firmware/build-host --output-on-failure
```

Activate the Espressif Installation Manager environment, then build the target firmware:

```bash
source "$HOME/.espressif/tools/activate_idf_v6.0.sh"
cd firmware
idf.py set-target esp32
idf.py build
```

Do not run `idf.py flash` directly on an unprovisioned production board. Use the local provisioning
tool after the cloud resources exist.

## Cloudflare resources

Authenticate with `npx wrangler@latest login`, then create one D1 database and one private R2
bucket:

```bash
npx wrangler@latest d1 create goodwe-dashboard --location enam
npx wrangler@latest r2 bucket create goodwe-raw-archives
```

Copy the returned D1 database ID into both Wrangler TOML files. Apply the schema:

```bash
npx wrangler@latest d1 execute goodwe-dashboard --remote --file cloud/schema.sql
```

Generate the dashboard verifier locally. The passphrase is read without echo and should be saved
in the household password manager:

```bash
python3 cloud/tools/create_auth_verifier.py
```

Set the following Worker secrets through `wrangler secret put`; read their values from local files
or a hidden prompt, never from command-line arguments:

- Both Workers: `DEVICE_ID`, `REPORTING_TIME_ZONE`
- Ingestion Worker: `DEVICE_SECRET`, `DECODER_HASH`
- Dashboard Worker: `PASSPHRASE_VERIFIER`, `SESSION_SECRET`, `TURNSTILE_SECRET`
- Dashboard Worker private site settings: `REPORTING_TIME_ZONE`, `SITE_LATITUDE`,
  `SITE_LONGITUDE`, `PV_ARRAY_KWP`, optional `PV_TILT_DEG`/`PV_AZIMUTH_DEG`, and optional
  `BATTERY_CAPACITY_KWH`, `BATTERY_RESERVE_PCT`, and `INVERTER_RATED_W`

Deploy ingestion first and record its exact HTTPS URL:

```bash
npx wrangler@latest deploy -c cloud/wrangler.ingest.toml
npx wrangler@latest deploy -c cloud/wrangler.dashboard.toml
```

Upload `cloud/decoder-manifest.json` to the immutable R2 key
`decoders/<DECODER_HASH>.json`. Never replace an object at an existing decoder hash.

## Vercel and Turnstile

Replace the dashboard Worker placeholder in `vercel.json`, then authenticate and deploy:

```bash
npx vercel@latest login
npx vercel@latest --prod
```

Create a managed Turnstile widget restricted to the resulting stable `*.vercel.app` hostname:

```bash
npx wrangler@latest turnstile widget create goodwe-dashboard \
  --domain YOUR_STABLE_HOST.vercel.app --mode managed --region world --json
```

Store the returned secret as the dashboard Worker's `TURNSTILE_SECRET`. Put the public site key in
Vercel as `VITE_TURNSTILE_SITE_KEY`, redeploy the dashboard, and verify that the unauthenticated
network waterfall does not request the `App-*.js`, charts, motion, or telemetry endpoints.

## Local provisioning and first flash

Run the provisioning tool from the repository root:

```bash
python3 firmware/tools/provision.py --backup /path/to/esp32-original-4mb.bin
```

It prompts locally for the 2.4 GHz SSID/password, ingestion URL, HMAC secret, optional fixed inverter
address, and device UUID. It creates an NVS image in a temporary directory, requires the exact word
`FLASH`, verifies the complete pre-write backup, writes the already-built firmware and initialized
LittleFS image, then writes only the NVS partition. A private deployment record is retained under
`.private/`; it is ignored by Git.

## Production gates still requiring elapsed time

- Compare all decoder fields against live daytime/nighttime, import/export, and charge/discharge
  observations.
- Measure completed archive size for 24 hours and confirm at least 24 hours fits in LittleFS.
- Exercise Wi-Fi, Internet, inverter, NTP, Worker, D1/R2, reset, corruption, full queue, and quota
  failures independently.
- Complete the laptop-off 24-hour burn-in, then monitor seven days before declaring production.

Raw R2 objects are never automatically deleted. D1 keeps 10-second rows for 30 days, one-minute
aggregates for one year, and 15-minute/daily aggregates indefinitely.
