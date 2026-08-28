# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Extended Overview into an operational command center with quick trends, table mode, energy mix, projections, history, outages, forecasts, watchdogs, reserve intelligence, records, and timestamped peaks.
- Added a persistent, system-aware light/dark theme across the dashboard, charts, connecting experience, responsive navigation, menus, and wall mode.
- Added readiness-explicit `GET /api/v1/command-center` and daily CSV export while preserving all existing interfaces.
- Added versioned SQLite migration, pre-migration backup, retained outage/record/peak summaries, nullable MPPT and battery-temperature history, and 60-day forecast caching.
- Added opt-in Open-Meteo solar forecasting, learned load profiles, calibrated production, advisory system-health checks, wall mode, and foreground desktop notifications.
- Contributor guidelines, security policy, issue forms, pull request template, and continuous integration.
- Python packaging, Ruff, ESLint, Prettier, and shared Makefile commands.

### Changed

- Separated the Python service into `server/` and the React application into `web/`.
- Isolated inverter discovery behind a dedicated backend module.
- Improved the responsive dashboard and connecting experience while retaining the GoodWe Home product name and existing visual system.
- Reworked Event history into compact diagnostic rows with plain-language fault, connectivity, discovery, and collector explanations.
- Consolidated alerts, event counts, and desktop-notification controls into one header menu.
- Tightened Event history guidance into content-sized, vertically aligned rows with clearly separated labels.

### Fixed

- Merged retained live telemetry into aggregate-backed trends so Power Trends and week, month, and year charts advance between hourly rollups and show new outage shading immediately.
- Initialized header clocks and refresh countdowns at component mount so long-running sessions cannot inherit a stale module-load timestamp.
- Synchronized Power Trends, calendar charts, summaries, sensors, events, and Command Center intelligence with each live snapshot, with a coordinated 60-second fallback refresh.
- Preserved ECharts zoom windows when refreshed points arrive while still resetting charts for intentional range, period, or anchor-date changes.
- Prevented live chart refreshes and time-selection changes from replaying the initial line-drawing animation.
- Exposed stored inverter fault details and meanings instead of internal event keys and generic error messages.
- Prevented the initial connecting experience from remaining stuck when collector data becomes available.

## 1.0.0 - 2026-08-28

### Added

- Initial public release of the LAN-only GoodWe monitoring dashboard.

[Unreleased]: https://github.com/AbdullahSaad5/goodwe-home-dashboard/commits/main
