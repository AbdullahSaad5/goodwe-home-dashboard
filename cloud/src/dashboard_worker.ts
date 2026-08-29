import { handleAuthRequest, hasValidSession, verifyTurnstile } from './auth';
import { CloudflareRepository } from './cloudflare';
import { handleDashboardApi } from './dashboard_api';
import { passphraseVerifier, type WorkerEnv } from './env';
import { runScheduledMaintenance } from './maintenance';

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function privateCopy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    const repository = new CloudflareRepository(env.DB, env.ARCHIVES);
    const authConfig = {
      passphraseVerifier: passphraseVerifier(env),
      sessionSecret: env.SESSION_SECRET,
      turnstileSecret: env.TURNSTILE_SECRET,
      sessionDays: 30,
      maxFailures: 5,
      failureWindowSeconds: 900,
      now: () => new Date(),
      verifyTurnstile,
    };
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/v1/auth/')) {
      return handleAuthRequest(request, authConfig, repository);
    }
    if (!(await hasValidSession(request, authConfig))) {
      return Response.json(
        { error: 'unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const cacheable =
      request.method === 'GET' &&
      [
        '/api/v1/history',
        '/api/v1/summary',
        '/api/v1/sensors',
        '/api/v1/events',
        '/api/v1/command-center',
      ].includes(path);
    const cache = (caches as CacheStorage & { default: Cache }).default;
    const cacheKey = new Request(request.url, { method: 'GET' });
    if (cacheable) {
      const cached = await cache.match(cacheKey);
      if (cached) return privateCopy(cached);
    }
    const response = await handleDashboardApi(
      request,
      {
        deviceId: env.DEVICE_ID,
        reportingTimezone: env.REPORTING_TIME_ZONE ?? 'UTC',
        batteryCapacityKwh: env.BATTERY_CAPACITY_KWH ? Number(env.BATTERY_CAPACITY_KWH) : undefined,
        batteryReservePct: Number(env.BATTERY_RESERVE_PCT ?? 20),
        inverterRatedW: env.INVERTER_RATED_W ? Number(env.INVERTER_RATED_W) : undefined,
        now: () => new Date(),
      },
      env.DB,
    );
    if (cacheable && response.status === 200) {
      const cached = response.clone();
      cached.headers.set('Cache-Control', 'public, max-age=300');
      context.waitUntil(cache.put(cacheKey, cached));
    }
    return response;
  },
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    await runScheduledMaintenance(env, new Date());
  },
};
