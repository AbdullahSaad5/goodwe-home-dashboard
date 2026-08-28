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
                           FastAPI + SSE
                                   │
                                   ▼
                            React dashboard
```

The browser never talks to the inverter directly. The server exposes no endpoints that alter inverter settings.

## Backend modules

The installable Python package lives in `server/src/goodwe_home/`.

| Module             | Responsibility                                                                         |
| ------------------ | -------------------------------------------------------------------------------------- |
| `config.py`        | Parses environment configuration and owns filesystem defaults.                         |
| `discovery.py`     | Finds and validates an inverter without requiring a hard-coded address.                |
| `collector.py`     | Owns connection lifecycle, polling, retries, persistence, and live subscriptions.      |
| `normalization.py` | Translates protocol-specific sensor data into the stable application model.            |
| `models.py`        | Defines API and persistence data contracts.                                            |
| `database.py`      | Owns the SQLite schema, retention, aggregation, events, and runtime settings.          |
| `main.py`          | Composes dependencies and exposes the read-only HTTP, CSV, static, and SSE interfaces. |

Discovery is deliberately hidden behind `discover_inverter(port)`. The collector decides when discovery is needed; discovery decides how the local network is searched.

## Frontend modules

The React application lives in `web/src/`.

- `api.ts` owns HTTP and SSE transport.
- `useDashboard.ts` owns remote state and refresh behavior.
- `types.ts` mirrors stable API contracts.
- `DashboardPages.tsx` composes application pages.
- `DashboardComponents.tsx` contains dashboard-specific presentation components.
- `components/ui/` contains reusable interface primitives.
- `format.ts`, `period.ts`, and `ui.ts` contain testable presentation logic.

Vite treats `web/` as its source root and writes the production bundle to `web/dist/`, which FastAPI serves.

## Data lifecycle

1. Configuration optionally supplies an inverter address.
2. The collector tries the configured address, then the last working address stored in SQLite.
3. Discovery broadcasts on the LAN and falls back to a bounded scan of active local `/24` networks.
4. A validated address is saved for the next launch.
5. Poll results are normalized, recorded, and broadcast to connected browsers.
6. SQLite rollups and retention keep recent detail while preserving long-term summaries.

## Invariants

- Inverter operations are read-only.
- Network discovery is local and bounded.
- Runtime addresses and telemetry are never source-controlled.
- API response shapes are defined by Pydantic models and covered by contract tests.
- The frontend consumes the server API rather than protocol-specific data.

## Extension points

When adding inverter support, prefer extending normalization and fixtures without leaking model-specific fields into routes or UI components. When adding a new API concept, define its model first, add persistence only when required, and keep transport details in `api.ts` on the frontend.
