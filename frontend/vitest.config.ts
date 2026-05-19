import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * vitest.config.ts — Audit 2026-05-19 F7.
 *
 * Wires up the test runner so tests/*.test.tsx actually run. Previously a
 * lone tests/motion.test.tsx imported `vitest` which wasn't installed —
 * the file was aspirational documentation, not a working test. CI couldn't
 * verify ANYTHING about the frontend (F6 — no frontend in CI).
 *
 * jsdom is required for React Testing Library because Testing Library
 * needs `document`, `window`, etc. globals.tsx mounts `@testing-library/
 * jest-dom` matchers so we can assert `.toBeInTheDocument()`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: false,
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'tests/e2e/**'],
  },
});
