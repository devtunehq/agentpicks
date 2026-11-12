/** ABOUTME: Runs the open Agent Picks runner unit tests; vitest.integration.config.ts runs the rest. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.integration.spec.ts'],
  },
});
