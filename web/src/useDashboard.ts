import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  demoCommandCenter,
  demoEvents,
  demoHistory,
  demoSensors,
  demoSnapshot,
  demoSummary,
} from './demo';
import { shiftAnchor } from './period';
import type {
  CommandCenterResponse,
  CommandHistoryRange,
  EventItem,
  HistoryResponse,
  Period,
  SensorReading,
  Snapshot,
  Summary,
  TrendRange,
} from './types';

const DEFAULT_LIVE_REFRESH_MS = 10_000;
const MAX_LIVE_REFRESH_MS = 60_000;

export function useDashboard(
  period: Period,
  anchor: string,
  trendRange: TrendRange = '24h',
  commandHistoryRange: CommandHistoryRange = '30d',
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [comparisonSummary, setComparisonSummary] = useState<Summary | null>(null);
  const [sensors, setSensors] = useState<SensorReading[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [commandCenter, setCommandCenter] = useState<CommandCenterResponse | null>(null);
  const [commandCenterLoading, setCommandCenterLoading] = useState(true);
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + DEFAULT_LIVE_REFRESH_MS);
  const historyRequest = useRef(0);
  const lastSnapshotArrival = useRef<number | null>(null);
  const lastFailureCount = useRef(0);
  const liveRefreshEstimate = useRef(DEFAULT_LIVE_REFRESH_MS);

  const noteSnapshotArrival = useCallback((value: Snapshot) => {
    const now = Date.now();
    const previousArrival = lastSnapshotArrival.current;
    if (previousArrival !== null && lastFailureCount.current === 0) {
      const observedInterval = now - previousArrival;
      if (observedInterval >= 3_000 && observedInterval <= 30_000) {
        liveRefreshEstimate.current = Math.round(observedInterval / 1_000) * 1_000;
      }
    }

    const failureCount = value.connection.consecutive_failures;
    const retryMultiplier = 2 ** Math.max(0, failureCount - 1);
    const nextInterval = Math.min(
      liveRefreshEstimate.current * retryMultiplier,
      MAX_LIVE_REFRESH_MS,
    );
    lastSnapshotArrival.current = now;
    lastFailureCount.current = failureCount;
    setNextRefreshAt(now + nextInterval);
  }, []);

  const refreshHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    const comparison = api.summary(period, shiftAnchor(anchor, period, -1)).catch(() => null);
    try {
      const [newHistory, newSummary] = await Promise.all([
        api.history(period, anchor),
        api.summary(period, anchor),
      ]);
      if (request !== historyRequest.current) return;
      setHistory(newHistory);
      setSummary(newSummary);
      const previousSummary = await comparison;
      if (request === historyRequest.current) setComparisonSummary(previousSummary);
    } catch {
      if (request === historyRequest.current && import.meta.env.DEV) {
        setHistory({ ...demoHistory, period });
        setSummary({ ...demoSummary, period });
        setComparisonSummary(null);
        setPreview(true);
      }
    }
  }, [anchor, period]);

  const refreshReferenceData = useCallback(async () => {
    try {
      const [newSensors, newEvents] = await Promise.all([api.sensors(), api.events()]);
      setSensors(newSensors);
      setEvents(newEvents);
    } catch {
      if (import.meta.env.DEV) {
        setSensors(demoSensors);
        setEvents(demoEvents);
        setPreview(true);
      }
    }
  }, []);

  const refreshCommandCenter = useCallback(async () => {
    setCommandCenterLoading(true);
    try {
      setCommandCenter(await api.commandCenter(trendRange, commandHistoryRange));
    } catch {
      if (import.meta.env.DEV) {
        setCommandCenter({
          ...demoCommandCenter,
          trend: { ...demoCommandCenter.trend, range: trendRange },
        });
        setPreview(true);
      }
    } finally {
      setCommandCenterLoading(false);
    }
  }, [commandHistoryRange, trendRange]);

  const refreshSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const value = await api.status();
      setSnapshot(value);
      noteSnapshotArrival(value);
      setPreview(false);
    } catch {
      if (import.meta.env.DEV) {
        setSnapshot(demoSnapshot);
        noteSnapshotArrival(demoSnapshot);
        setPreview(true);
      }
    } finally {
      setLoading(false);
    }
  }, [noteSnapshotArrival]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    void refreshHistory();
    return () => {
      historyRequest.current += 1;
    };
  }, [refreshHistory]);

  useEffect(() => {
    void refreshReferenceData();
  }, [refreshReferenceData]);

  useEffect(() => {
    void refreshCommandCenter();
  }, [refreshCommandCenter]);

  const refreshDashboardData = useCallback(async () => {
    await Promise.all([refreshHistory(), refreshReferenceData(), refreshCommandCenter()]);
  }, [refreshCommandCenter, refreshHistory, refreshReferenceData]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshDashboardData(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshDashboardData]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      const timer = window.setInterval(() => void refreshSnapshot(), DEFAULT_LIVE_REFRESH_MS);
      return () => window.clearInterval(timer);
    }
    const stream = new EventSource('/api/v1/stream');
    stream.addEventListener('snapshot', (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data) as Snapshot;
        setSnapshot(value);
        noteSnapshotArrival(value);
        setPreview(false);
        setLoading(false);
        void refreshDashboardData();
      } catch {
        /* Ignore malformed updates; the next poll will recover. */
      }
    });
    return () => stream.close();
  }, [noteSnapshotArrival, refreshDashboardData, refreshSnapshot]);

  return {
    snapshot,
    history,
    summary,
    comparisonSummary,
    sensors,
    events,
    commandCenter,
    commandCenterLoading,
    preview,
    loading,
    nextRefreshAt,
    refreshSnapshot,
    refreshHistory,
    refreshReferenceData,
    refreshCommandCenter,
  };
}
