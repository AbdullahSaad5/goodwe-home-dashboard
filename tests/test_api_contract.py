from backend.main import app
from fastapi.testclient import TestClient


def test_public_api_is_read_only() -> None:
    api_routes = [route for route in app.routes if getattr(route, "path", "").startswith("/api/")]
    assert api_routes
    for route in api_routes:
        methods = getattr(route, "methods", set())
        assert methods <= {"GET", "HEAD"}


def test_required_endpoints_exist() -> None:
    paths = {getattr(route, "path", "") for route in app.routes}
    assert {
        "/api/v1/status",
        "/api/v1/history",
        "/api/v1/summary",
        "/api/v1/sensors",
        "/api/v1/events",
        "/api/v1/export.csv",
        "/api/v1/stream",
    } <= paths


def test_history_accepts_an_optional_anchor_date() -> None:
    response = TestClient(app).get(
        "/api/v1/history", params={"period": "day", "anchor": "2026-08-20"}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["start"].startswith("2026-08-19T19:00:00")
    assert payload["end"].startswith("2026-08-20T19:00:00")


def test_summary_and_csv_accept_optional_anchor_dates() -> None:
    client = TestClient(app)
    summary = client.get("/api/v1/summary", params={"period": "month", "anchor": "1990-01-15"})
    assert summary.status_code == 200
    assert summary.json()["availability_pct"] == 0
    assert summary.json()["energy"] == {
        "solar_kwh": 0,
        "load_kwh": 0,
        "export_kwh": 0,
        "import_kwh": 0,
        "battery_charge_kwh": 0,
        "battery_discharge_kwh": 0,
    }

    exported = client.get("/api/v1/export.csv", params={"period": "day", "anchor": "1990-01-15"})
    assert exported.status_code == 200
    assert exported.headers["content-disposition"] == 'attachment; filename="goodwe-home-day.csv"'
    assert exported.text.startswith("timestamp,pv_w,home_w,grid_w,battery_w")
