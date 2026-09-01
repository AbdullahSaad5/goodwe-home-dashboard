export interface PassphraseVerifier {
  algorithm: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  hash: string;
}

export interface AuthThrottle {
  failedAttempts(key: string, sinceMs: number): Promise<number>;
  recordFailure(key: string, atMs: number): Promise<void>;
  clearFailures(key: string): Promise<void>;
}

export interface AuthConfig {
  passphraseVerifier: PassphraseVerifier;
  sessionSecret: string;
  turnstileSecret: string;
  sessionDays: number;
  maxFailures: number;
  failureWindowSeconds: number;
  now: () => Date;
  verifyTurnstile: (token: string, remoteIp: string, secret: string) => Promise<boolean>;
}

const COOKIE = 'goodwe_session';
const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error('Invalid hexadecimal value');
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function createPassphraseVerifier(
  passphrase: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  iterations = 600_000,
): Promise<PassphraseVerifier> {
  if (passphrase.length < 12) throw new Error('Passphrase must contain at least 12 characters');
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToHex(salt),
    hash: bytesToHex(await derivePassphrase(passphrase, salt, iterations)),
  };
}

async function verifyPassphrase(
  passphrase: string,
  verifier: PassphraseVerifier,
): Promise<boolean> {
  if (verifier.algorithm !== 'PBKDF2-SHA256' || verifier.iterations < 10_000) return false;
  const expected = hexToBytes(verifier.hash);
  const actual = await derivePassphrase(passphrase, hexToBytes(verifier.salt), verifier.iterations);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1)
    difference |= actual[index] ^ expected[index];
  return difference === 0;
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function issueSession(now: Date, config: AuthConfig): Promise<string> {
  const expires = Math.floor(now.valueOf() / 1000) + config.sessionDays * 86_400;
  const payload = base64Url(encoder.encode(JSON.stringify({ version: 1, expires })));
  return `${payload}.${await sign(payload, config.sessionSecret)}`;
}

function cookieValue(request: Request): string | null {
  const cookies = request.headers.get('Cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export async function hasValidSession(request: Request, config: AuthConfig): Promise<boolean> {
  const value = cookieValue(request);
  if (!value) return false;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return false;
  const expected = await sign(payload, config.sessionSecret);
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < signature.length; index += 1) {
    difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      version?: number;
      expires?: number;
    };
    return (
      parsed.version === 1 &&
      typeof parsed.expires === 'number' &&
      parsed.expires > config.now().valueOf() / 1000
    );
  } catch {
    return false;
  }
}

function response(status: number, value?: unknown): Response {
  if (value === undefined)
    return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function handleAuthRequest(
  request: Request,
  config: AuthConfig,
  throttle: AuthThrottle,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api/v1/auth/session' && request.method === 'GET') {
    return response(200, { authenticated: await hasValidSession(request, config) });
  }
  if (path === '/api/v1/auth/logout' && request.method === 'POST') {
    const result = response(204);
    result.headers.set(
      'Set-Cookie',
      `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    return result;
  }
  if (path !== '/api/v1/auth/login' || request.method !== 'POST')
    return response(404, { error: 'not_found' });
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return response(415, { error: 'unsupported_content_type' });
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const since = config.now().valueOf() - config.failureWindowSeconds * 1000;
  if ((await throttle.failedAttempts(remoteIp, since)) >= config.maxFailures) {
    return response(429, { error: 'too_many_attempts' });
  }

  let body: { passphrase?: unknown; turnstileToken?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return response(400, { error: 'invalid_request' });
  }
  const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  const human =
    token.length > 0 && (await config.verifyTurnstile(token, remoteIp, config.turnstileSecret));
  const valid = human && (await verifyPassphrase(passphrase, config.passphraseVerifier));
  if (!valid) {
    await throttle.recordFailure(remoteIp, config.now().valueOf());
    return response(401, { error: 'invalid_credentials' });
  }

  await throttle.clearFailures(remoteIp);
  const maxAge = config.sessionDays * 86_400;
  const result = response(204);
  result.headers.set(
    'Set-Cookie',
    `${COOKIE}=${await issueSession(config.now(), config)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
  );
  return result;
}

export async function verifyTurnstile(
  token: string,
  _remoteIp: string,
  secret: string,
): Promise<boolean> {
  const body = new FormData();
  body.set('secret', secret);
  body.set('response', token);
  // Vercel's external rewrite reaches the Worker from a proxy address, not the
  // browser address bound to the Turnstile token. The remoteip field is optional;
  // omitting it keeps verification correct while CF-Connecting-IP still keys the
  // server-side throttle.
  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  if (!result.ok) return false;
  const payload = (await result.json()) as { success?: boolean };
  return payload.success === true;
}
