from __future__ import annotations

import csv
import io
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .analytics import CommandCenterAnalytics
from .collector import GoodWeCollector
from .config import settings
from .database import DashboardDatabase
from .forecast import ForecastCoordinator, OpenMeteoForecastProvider
from .models import (
    CommandCenterResponse,
    EventItem,
    HistoryResponse,
    NormalizedSnapshot,
    SensorReading,
    SummaryResponse,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

database = DashboardDatabase(
    settings.database_path, settings.timezone, settings.poll_interval_seconds
)
collector = GoodWeCollector(settings, database)
command_center_analytics = CommandCenterAnalytics(database, settings)
forecast_coordinator = (
    ForecastCoordinator(database, OpenMeteoForecastProvider(settings))
    if settings.forecast_configured
    else None
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await collector.start()
    if forecast_coordinator:
        await forecast_coordinator.start()
    yield
    if forecast_coordinator:
        await forecast_coordinator.stop()
    await collector.stop()
    database.close()


app = FastAPI(
    title="GoodWe Home API",
    version="1.0.0",
    description="Read-only local telemetry for GoodWe Home.",
    lifespan=lifespan,
)


@app.get("/api/v1/health")
def health() -> dict[str, object]:
    snapshot = collector.status()
    return {
        "ok": snapshot is not None and snapshot.connection.state == "live",
        "state": snapshot.connection.state if snapshot else "starting",
        "host": collector.inverter_host,
        "read_only": True,
    }


@app.get("/api/v1/status", response_model=NormalizedSnapshot)
def status() -> NormalizedSnapshot | JSONResponse:
    snapshot = collector.status()
    if snapshot is None:
        return JSONResponse(collector.starting_status(), status_code=503)
    return snapshot


@app.get("/api/v1/history", response_model=HistoryResponse)
def history(
    period: Annotated[Literal["day", "week", "month", "year"], Query()] = "day",
    anchor: Annotated[date | None, Query()] = None,
) -> HistoryResponse:
    return database.history(period, anchor)


@app.get("/api/v1/summary", response_model=SummaryResponse)
def summary(
    period: Annotated[Literal["day", "week", "month", "year"], Query()] = "day",
    anchor: Annotated[date | None, Query()] = None,
) -> SummaryResponse:
    return database.summary(period, anchor)


@app.get("/api/v1/sensors", response_model=list[SensorReading])
def sensors() -> list[SensorReading]:
    return collector.current_sensors


@app.get("/api/v1/events", response_model=list[EventItem])
def events(limit: Annotated[int, Query(ge=1, le=500)] = 100) -> list[EventItem]:
    return database.list_events(limit)


@app.get("/api/v1/command-center", response_model=CommandCenterResponse)
def command_center(
    trend_range: Annotated[
        Literal["15m", "1h", "3h", "6h", "12h", "24h"], Query(alias="range")
    ] = "24h",
    history_range: Annotated[Literal["14d", "30d", "60d", "12m"], Query(alias="history")] = "30d",
) -> CommandCenterResponse | JSONResponse:
    snapshot = collector.status()
    if snapshot is None:
        return JSONResponse(collector.starting_status(), status_code=503)
    return command_center_analytics.build(
        snapshot,
        trend_range=trend_range,
        history_range=history_range,
    )


@app.get("/api/v1/export.csv")
def export_csv(
    period: Annotated[Literal["day", "week", "month", "year"], Query()] = "day",
    anchor: Annotated[date | None, Query()] = None,
    dataset: Annotated[Literal["telemetry", "daily"], Query()] = "telemetry",
) -> StreamingResponse:
    rows = (
        database.export_daily_rows(period, anchor)
        if dataset == "daily"
        else database.export_rows(period, anchor)
    )
    buffer = io.StringIO()
    fieldnames = (
        [
            "day",
            "solar_kwh",
            "load_kwh",
            "export_kwh",
            "import_kwh",
            "battery_charge_kwh",
            "battery_discharge_kwh",
            "peak_pv_w",
            "peak_home_w",
        ]
        if dataset == "daily"
        else [
            "timestamp",
            "pv_w",
            "home_w",
            "grid_w",
            "battery_w",
            "backup_w",
            "battery_soc_pct",
            "grid_voltage_v",
            "grid_frequency_hz",
            "inverter_temperature_c",
        ]
    )
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": (
                f'attachment; filename="goodwe-home-daily-{period}.csv"'
                if dataset == "daily"
                else f'attachment; filename="goodwe-home-{period}.csv"'
            )
        },
    )


@app.get("/api/v1/stream")
async def stream(request: Request) -> StreamingResponse:
    async def event_source() -> AsyncIterator[str]:
        async for payload in collector.subscribe():
            if await request.is_disconnected():
                break
            yield f"event: snapshot\ndata: {payload}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if settings.static_dir.exists():
    assets = settings.static_dir / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def frontend(full_path: str) -> FileResponse:
        requested = (settings.static_dir / full_path).resolve()
        static_root = settings.static_dir.resolve()
        if requested.is_relative_to(static_root) and requested.is_file():
            return FileResponse(requested)
        index = settings.static_dir / "index.html"
        if index.exists():
            return FileResponse(index)
        raise HTTPException(status_code=404, detail="Dashboard build not found")
