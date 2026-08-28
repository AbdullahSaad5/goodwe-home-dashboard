# Architecture

GoodWe Home is a local, read-only monitoring application. One Python process collects inverter telemetry, persists history, serves an HTTP API, and hosts a compiled React interface.

## System boundaries

```text
GoodWe inverter
      │ local read-only protocol
      ▼
collector ──► normalization ──► SQLite
      │                            │
      └──────── current state ─────┤
                                   ▼
                CommandCenterAnalytics + FastAPI + SSE
                                   │
                                   ▼
                            React dashboard
```

The browser never talks to the inverter directly. The server exposes no endpoints that alter inverter settings.

## Backend modules

The installable Python package lives in `server/src/goodwe_home/`.

| Module             | Responsibility                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `config.py`        | Parses environment configuration and owns filesystem defaults.                                  |
| `discovery.py`     | Finds and validates an inverter without requiring a hard-coded address.                         |
| `collector.py`     | Owns connection lifecycle, polling, retries, persistence, and live subscriptions.               |
| `normalization.py` | Translates protocol-specific sensor data into the stable application model.                     |
| `models.py`        | Defines API and persistence data contracts.                                                     |
| `database.py`      | Owns the SQLite schema, retention, aggregation, events, and runtime settings.                   |
| `analytics.py`     | Owns command-center formulas, readiness gates, records, forecasts, projections, and narratives. |
| `forecast.py`      | Isolates the optional Open-Meteo adapter and three-hour cache coordinator.                      |
| `main.py`          | Composes dependencies and exposes the read-only HTTP, CSV, static, and SSE interfaces.          |

Discovery is deliberately hidden behind `discover_inverter(port)`. The collector decides when discovery is needed; discovery decides how the local network is searched.

## Frontend modules

The React application lives in `web/src/`.

- `api.ts` owns HTTP and SSE transport.
- `useDashboard.ts` owns remote state and refresh behavior.
- `types.ts` mirrors stable API contracts.
- `DashboardPages.tsx` composes application pages.
- `DashboardComponents.tsx` contains dashboard-specific presentation components.
- `CommandCenterComponents.tsx` renders presentation-ready command-center groups without duplicating analytics.
- `components/ui/` contains reusable interface primitives.
- `theme.tsx` owns the light/dark contract, persisted-choice resolution, React context, and canvas chart colors.
- `format.ts`, `period.ts`, and `ui.ts` contain testable presentation logic.

Vite treats `web/` as its source root and writes the production bundle to `web/dist/`, which FastAPI serves.

### Frontend refresh and chart state

`useDashboard.ts` treats each valid SSE snapshot as the live refresh signal. It applies the snapshot immediately and concurrently refreshes the selected history and comparison summaries, Command Center response, raw sensors, and events. The same coordinator runs every 60 seconds as a fallback when SSE delivery is delayed or disconnected. Request revisions prevent an older history response from replacing a newer selection.

ECharts updates within the same range replace series data without replacing the chart's `dataZoom` component. This preserves a user's zoom window as new points arrive. Power Trends is keyed by its quick range, while History, Solar, Battery, and Grid charts are keyed by period and anchor date; changing one of those controls intentionally creates a fresh full-range chart.

### Frontend appearance

An inline bootstrap in `web/index.html` resolves the saved appearance or the first-visit `prefers-color-scheme` value before CSS renders, preventing a light flash. `App.tsx` keeps the document theme, browser theme color, and React theme context synchronized. CSS variables and dark variants theme DOM surfaces; `DashboardComponents.tsx` consumes the same context for ECharts colors because canvas-rendered axes, tooltips, and labels cannot inherit CSS variables after rendering.

## Data lifecycle

1. Configuration optionally supplies an inverter address.
2. The collector tries the configured address, then the last working address stored in SQLite.
3. Discovery broadcasts on the LAN and falls back to a bounded scan of active local `/24` networks.
4. A validated address is saved for the next launch.
5. Poll results are normalized, recorded, and broadcast to connected browsers.
6. SQLite rollups and retention keep recent detail while preserving long-term summaries.
7. Live grid observations pass through a 30-second outage debounce; missing polls are not interpreted as outages.
8. When configured, the weather adapter refreshes independently every three hours and retains the last successful run.
9. `CommandCenterAnalytics` combines current state and retained facts into readiness-explicit API groups.
10. The browser uses each snapshot broadcast to refresh all dependent read models together; a 60-second timer provides a fallback cycle.

## Invariants

- Inverter operations are read-only.
- Network discovery is local and bounded.
- Runtime addresses and telemetry are never source-controlled.
- API response shapes are defined by Pydantic models and covered by contract tests.
- The frontend consumes the server API rather than protocol-specific data.
- React never reimplements command-center formulas or substitutes zero for unavailable facts.
- Forecast failures cannot stop or delay inverter collection.
- SQLite migrations are versioned and preserve a one-time pre-migration backup.
- A visible live refresh must update every dependent frontend dataset, not only snapshot cards.
- Same-context chart refreshes must preserve user-controlled zoom; explicit range, period, or date changes reset it.
- Light and dark modes preserve the same semantic solar, load, battery, grid, warning, and error meanings.

## Extension points

When adding inverter support, prefer extending normalization and fixtures without leaking model-specific fields into routes or UI components. When adding a new API concept, define its model first, add persistence only when required, and keep transport details in `api.ts` on the frontend.

Refresh changes belong in `useDashboard.ts` so the header countdown and dependent datasets cannot drift onto separate clocks. Chart update changes belong in `DashboardComponents.tsx`; retain the same-context zoom regression in `chartRefresh.test.ts` and reset chart state explicitly through range/period/anchor keys.
