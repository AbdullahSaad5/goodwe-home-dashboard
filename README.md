# GoodWe Home

A modern, self-hosted dashboard for monitoring a GoodWe solar inverter directly over your local network.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)

GoodWe Home shows live production, household demand, battery activity, and grid exchange without sending telemetry to a cloud service.

It is read-only by design. The dashboard never changes inverter settings, operating modes, battery limits, or export controls.

![GoodWe Home dashboard](public/og.png)

> [!NOTE]
> This is an independent community project and is not affiliated with or endorsed by GoodWe Technologies Co., Ltd.

## Highlights

- Live Solar → Home ↔ Battery ↔ Grid power-flow visualization
- Animated values and directional arrows driven by real telemetry
- Automatic inverter discovery with a persistent last-known address
- Day, week, month, and year energy charts with date navigation
- Solar, MPPT, battery, BMS, grid, load, and system diagnostics
- Local event history, searchable raw sensors, and CSV export
- Responsive desktop, tablet, and mobile interface
- SQLite history with no external database or cloud dependency
- Server-Sent Events for live updates without page refreshes

## Quick start

### Requirements

- Python 3.11 or newer
- Node.js 22.13 or newer
- A supported GoodWe inverter on the same LAN

### Install and run

```bash
git clone https://github.com/AbdullahSaad5/goodwe-home-dashboard.git
cd goodwe-home-dashboard
./setup.sh
./start.sh
```

Open [http://localhost:8080](http://localhost:8080). Other devices on the same network can use `http://<computer-ip>:8080`.

The dashboard is intended for trusted local networks. Do not expose port 8080 or the inverter directly to the public internet.

## Inverter discovery

No inverter IP address is built into the project.

On startup, the collector follows this order:

1. Try `GOODWE_HOST` when explicitly provided.
2. Try the last working address saved in SQLite.
3. Use the GoodWe LAN discovery broadcast.
4. Check the active local `/24` network on the configured inverter port.
5. Validate the responder as a supported GoodWe inverter.
6. Replace the saved address when the inverter moves.

After the first successful discovery, later launches normally connect directly to the saved address without scanning.

## Configuration

Configuration is supplied through environment variables. Every setting is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOODWE_HOST` | Automatic | Optional inverter address override |
| `GOODWE_PORT` | `502` | Local inverter communication port |
| `POLL_INTERVAL_SECONDS` | `10` | Live telemetry polling interval |
| `STALE_AFTER_SECONDS` | `30` | Age before readings are marked stale |
| `DASHBOARD_TIMEZONE` | `Asia/Karachi` | Calendar boundaries and reporting timezone |
| `DATABASE_PATH` | `data/goodwe.sqlite3` | Local SQLite database path |
| `STATIC_DIR` | `dist` | Built frontend directory |
| `PORT` | `8080` | Dashboard web-server port |

Example:

```bash
DASHBOARD_TIMEZONE=America/Toronto PORT=8080 ./start.sh
```

## Dashboard sections

| Section | Contents |
| --- | --- |
| Overview | Live power flow, energy chart, daily totals, MPPT, battery, grid quality, and alerts |
| History | Anchored day, week, month, and year charts with CSV export |
| Solar | PV production, MPPT voltage, current, power, and operating state |
| Battery | SOC, SOH, voltage, current, temperatures, cell spread, limits, and BMS details |
| Grid & Loads | Import/export, voltage, frequency, apparent power, reactive power, and meter state |
| System | Inverter health, firmware, clocks, temperatures, registers, and local events |
| Raw Data | Searchable access to every sensor returned by the inverter |

## Data storage

By default, application data stays in `data/goodwe.sqlite3`, which is excluded from Git.

- Core telemetry is sampled every 10 seconds by default.
- Complete raw snapshots are retained once per minute.
- Core samples and raw snapshots are retained for 30 days.
- One-minute aggregates are retained for one year.
- Longer-term 15-minute and daily aggregates are retained indefinitely.
- The last working inverter address is saved in the same database.

SQLite runs in WAL mode so the dashboard can read history while the collector writes new samples.

## API

Every dashboard API endpoint is read-only.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Collector health and active inverter address |
| `GET /api/v1/status` | Latest normalized snapshot |
| `GET /api/v1/history` | Time-series history for a selected period |
| `GET /api/v1/summary` | Aggregated energy and availability metrics |
| `GET /api/v1/sensors` | Latest raw sensor readings |
| `GET /api/v1/events` | Local collector and inverter events |
| `GET /api/v1/export.csv` | CSV export for a selected period |
| `GET /api/v1/stream` | Live snapshot stream over SSE |

History, summary, and export requests accept `period=day|week|month|year` and an optional `anchor=YYYY-MM-DD`.

Battery power is positive while discharging and negative while charging. Grid power is positive while exporting and negative while importing.

## Architecture

- **Collector:** Python and `goodwe` read local inverter telemetry.
- **Storage:** SQLite stores snapshots, aggregates, events, and the last working address.
- **API:** FastAPI exposes read-only JSON, CSV, and SSE endpoints.
- **Interface:** React, TypeScript, Vite, ECharts, Motion, Radix UI, and Tailwind CSS.

The browser communicates only with the local FastAPI service. It does not connect directly to the inverter.

## Development

Install dependencies once:

```bash
./setup.sh
```

Run the backend and frontend development servers in separate terminals:

```bash
.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8080
```

```bash
npm run dev
```

Run the checks before submitting changes:

```bash
.venv/bin/pytest
npm test
npm run build
```

## Security and privacy

- Inverter communication is read-only.
- No inverter credentials or IP addresses are committed to Git.
- Telemetry and history stay on the local machine.
- The SQLite database and environment files are ignored by Git.
- No configuration or control endpoints are exposed.

Review your network rules before running the server on an untrusted or shared network.

## License

Released under the [MIT License](LICENSE).
