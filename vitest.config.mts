import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      SIMULATED_LATENCY_MS: '0',
    },
  },
});
