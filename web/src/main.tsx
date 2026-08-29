import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import AuthGate from './AuthGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate localBypass={import.meta.env.DEV} />
  </StrictMode>,
);
