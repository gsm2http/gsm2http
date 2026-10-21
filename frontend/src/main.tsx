import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { TokenGate } from './components/TokenGate';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <TokenGate>{(signOut) => <App onSignOut={signOut} />}</TokenGate>
  </StrictMode>,
);
