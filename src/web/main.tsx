import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './app/auth';
import { Workspace } from './app/shell';
import { initializeDrafts } from './app/drafts';
import './styles.css';
void initializeDrafts().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthGate>
        <Workspace />
      </AuthGate>
    </StrictMode>,
  ),
);
