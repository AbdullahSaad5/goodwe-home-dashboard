import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from goodwe_home.config import Settings
from goodwe_home.database import DashboardDatabase
from goodwe_home.forecast import ForecastCoordinator, ForecastRun
from goodwe_home.models import ForecastPoint


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
            metadata={"source": "test"},
        )


class FailingForecastProvider:
    name = "Failed weather"

    async def fetch(self, now: datetime) -> ForecastRun:
        raise TimeoutError("forecast timeout")


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
    database.close()


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
