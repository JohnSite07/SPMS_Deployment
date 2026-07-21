import js from '@eslint/js';
import react from 'eslint-plugin-react';

// Flat config mirroring app/eslint.config.js, extended for React/JSX.
// ESM form because package.json sets "type": "module".
export default [
  { ignores: ['dist/'] },
  js.configs.recommended,
  react.configs.flat.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // Web Crypto API (vault-crypto.js, PRD 0019) plus the base64 /
        // text-codec globals it needs — all browser (and Node >=20) builtins,
        // not restricted by the fetch/web-storage rules below.
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // React 18 automatic JSX runtime — no need to import React in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Enforced conventions (see .claude/rules/frontend.md). These are the
  // mechanical teeth behind the frontend rules; violations fail CI's
  // client-checks job, so they cannot be merged.
  {
    files: ['src/**/*.{js,jsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Call the API through src/services/api-client.js (get/post/put/del), never fetch() directly — see .claude/rules/frontend.md.',
        },
        {
          name: 'localStorage',
          message:
            'Do not persist to localStorage — the session token is in-memory only (ADR 0010). See .claude/rules/frontend.md.',
        },
        {
          name: 'sessionStorage',
          message:
            'Do not persist to sessionStorage — the session token is in-memory only (ADR 0010). See .claude/rules/frontend.md.',
        },
      ],
    },
  },
  // api-client.js IS the fetch wrapper — the one place fetch is allowed. Web
  // storage stays banned everywhere, including here.
  {
    files: ['src/services/api-client.js'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Do not persist to localStorage — the session token is in-memory only (ADR 0010).',
        },
        {
          name: 'sessionStorage',
          message: 'Do not persist to sessionStorage — the session token is in-memory only (ADR 0010).',
        },
      ],
    },
  },
];
