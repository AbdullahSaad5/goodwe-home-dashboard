from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _optional_float(name: str) -> float | None:
    value = os.getenv(name)
    return float(value) if value not in {None, ""} else None


@dataclass(frozen=True)
class Settings:
    inverter_host: str | None = os.getenv("GOODWE_HOST") or None
    inverter_port: int = int(os.getenv("GOODWE_PORT", "502"))
    poll_interval_seconds: int = int(os.getenv("POLL_INTERVAL_SECONDS", "10"))
    stale_after_seconds: int = int(os.getenv("STALE_AFTER_SECONDS", "30"))
    timezone: str = os.getenv("DASHBOARD_TIMEZONE", "Asia/Karachi")
    database_path: Path = Path(os.getenv("DATABASE_PATH", "data/goodwe.sqlite3"))
    static_dir: Path = Path(os.getenv("STATIC_DIR", "web/dist"))
    display_model: str = "GW6000-ES-C10"
    battery_capacity_kwh: float | None = _optional_float("BATTERY_CAPACITY_KWH")
    battery_reserve_pct: float = float(os.getenv("BATTERY_RESERVE_PCT", "20"))
    inverter_rated_w: float | None = _optional_float("INVERTER_RATED_W")
    site_latitude: float | None = _optional_float("SITE_LATITUDE")
    site_longitude: float | None = _optional_float("SITE_LONGITUDE")
    pv_array_kwp: float | None = _optional_float("PV_ARRAY_KWP")
    pv_tilt_deg: float | None = _optional_float("PV_TILT_DEG")
    pv_azimuth_deg: float | None = _optional_float("PV_AZIMUTH_DEG")

    @property
    def forecast_configured(self) -> bool:
        return self.site_latitude is not None and self.site_longitude is not None


settings = Settings()
