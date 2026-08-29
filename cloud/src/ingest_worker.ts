import { CloudflareRepository } from './cloudflare';
import type { WorkerEnv } from './env';
import { handleIngestionRequest } from './ingestion';

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const repository = new CloudflareRepository(
      env.DB,
      env.ARCHIVES,
      () => new Date(),
      env.REPORTING_TIME_ZONE ?? 'UTC',
    );
    return handleIngestionRequest(
      request,
      {
        deviceId: env.DEVICE_ID,
        deviceSecret: env.DEVICE_SECRET,
        maxClockSkewSeconds: Number(env.MAX_CLOCK_SKEW_SECONDS ?? 900),
        r2GuardBytes: Number(env.R2_GUARD_BYTES),
        acceptedDecoderHashes: [env.DECODER_HASH.toLowerCase()],
        acceptedTimestampSources: [1],
        now: () => new Date(),
      },
      repository,
    );
  },
};
