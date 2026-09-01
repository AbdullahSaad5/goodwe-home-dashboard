import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import AuthGate from './AuthGate';
import { shouldBypassDashboardAuth } from './authMode';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate
      localBypass={shouldBypassDashboardAuth({
        dev: import.meta.env.DEV,
        mode: import.meta.env.MODE,
      })}
    />
  </StrictMode>,
);
