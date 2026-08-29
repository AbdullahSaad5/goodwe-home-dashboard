import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from './api';

const DashboardApp = lazy(() => import('./App'));

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: Record<string, unknown>): string;
      reset(widgetId?: string): void;
    };
  }
}

export function LoginShell({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

  useEffect(() => {
    if (!siteKey || !widget.current) return;
    const render = () => {
      if (!widget.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(widget.current, {
        sitekey: siteKey,
        callback: (token: string) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setError('Human verification could not load. Please retry.'),
        theme: 'auto',
      });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-goodwe-turnstile]');
    if (existing) {
      existing.addEventListener('load', render);
      render();
      return () => existing.removeEventListener('load', render);
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.goodweTurnstile = 'true';
    script.addEventListener('load', render);
    document.head.append(script);
    return () => script.removeEventListener('load', render);
  }, [siteKey]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!turnstileToken) {
      setError('Complete the human verification first.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.login(passphrase, turnstileToken);
      onAuthenticated();
    } catch {
      setError('The passphrase or verification was not accepted.');
      setTurnstileToken('');
      window.turnstile?.reset(widgetId.current);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-brand" aria-label="GoodWe Home">
          <strong className="goodwe-wordmark">GOODWE</strong>
          <span>GoodWe Home</span>
        </div>
        <h1>Household dashboard</h1>
        <p>Enter the shared household passphrase to view live and historical energy data.</p>
        <label htmlFor="passphrase">Passphrase</label>
        <input
          id="passphrase"
          name="passphrase"
          type="password"
          autoComplete="current-password"
          minLength={20}
          required
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
        <div ref={widget} className="turnstile-slot" aria-label="Human verification" />
        {!siteKey ? <p className="login-error">Turnstile is not configured.</p> : null}
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={submitting || !siteKey}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

export default function AuthGate({ localBypass = false }: { localBypass?: boolean }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(localBypass ? true : null);
  useEffect(() => {
    if (localBypass) return;
    void api
      .session()
      .then((value) => setAuthenticated(value.authenticated))
      .catch(() => setAuthenticated(false));
  }, [localBypass]);
  useEffect(() => {
    if (localBypass) return;
    const requireAuthentication = () => setAuthenticated(false);
    window.addEventListener('goodwe-auth-required', requireAuthentication);
    return () => window.removeEventListener('goodwe-auth-required', requireAuthentication);
  }, [localBypass]);

  if (authenticated === null) return <main className="login-shell">Checking session…</main>;
  if (!authenticated) return <LoginShell onAuthenticated={() => setAuthenticated(true)} />;
  return (
    <Suspense fallback={<main className="login-shell">Loading dashboard…</main>}>
      <DashboardApp />
    </Suspense>
  );
}
