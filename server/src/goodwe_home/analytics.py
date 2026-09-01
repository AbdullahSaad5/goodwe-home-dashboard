from __future__ import annotations

import statistics
from datetime import UTC, datetime, timedelta

from .config import Settings
from .database import DashboardDatabase
from .models import (
    BatteryReserveInsight,
    CommandCenterResponse,
    EnergyCounters,
    EnergyMix,
    ForecastInsight,
    HealthSignal,
    LiveCommandCenter,
    NormalizedSnapshot,
    OutageBand,
    OutageBucket,
    OutageOutlookInsight,
    ProjectionInsight,
    ProjectionPoint,
    ReadinessState,
    RecordMetric,
    TodayInsight,
    TrendData,
    WatchdogInsight,
    WatchdogMetric,
)

RANGE_SECONDS = {
    "15m": 15 * 60,
    "1h": 3600,
    "3h": 3 * 3600,
    "6h": 6 * 3600,
    "12h": 12 * 3600,
    "24h": 24 * 3600,
}
HISTORY_DAYS = {"14d": 14, "30d": 30, "60d": 60, "12m": 365}


class CommandCenterAnalytics:
    """Builds the complete command-center view through one stable interface."""

    def __init__(self, database: DashboardDatabase, settings: Settings) -> None:
        self.database = database
        self.settings = settings

    def build(
        self,
        snapshot: NormalizedSnapshot,
        *,
        trend_range: str = "24h",
        history_range: str = "30d",
        now: datetime | None = None,
    ) -> CommandCenterResponse:
        generated_at = now or datetime.now(UTC)
        seconds = RANGE_SECONDS.get(trend_range, RANGE_SECONDS["24h"])
        history_days = HISTORY_DAYS.get(history_range, HISTORY_DAYS["30d"])
        history = self.database.short_history(seconds, generated_at)
        daily = self.database.daily_history(history_days, generated_at)
        learning_days = [
            point
            for point in self.database.daily_history(365, generated_at)
            if point.coverage_pct >= 90
            and point.day != generated_at.astimezone(self.database.timezone).date().isoformat()
        ][-30:]
        daylight_valid_days = {
            observation.day
            for observation in self.database.daylight_coverage_observations(generated_at, days=30)
            if observation.sample_count / observation.expected_samples >= 0.9
        }
        outage_cutoff = (
            datetime.combine(
                datetime.fromisoformat(learning_days[0].day).date(),
                datetime.min.time(),
                tzinfo=self.database.timezone,
            ).astimezone(UTC)
            if learning_days
            else generated_at - timedelta(days=30)
        )
        all_outages = [
            outage
            for outage in self.database.list_outages(limit=500)
            if outage.start_at >= outage_cutoff
        ]
        outages = all_outages[:14]
        local_day = generated_at.astimezone(self.database.timezone).date().isoformat()
        valid_days = len(learning_days)
        completed_outages = sum(not outage.ongoing for outage in all_outages)

        live = self._live(snapshot)
        forecast = self._forecast(daylight_valid_days, generated_at)
        outage_outlook = self._outage_outlook(
            all_outages, valid_days, completed_outages, generated_at
        )
        projection = self._projection(snapshot, forecast, outage_outlook, valid_days, generated_at)
        record_daily = self.database.daily_history(36500, generated_at)
        record_outages = self.database.list_outages(limit=10000)
        records = self._records(record_daily, record_outages)
        telemetry_status = (
            "ready"
            if snapshot.connection.state == "live"
            else "stale"
            if snapshot.connection.state == "stale"
            else "unavailable"
        )
        telemetry_reason = (
            "Live inverter telemetry"
            if telemetry_status == "ready"
            else "The latest inverter telemetry is stale"
            if telemetry_status == "stale"
            else "The inverter collector is offline"
        )
        readiness = {
            **{
                group: ReadinessState(status=telemetry_status, reason=telemetry_reason)
                for group in ("live", "health", "trend", "today")
            },
            "daily_history": ReadinessState(
                status="ready" if daily else "collecting",
                reason=(
                    "Available from retained local summaries"
                    if daily
                    else "Waiting for the first daily summary"
                ),
            ),
            "lifetime": ReadinessState(
                status="ready", reason="Reported by the inverter's retained counters"
            ),
            "records": ReadinessState(
                status="ready" if records else "collecting",
                reason=(
                    "Calculated from coverage-valid retained summaries"
                    if records
                    else "Waiting for a coverage-valid daily record"
                ),
            ),
            "outages": ReadinessState(
                status="ready" if valid_days >= 14 else "collecting",
                reason=(
                    "Confirmed outage history is available"
                    if valid_days >= 14
                    else "Collecting coverage before confirming an outage-free history"
                ),
            ),
            "solar_forecast": ReadinessState(
                status=forecast.status,
                reason=forecast.reason,
                observed=forecast.calibration_days,
                required=7,
            ),
            "load_profile": ReadinessState(
                status="ready" if valid_days >= 15 else "collecting",
                reason=(
                    "Fifteen valid days are available"
                    if valid_days >= 15
                    else "Learning the home's quarter-hour load profile"
                ),
                observed=valid_days,
                required=15,
            ),
            "outage_outlook": ReadinessState(
                status="ready" if valid_days >= 14 and completed_outages >= 3 else "collecting",
                reason=(
                    "Outage timing history is ready"
                    if valid_days >= 14 and completed_outages >= 3
                    else "Collecting valid days and confirmed grid outages"
                ),
                observed=min(valid_days, 14),
                required=14,
            ),
            "battery_efficiency": ReadinessState(
                status="ready" if valid_days >= 14 else "collecting",
                reason=(
                    "Battery throughput window is ready"
                    if valid_days >= 14
                    else "Collecting battery charge and discharge history"
                ),
                observed=valid_days,
                required=14,
            ),
        }

        return CommandCenterResponse(
            generated_at=generated_at,
            live=live,
            health=self._health(snapshot, live, forecast),
            trend=TrendData(
                range=trend_range,
                resolution=history.resolution,
                points=history.points,
                outages=[OutageBand(start=item.start_at, end=item.end_at) for item in outages],
            ),
            today=TodayInsight(
                energy=snapshot.today,
                yesterday_same_time=self.database.yesterday_same_time(generated_at),
                grid_independence_pct=snapshot.insights.grid_independence_pct,
                solar_self_consumption_pct=snapshot.insights.solar_retention_pct,
                peaks=self.database.daily_peaks(local_day),
            ),
            daily_history=daily,
            period_totals=self._period_totals(daily),
            lifetime=snapshot.lifetime,
            records=records,
            outages=outages,
            outage_outlook=outage_outlook,
            forecast=forecast,
            projection=projection,
            watchdog=self._watchdog(
                snapshot,
                daily,
                valid_days,
                len(daylight_valid_days),
                forecast,
                generated_at,
            ),
            readiness=readiness,
        )

    def _period_totals(self, daily: list) -> EnergyCounters:
        return EnergyCounters(
            solar_kwh=sum(point.energy.solar_kwh for point in daily),
            load_kwh=sum(point.energy.load_kwh for point in daily),
            export_kwh=sum(point.energy.export_kwh for point in daily),
            import_kwh=sum(point.energy.import_kwh for point in daily),
            battery_charge_kwh=sum(point.energy.battery_charge_kwh for point in daily),
            battery_discharge_kwh=sum(point.energy.battery_discharge_kwh for point in daily),
        )

    def _live(self, snapshot: NormalizedSnapshot) -> LiveCommandCenter:
        home = max(0, snapshot.power.home_w)
        pv = max(0, snapshot.power.pv_w)
        grid_export = max(0, snapshot.power.grid_w)
        grid_import = max(0, -snapshot.power.grid_w)
        battery_discharge = max(0, snapshot.power.battery_w)
        solar = min(max(0, pv - grid_export), home)
        remaining = max(0, home - solar)
        battery = min(battery_discharge, remaining)
        remaining = max(0, remaining - battery)
        grid = min(grid_import, remaining)
        total = solar + battery + grid
        unaccounted = max(0, home - total)
        tolerance = max(50, home * 0.05)
        measured_balance = pv + snapshot.power.battery_w - snapshot.power.grid_w
        balance = "balanced" if abs(measured_balance - home) <= tolerance else "mismatch"

        if home > 0:
            solar_pct = solar / home * 100
            battery_pct = battery / home * 100
            grid_pct = grid / home * 100
            unaccounted_pct = unaccounted / home * 100
        else:
            solar_pct = battery_pct = grid_pct = unaccounted_pct = 0

        reserve = self._battery_reserve(snapshot)
        utilization = (
            min(100, home / self.settings.inverter_rated_w * 100)
            if self.settings.inverter_rated_w
            else None
        )
        dominant = max(
            (("solar", solar), ("battery", battery), ("grid", grid)), key=lambda item: item[1]
        )
        explanation = (
            "No household demand is currently measured."
            if home <= 0
            else f"{dominant[0].capitalize()} is supplying most of the current home demand."
        )
        return LiveCommandCenter(
            headline=snapshot.headline,
            explanation=explanation,
            dominant_power_w=dominant[1],
            energy_mix=EnergyMix(
                home_w=home,
                solar_w=solar,
                battery_w=battery,
                grid_w=grid,
                unaccounted_w=unaccounted,
                solar_pct=solar_pct,
                battery_pct=battery_pct,
                grid_pct=grid_pct,
                unaccounted_pct=unaccounted_pct,
            ),
            solar_coverage_pct=solar_pct if home else None,
            inverter_utilization_pct=utilization,
            power_balance=balance,
            battery_reserve=reserve,
        )

    def _battery_reserve(self, snapshot: NormalizedSnapshot) -> BatteryReserveInsight:
        capacity = self.settings.battery_capacity_kwh
        if capacity is None:
            return BatteryReserveInsight(
                status="unconfigured",
                reason="Set BATTERY_CAPACITY_KWH to calculate reserve energy and runtime",
            )
        margin = max(0, snapshot.battery.soc_pct - self.settings.battery_reserve_pct)
        effective_capacity = capacity * max(0, snapshot.battery.soh_pct or 100) / 100
        available = effective_capacity * margin / 100
        discharge_w = max(0, snapshot.power.battery_w)
        runtime = available / (discharge_w / 1000) if discharge_w > 50 else None
        return BatteryReserveInsight(
            status="ready",
            reason="Calculated from configured capacity, reserve floor, SOC and SOH",
            available_kwh=available,
            reserve_margin_pct=margin,
            runtime_hours=runtime,
        )

    def _health(
        self,
        snapshot: NormalizedSnapshot,
        live: LiveCommandCenter,
        forecast: ForecastInsight,
    ) -> list[HealthSignal]:
        grid_healthy = snapshot.grid.voltage_v >= 180 and 45 <= snapshot.grid.frequency_hz <= 55
        inverter_temp = snapshot.system.temperature_radiator_c
        battery_temp = snapshot.battery.temperature_c
        thermal_status = (
            "warning" if inverter_temp >= 60 or not 5 <= battery_temp <= 40 else "healthy"
        )
        reserve_status = (
            "unknown"
            if live.battery_reserve.status != "ready"
            else "warning"
            if (live.battery_reserve.reserve_margin_pct or 0) <= 5
            else "healthy"
        )
        signals = [
            HealthSignal(
                id="grid",
                label="Grid health",
                status="healthy" if grid_healthy else "warning",
                value="Healthy" if grid_healthy else "Unavailable",
                detail=f"{snapshot.grid.voltage_v:.1f} V · {snapshot.grid.frequency_hz:.2f} Hz",
            ),
            HealthSignal(
                id="reserve",
                label="Battery reserve",
                status=reserve_status,
                value=(
                    f"{live.battery_reserve.reserve_margin_pct:.0f}% margin"
                    if live.battery_reserve.reserve_margin_pct is not None
                    else "Not configured"
                ),
                detail=live.battery_reserve.reason,
            ),
            HealthSignal(
                id="thermal",
                label="Thermals",
                status=thermal_status,
                value="Normal" if thermal_status == "healthy" else "Check",
                detail=f"Inverter {inverter_temp:.1f}°C · Battery {battery_temp:.1f}°C",
            ),
            HealthSignal(
                id="daylight",
                label="Solar expectation",
                status=(
                    "healthy"
                    if forecast.status == "ready"
                    else "warning"
                    if forecast.status == "stale"
                    else "unknown"
                ),
                value=(
                    f"{forecast.today_kwh:.1f} kWh today"
                    if forecast.today_kwh is not None
                    else "Forecast unavailable"
                ),
                detail=forecast.reason,
            ),
            HealthSignal(
                id="inverter",
                label="Inverter health",
                status=snapshot.system.health,
                value=snapshot.system.health.capitalize(),
                detail=snapshot.system.errors or "No active fault text",
            ),
        ]
        if snapshot.connection.state != "live":
            stale_status = "stale" if snapshot.connection.state == "stale" else "unavailable"
            return [
                signal.model_copy(
                    update={
                        "status": stale_status,
                        "value": stale_status.capitalize(),
                        "detail": f"Telemetry is {stale_status}; {signal.detail}",
                    }
                )
                for signal in signals
            ]
        return signals

    def _forecast(self, valid_days: set[str], now: datetime) -> ForecastInsight:
        if self.settings.site_latitude is None or self.settings.site_longitude is None:
            return ForecastInsight(
                status="unconfigured",
                reason="Set SITE_LATITUDE and SITE_LONGITUDE to enable the opt-in forecast",
            )
        run = self.database.latest_forecast()
        if run is None:
            last_error = self.database.get_runtime_setting("forecast_last_error")
            return ForecastInsight(
                status="unavailable" if last_error else "collecting",
                reason=(
                    "The latest forecast refresh failed; inverter collection is unaffected"
                    if last_error
                    else "Waiting for the first successful Open-Meteo forecast run"
                ),
                provider="Open-Meteo",
                calibration_days=len(valid_days),
            )
        if self.settings.pv_array_kwp is None:
            return ForecastInsight(
                status="unconfigured",
                reason="Set PV_ARRAY_KWP before converting irradiance into expected production",
                provider=run.provider,
                updated_at=run.issued_at,
                weather_days=run.weather_days,
            )
        calibration = self.database.forecast_calibration_observations(now, valid_days)
        calibration_days = len(calibration)
        calibration_factor = (
            max(
                0.5,
                min(
                    1.5,
                    statistics.median(
                        item.actual_kwh / item.predicted_kwh
                        for item in calibration
                        if item.predicted_kwh > 0
                    ),
                ),
            )
            if calibration
            else 1.0
        )
        if calibration_days < 7:
            return ForecastInsight(
                status="collecting",
                reason="Seven valid days are required before showing calibrated solar estimates",
                provider=run.provider,
                updated_at=run.issued_at,
                calibration_days=calibration_days,
                weather_days=run.weather_days,
            )
        calibrated_points = [
            point.model_copy(
                update={
                    "pv_w": (point.pv_w * calibration_factor) if point.pv_w is not None else None
                }
            )
            for point in run.points
        ]
        local_today = now.astimezone(self.database.timezone).date()
        local_tomorrow = local_today + timedelta(days=1)
        today_kwh = sum(
            (point.pv_w or 0) / 1000
            for point in calibrated_points
            if point.timestamp.astimezone(self.database.timezone).date() == local_today
        )
        tomorrow_kwh = sum(
            (point.pv_w or 0) / 1000
            for point in calibrated_points
            if point.timestamp.astimezone(self.database.timezone).date() == local_tomorrow
        )
        age_hours = max(0, (now - run.issued_at).total_seconds() / 3600)
        return ForecastInsight(
            status="stale" if age_hours > 6 else "ready",
            reason=(
                "The latest forecast is more than six hours old"
                if age_hours > 6
                else "Weather-adjusted production estimate calibrated from valid observations"
            ),
            provider=run.provider,
            updated_at=run.issued_at,
            today_kwh=today_kwh,
            tomorrow_kwh=tomorrow_kwh,
            calibration_days=calibration_days,
            points=calibrated_points,
            weather_days=run.weather_days,
        )

    def _projection(
        self,
        snapshot: NormalizedSnapshot,
        forecast: ForecastInsight,
        outage_outlook: OutageOutlookInsight,
        valid_days: int,
        now: datetime,
    ) -> ProjectionInsight:
        if self.settings.battery_capacity_kwh is None:
            return ProjectionInsight(
                status="unconfigured",
                reason="Set BATTERY_CAPACITY_KWH before projecting state of charge",
            )
        if forecast.status != "ready" or valid_days < 15:
            return ProjectionInsight(
                status="collecting",
                reason=(
                    "Projection needs a ready solar forecast and fifteen valid load-profile days"
                ),
            )
        observations, weekday_days, weekend_days = self.database.load_observations(now)
        combined_values: dict[int, list[float]] = {}
        weekday_values: dict[int, list[float]] = {}
        weekend_values: dict[int, list[float]] = {}
        for observation in observations:
            combined_values.setdefault(observation.minute_of_day, []).append(observation.home_w)
            target = weekend_values if observation.weekend else weekday_values
            target.setdefault(observation.minute_of_day, []).append(observation.home_w)
        combined = {minute: statistics.median(values) for minute, values in combined_values.items()}
        weekday = {minute: statistics.median(values) for minute, values in weekday_values.items()}
        weekend = {minute: statistics.median(values) for minute, values in weekend_values.items()}
        if len(combined) < 80:
            return ProjectionInsight(
                status="collecting",
                reason="Quarter-hour load coverage is not complete enough for projection",
            )
        forecast_by_hour = {
            point.timestamp.replace(minute=0, second=0, microsecond=0): point.pv_w or 0
            for point in forecast.points
        }
        likely_buckets = {
            bucket.minute_of_day
            for bucket in outage_outlook.buckets
            if bucket.probability_pct >= 50
        }
        capacity = self.settings.battery_capacity_kwh or 0
        effective_capacity = capacity * max(0, snapshot.battery.soh_pct or 100) / 100
        reserve = self.settings.battery_reserve_pct
        soc = snapshot.battery.soc_pct
        cursor = now.replace(second=0, microsecond=0)
        cursor += timedelta(minutes=(15 - cursor.minute % 15) % 15)
        points = []
        for _ in range(96):
            local = cursor.astimezone(self.database.timezone)
            minute = local.hour * 60 + (local.minute // 15) * 15
            forecast_hour = cursor.replace(minute=0, second=0, microsecond=0)
            pv_w = forecast_by_hour.get(forecast_hour, 0)
            category_profile = (
                weekend
                if local.weekday() >= 5 and weekend_days >= 4
                else weekday
                if local.weekday() < 5 and weekday_days >= 4
                else combined
            )
            load_w = category_profile.get(minute, combined.get(minute, snapshot.power.home_w))
            outage_likely = (minute // 30) * 30 in likely_buckets
            if effective_capacity > 0 and pv_w > load_w:
                charged_kwh = (pv_w - load_w) / 1000 * 0.25 * 0.92
                soc = min(100, soc + charged_kwh / effective_capacity * 100)
            elif effective_capacity > 0 and outage_likely and load_w > pv_w:
                discharged_kwh = (load_w - pv_w) / 1000 * 0.25 / 0.92
                soc = max(reserve, soc - discharged_kwh / effective_capacity * 100)
            points.append(
                ProjectionPoint(
                    timestamp=cursor,
                    pv_w=pv_w,
                    load_w=load_w,
                    soc_pct=soc,
                    outage_likely=outage_likely,
                )
            )
            cursor += timedelta(minutes=15)
        lowest = min(points, key=lambda point: point.soc_pct)
        return ProjectionInsight(
            status="ready",
            reason="Conservative outage-reserve projection using forecast PV and learned load",
            lowest_soc_pct=lowest.soc_pct,
            lowest_soc_at=lowest.timestamp,
            points=points,
        )

    def _outage_outlook(
        self,
        outages,
        valid_days: int,
        completed_outages: int,
        now: datetime,
    ) -> OutageOutlookInsight:
        ready = valid_days >= 14 and completed_outages >= 3
        if not ready:
            return OutageOutlookInsight(
                status="collecting",
                reason="Fourteen valid days and three confirmed outages are required",
                observed_days=valid_days,
                outage_count=completed_outages,
            )
        bucket_days: dict[int, set[str]] = {minute: set() for minute in range(0, 1440, 30)}
        durations: list[float] = []
        for outage in outages:
            if outage.end_at is None:
                continue
            durations.append((outage.duration_seconds or 0) / 60)
            cursor = outage.start_at.astimezone(self.database.timezone)
            end = outage.end_at.astimezone(self.database.timezone)
            day = cursor.date().isoformat()
            while cursor <= end:
                minute = cursor.hour * 60 + (cursor.minute // 30) * 30
                bucket_days[minute].add(day)
                cursor += timedelta(minutes=30)
        buckets = [
            OutageBucket(
                minute_of_day=minute,
                probability_pct=len(days) / valid_days * 100,
            )
            for minute, days in bucket_days.items()
        ]
        likely = [bucket.minute_of_day for bucket in buckets if bucket.probability_pct >= 50]
        next_start = next_end = None
        if likely:
            local_now = now.astimezone(self.database.timezone)
            for offset in range(49):
                candidate = local_now + timedelta(minutes=offset * 30)
                minute = candidate.hour * 60 + (candidate.minute // 30) * 30
                if minute in likely:
                    next_start = candidate.replace(
                        minute=(candidate.minute // 30) * 30, second=0, microsecond=0
                    )
                    next_end = next_start + timedelta(minutes=30)
                    while (next_end.hour * 60 + (next_end.minute // 30) * 30) in likely:
                        next_end += timedelta(minutes=30)
                    break
        return OutageOutlookInsight(
            status="ready",
            reason="Calculated from confirmed local outage intervals",
            observed_days=valid_days,
            outage_count=completed_outages,
            next_window_start=next_start,
            next_window_end=next_end,
            typical_duration_minutes=statistics.median(durations) if durations else None,
            buckets=buckets,
        )

    def _records(self, daily: list, outages: list) -> list[RecordMetric]:
        eligible = [point for point in daily if point.coverage_pct >= 90]
        records: list[RecordMetric] = []
        if eligible:
            for record_id, label, attribute, unit in (
                ("best_pv_day", "Best PV day", "solar_kwh", "kWh"),
                ("heaviest_load_day", "Heaviest load day", "load_kwh", "kWh"),
                ("biggest_export_day", "Biggest export day", "export_kwh", "kWh"),
            ):
                point = max(eligible, key=lambda item: getattr(item.energy, attribute))
                records.append(
                    RecordMetric(
                        id=record_id,
                        label=label,
                        value=getattr(point.energy, attribute),
                        unit=unit,
                        day=point.day,
                    )
                )
        completed = [item for item in outages if item.duration_seconds is not None]
        if completed:
            outage = max(completed, key=lambda item: item.duration_seconds or 0)
            records.append(
                RecordMetric(
                    id="longest_outage",
                    label="Longest outage",
                    value=outage.duration_seconds or 0,
                    unit="seconds",
                    day=outage.start_at.astimezone(self.database.timezone).date().isoformat(),
                )
            )
        return records

    def _watchdog(
        self,
        snapshot,
        daily,
        valid_days: int,
        solar_valid_days: int,
        forecast: ForecastInsight,
        now: datetime,
    ) -> WatchdogInsight:
        charge = sum(point.energy.battery_charge_kwh for point in daily)
        discharge = sum(point.energy.battery_discharge_kwh for point in daily)
        efficiency = discharge / charge * 100 if charge >= 5 else None
        mppt_totals = self.database.mppt_totals(now)
        watt_samples_to_kwh = 0.25 / 1000
        mppt1_kwh = (
            mppt_totals.mppt1_w_samples * watt_samples_to_kwh
            if mppt_totals.mppt1_w_samples is not None
            else None
        )
        mppt2_kwh = (
            mppt_totals.mppt2_w_samples * watt_samples_to_kwh
            if mppt_totals.mppt2_w_samples is not None
            else None
        )
        string_total = (
            mppt1_kwh + mppt2_kwh if mppt1_kwh is not None and mppt2_kwh is not None else None
        )
        string_value = (
            f"{mppt1_kwh / string_total * 100:.0f}% / {mppt2_kwh / string_total * 100:.0f}%"
            if string_total is not None and string_total > 0
            else "Learning"
        )
        string_ready = solar_valid_days >= 7 and string_total is not None and string_total > 0
        expected_so_far = sum(
            (point.pv_w or 0) / 1000
            for point in forecast.points
            if point.timestamp <= now
            and point.timestamp.astimezone(self.database.timezone).date()
            == now.astimezone(self.database.timezone).date()
        )
        pv_performance = (
            snapshot.today.solar_kwh / expected_so_far * 100 if expected_so_far > 0 else None
        )
        metrics = [
            WatchdogMetric(
                id="pv_performance",
                label="PV performance",
                status=(
                    "ready"
                    if forecast.status == "ready" and pv_performance is not None
                    else "collecting"
                ),
                value=(
                    f"{pv_performance:.0f}% of expected"
                    if pv_performance is not None
                    else "Learning"
                ),
                detail="Actual production compared with today's weather-adjusted expectation",
            ),
            WatchdogMetric(
                id="string_balance",
                label="PV string balance",
                status="ready" if string_ready else "collecting",
                value=string_value if string_ready else "Learning",
                detail=f"{solar_valid_days} of 7 valid generation days",
            ),
            WatchdogMetric(
                id="battery_efficiency",
                label="Battery round-trip",
                status="ready" if valid_days >= 14 and efficiency is not None else "collecting",
                value=(
                    f"{efficiency:.0f}%"
                    if efficiency is not None and valid_days >= 14
                    else "Learning"
                ),
                detail="Discharged energy divided by charged energy over the selected history",
            ),
        ]
        return WatchdogInsight(
            status="ready" if all(metric.status == "ready" for metric in metrics) else "collecting",
            reason="Health signals are advisory and become available as observations accumulate",
            metrics=metrics,
            recommendation=(
                "Review the inverter or BMS if a ready metric remains outside its normal range."
                if snapshot.system.health != "healthy"
                else "No evidence-based maintenance recommendation is currently available."
            ),
        )
