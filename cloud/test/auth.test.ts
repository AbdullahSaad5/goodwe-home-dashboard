import { beforeEach, describe, expect, it } from 'vitest';
import {
  createPassphraseVerifier,
  handleAuthRequest,
  type AuthConfig,
  type AuthThrottle,
  verifyTurnstile,
} from '../src/auth';

class MemoryThrottle implements AuthThrottle {
  failures = new Map<string, number[]>();

  async failedAttempts(key: string, sinceMs: number): Promise<number> {
    return (this.failures.get(key) ?? []).filter((value) => value >= sinceMs).length;
  }

  async recordFailure(key: string, atMs: number): Promise<void> {
    this.failures.set(key, [...(this.failures.get(key) ?? []), atMs]);
  }

  async clearFailures(key: string): Promise<void> {
    this.failures.delete(key);
  }
}

describe('dashboard authentication', () => {
  let config: AuthConfig;
  let throttle: MemoryThrottle;

  beforeEach(async () => {
    throttle = new MemoryThrottle();
    config = {
      passphraseVerifier: await createPassphraseVerifier(
        'correct horse battery staple with several extra words',
        Uint8Array.from({ length: 16 }, (_, index) => index + 1),
        10_000,
      ),
      sessionSecret: 'test-only-session-secret-that-is-long-enough',
      turnstileSecret: 'turnstile-secret',
      sessionDays: 30,
      maxFailures: 3,
      failureWindowSeconds: 900,
      now: () => new Date('2026-08-29T17:00:00.000Z'),
      verifyTurnstile: async (token) => token === 'human-token',
    };
  });

  it('issues a secure 30-day cookie and validates the resulting session', async () => {
    const login = await handleAuthRequest(
      new Request('https://dashboard.example/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' },
        body: JSON.stringify({
          passphrase: 'correct horse battery staple with several extra words',
          turnstileToken: 'human-token',
        }),
      }),
      config,
      throttle,
    );

    expect(login.status).toBe(204);
    const cookie = login.headers.get('Set-Cookie')!;
    expect(cookie).toContain('goodwe_session=');
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');

    const session = await handleAuthRequest(
      new Request('https://dashboard.example/api/v1/auth/session', {
        headers: { Cookie: cookie.split(';')[0] },
      }),
      config,
      throttle,
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({ authenticated: true });
  });

  it('requires Turnstile, records failures, and throttles without setting a cookie', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handleAuthRequest(
        new Request('https://dashboard.example/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.11' },
          body: JSON.stringify({ passphrase: 'wrong', turnstileToken: 'human-token' }),
        }),
        config,
        throttle,
      );
      expect(response.status).toBe(401);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    }

    const blocked = await handleAuthRequest(
      new Request('https://dashboard.example/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.11' },
        body: JSON.stringify({
          passphrase: 'correct horse battery staple with several extra words',
          turnstileToken: 'human-token',
        }),
      }),
      config,
      throttle,
    );
    expect(blocked.status).toBe(429);
  });

  it('rejects a verifier above the Cloudflare PBKDF2 limit without throwing', async () => {
    const response = await handleAuthRequest(
      new Request('https://dashboard.example/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.12' },
        body: JSON.stringify({
          passphrase: 'correct horse battery staple with several extra words',
          turnstileToken: 'human-token',
        }),
      }),
      {
        ...config,
        passphraseVerifier: { ...config.passphraseVerifier, iterations: 100_001 },
      },
      throttle,
    );

    expect(response.status).toBe(401);
  });

  it('expires the browser cookie on logout', async () => {
    const response = await handleAuthRequest(
      new Request('https://dashboard.example/api/v1/auth/logout', { method: 'POST' }),
      config,
      throttle,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('does not bind Turnstile verification to the Vercel proxy address', async () => {
    const originalFetch = globalThis.fetch;
    let submitted: FormData | undefined;
    globalThis.fetch = async (_input, init) => {
      submitted = init?.body as FormData;
      return Response.json({ success: true });
    };
    try {
      await expect(
        verifyTurnstile('human-token', '198.51.100.20', 'turnstile-secret'),
      ).resolves.toBe(true);
      expect(submitted?.get('response')).toBe('human-token');
      expect(submitted?.get('secret')).toBe('turnstile-secret');
      expect(submitted?.has('remoteip')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
