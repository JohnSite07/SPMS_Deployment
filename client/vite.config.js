import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SecureVault frontend build config (PRD 0010). The static bundle this
// produces is served by the Express app (Cloud Run) — see the serving
// follow-up in docs/action_plan/0010-react-frontend-scaffold.md.
export default defineConfig({
  plugins: [react()],
});
