from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    inverter_host: str | None = os.getenv("GOODWE_HOST") or None
    inverter_port: int = int(os.getenv("GOODWE_PORT", "502"))
    poll_interval_seconds: int = int(os.getenv("POLL_INTERVAL_SECONDS", "10"))
    stale_after_seconds: int = int(os.getenv("STALE_AFTER_SECONDS", "30"))
    timezone: str = os.getenv("DASHBOARD_TIMEZONE", "Asia/Karachi")
    database_path: Path = Path(
        os.getenv("DATABASE_PATH", str(PROJECT_ROOT / "data" / "goodwe.sqlite3"))
    )
    static_dir: Path = Path(os.getenv("STATIC_DIR", str(PROJECT_ROOT / "dist")))
    display_model: str = "GW6000-ES-C10"


settings = Settings()
