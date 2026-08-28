# GoodWe Home

A LAN-only, read-only dashboard for a GoodWe `GW6000-ES-C10` inverter. It reads local Modbus TCP telemetry, stores history in SQLite, and serves one responsive web interface to the home network.

![GoodWe Home dashboard](public/og.png)

## Requirements

- Python 3.11 or newer
- Node.js 22.13 or newer
- A supported GoodWe inverter reachable from the same local network

## Start

```sh
./setup.sh
./start.sh
```

Open `http://localhost:8080` on the laptop. Other devices on the same Wi-Fi can use `http://<laptop-ip>:8080`.

No inverter IP address is built into the dashboard. The first successful address is saved in the local SQLite database and tried first on later launches. If that address no longer responds, the collector discovers the inverter again, validates the new LAN address, and atomically replaces the saved value. `GOODWE_HOST` remains an optional explicit override and is tried before the saved address.

## What is included

- Concept B overview with live Solar → Home ↔ Battery ↔ Grid flow, an anchored energy chart, daily metrics, and operational health cards.
- Day, week, month and year calendar history with date navigation, synchronized ECharts tooltips, and CSV export.
- Dedicated solar/MPPT, battery/BMS, grid/load, system diagnostics and event views.
- A searchable Raw Data table that keeps all 145 GoodWe readings visible.
- Typed FastAPI contracts and live updates over Server-Sent Events.

The collector records core values every 10 seconds, complete raw snapshots once per minute, one-minute aggregates for one year, and 15-minute/daily aggregates without expiry. Core and raw samples are retained for 30 days. SQLite runs in WAL mode and reporting boundaries use `Asia/Karachi`.

## API

All application endpoints are read-only (`GET`):

- `/api/v1/status`
- `/api/v1/history?period=day|week|month|year&anchor=YYYY-MM-DD`
- `/api/v1/summary?period=day|week|month|year&anchor=YYYY-MM-DD`
- `/api/v1/sensors`
- `/api/v1/events`
- `/api/v1/export.csv?period=day|week|month|year&anchor=YYYY-MM-DD`
- `/api/v1/stream`

Battery power is positive when discharging and negative when charging. Grid-meter power is positive when exporting and negative when importing.
The optional `anchor` parameter uses Asia/Karachi calendar boundaries; omitting it preserves the rolling-period behavior for existing clients.

## Safety and privacy

- The collector calls only GoodWe read operations.
- No inverter configuration endpoints exist.
- The app has no cloud dependency and makes no external runtime requests.
- Keep the dashboard and inverter on a trusted LAN. Do not port-forward either service.
- The laptop must remain awake for continuous history collection.

## Development

Run `.venv/bin/uvicorn backend.main:app --port 8080` and `npm run dev` in another terminal. Vite proxies `/api` to FastAPI. Run `.venv/bin/pytest`, `npm run lint` and `npm run build` before release.

## License

MIT
