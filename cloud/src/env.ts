import type { PassphraseVerifier } from './auth';
import type { D1Database, R2Bucket } from './cloudflare';

export interface WorkerEnv {
  DB: D1Database;
  ARCHIVES: R2Bucket;
  DEVICE_ID: string;
  DEVICE_SECRET: string;
  DECODER_HASH: string;
  R2_GUARD_BYTES: string;
  MAX_CLOCK_SKEW_SECONDS?: string;
  PASSPHRASE_VERIFIER: string;
  SESSION_SECRET: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  REPORTING_TIME_ZONE?: string;
  SITE_LATITUDE?: string;
  SITE_LONGITUDE?: string;
  PV_ARRAY_KWP?: string;
  PV_TILT_DEG?: string;
  PV_AZIMUTH_DEG?: string;
  BATTERY_CAPACITY_KWH?: string;
  BATTERY_RESERVE_PCT?: string;
  INVERTER_RATED_W?: string;
}

export function passphraseVerifier(env: WorkerEnv): PassphraseVerifier {
  const parsed = JSON.parse(env.PASSPHRASE_VERIFIER) as PassphraseVerifier;
  if (parsed.algorithm !== 'PBKDF2-SHA256') throw new Error('Invalid PASSPHRASE_VERIFIER');
  return parsed;
}
