import asyncio
from datetime import UTC, date, datetime, timedelta
from typing import ClassVar

import goodwe_home.forecast as forecast_module
import pytest
from goodwe_home.config import Settings
from goodwe_home.database import DashboardDatabase
from goodwe_home.forecast import ForecastCoordinator, ForecastRun, OpenMeteoForecastProvider
from goodwe_home.models import ForecastPoint, WeatherDay


class FakeForecastProvider:
    name = "Fake weather"

    async def fetch(self, now: datetime) -> ForecastRun:
        return ForecastRun(
            provider=self.name,
            issued_at=now,
            points=[
                ForecastPoint(
                    timestamp=now + timedelta(hours=hour),
                    irradiance_w_m2=500,
                    pv_w=3200,
                )
                for hour in range(24)
            ],
            weather_days=[
                WeatherDay(
                    day=date(2026, 8, 29),
                    weather_code=2,
                    temperature_max_c=33.5,
                    temperature_min_c=24.0,
                    precipitation_probability_max_pct=20,
                    precipitation_mm=0.4,
                    wind_speed_max_kph=17.0,
                    sunrise=datetime(2026, 8, 29, 0, 30, tzinfo=UTC),
                    sunset=datetime(2026, 8, 29, 13, 30, tzinfo=UTC),
                )
            ],
            metadata={"source": "test"},
        )


class FailingForecastProvider:
    name = "Failed weather"

    async def fetch(self, now: datetime) -> ForecastRun:
        raise TimeoutError("forecast timeout")


class FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return {
            "hourly": {
                "time": ["2026-08-29T10:00"],
                "shortwave_radiation": [500],
            },
            "daily": {
                "time": ["2026-08-29"],
                "weather_code": [2],
                "temperature_2m_max": [33.5],
                "temperature_2m_min": [24.0],
                "precipitation_probability_max": [20],
                "precipitation_sum": [0.4],
                "wind_speed_10m_max": [17.0],
                "sunrise": ["2026-08-29T05:42"],
                "sunset": ["2026-08-29T18:31"],
            },
        }


class FakeAsyncClient:
    requested_params: ClassVar[dict[str, object]] = {}

    def __init__(self, **_: object) -> None:
        pass

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get(self, _: str, params: dict[str, object]) -> FakeResponse:
        type(self).requested_params = params
        return FakeResponse()


def test_forecast_coordinator_caches_provider_results(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    now = datetime(2026, 8, 28, 12, tzinfo=UTC)
    coordinator = ForecastCoordinator(database, FakeForecastProvider())

    asyncio.run(coordinator.refresh_once(now))

    cached = database.latest_forecast()
    assert cached is not None
    assert cached.provider == "Fake weather"
    assert cached.issued_at == now
    assert len(cached.points) == 24
    assert cached.points[0].pv_w == 3200
    assert len(cached.weather_days) == 1
    assert cached.weather_days[0].temperature_max_c == 33.5
    database.close()


def test_open_meteo_provider_returns_seven_day_weather(monkeypatch) -> None:
    monkeypatch.setattr(forecast_module.httpx, "AsyncClient", FakeAsyncClient)
    provider = OpenMeteoForecastProvider(
        Settings(
            site_latitude=1,
            site_longitude=1,
            pv_array_kwp=8,
            timezone="Asia/Karachi",
        )
    )

    run = asyncio.run(provider.fetch(datetime(2026, 8, 29, 5, tzinfo=UTC)))

    assert FakeAsyncClient.requested_params["forecast_days"] == 7
    assert FakeAsyncClient.requested_params["timezone"] == "Asia/Karachi"
    assert "temperature_2m_max" in str(FakeAsyncClient.requested_params["daily"])
    assert run.points[0].timestamp.isoformat() == "2026-08-29T10:00:00+05:00"
    assert run.weather_days[0].day == date(2026, 8, 29)
    assert run.weather_days[0].temperature_max_c == 33.5
    assert run.weather_days[0].sunrise.isoformat() == "2026-08-29T05:42:00+05:00"


def test_open_meteo_provider_preserves_missing_weather_as_unknown(monkeypatch) -> None:
    monkeypatch.setattr(forecast_module.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(
        FakeResponse,
        "json",
        lambda _: {
            "hourly": {"time": ["2026-08-29T10:00"], "shortwave_radiation": [500]},
            "daily": {"time": ["2026-08-29"]},
        },
    )
    provider = OpenMeteoForecastProvider(
        Settings(site_latitude=1, site_longitude=1, timezone="Asia/Karachi")
    )

    run = asyncio.run(provider.fetch(datetime(2026, 8, 29, 5, tzinfo=UTC)))

    day = run.weather_days[0]
    assert day.weather_code is None
    assert day.temperature_max_c is None
    assert day.precipitation_mm is None


def test_forecast_coordinator_is_disabled_without_coordinates(tmp_path) -> None:
    settings = Settings(site_latitude=None, site_longitude=None)
    assert settings.forecast_configured is False


def test_forecast_failure_is_recorded_without_losing_the_exception(tmp_path) -> None:
    database = DashboardDatabase(tmp_path / "dashboard.sqlite3", "Asia/Karachi")
    coordinator = ForecastCoordinator(database, FailingForecastProvider())

    with pytest.raises(TimeoutError):
        asyncio.run(coordinator.refresh_once(datetime(2026, 8, 28, 12, tzinfo=UTC)))

    assert database.get_runtime_setting("forecast_last_error") == "forecast timeout"
    database.close()
