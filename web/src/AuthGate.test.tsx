import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import AuthGate from './AuthGate';

vi.mock('./api', () => ({
  api: {
    session: vi.fn(),
    login: vi.fn(),
  },
}));
vi.mock('./App', () => ({ default: () => <div>Authenticated dashboard</div> }));

describe('authentication shell', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('shows no dashboard content until the session endpoint authenticates the browser', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
    vi.mocked(api.session).mockResolvedValue({ authenticated: false });
    render(<AuthGate />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Household dashboard' })).toBeVisible(),
    );
    expect(screen.getByLabelText('Passphrase')).toHaveAttribute('type', 'password');
    expect(screen.queryByText('Energy command center')).not.toBeInTheDocument();
  });

  it('returns an open dashboard to login when the session is expired or revoked', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
    vi.mocked(api.session).mockResolvedValue({ authenticated: true });
    render(<AuthGate />);
    await screen.findByText('Authenticated dashboard');

    window.dispatchEvent(new Event('goodwe-auth-required'));

    await screen.findByRole('heading', { name: 'Household dashboard' });
  });
});
