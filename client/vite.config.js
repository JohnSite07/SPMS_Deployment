/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SecureVault frontend build config (PRD 0010). The static bundle this
// produces is served by the Express app (Cloud Run) — see the serving
// follow-up in docs/action_plan/0011-frontend-serving-and-cd-integration.md.
export default defineConfig({
  plugins: [react()],
  // Bootstrap 5.3 still uses @import and legacy SASS built-ins, which Dart Sass
  // now flags as deprecated; quiet those (they're from node_modules, not our
  // code) plus the @import our theme.scss uses to override tokens.
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        quietDeps: true,
        silenceDeprecations: ['import', 'color-functions', 'global-builtin'],
      },
    },
  },
  // Dev-only: forward /api to the local Express backend so client code always
  // calls the relative /api, identical to production (PRD 0012, Decision 2).
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  // Vitest: service-layer unit tests mock fetch, so the plain node environment
  // is enough (no jsdom).
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
});
