/** ABOUTME: Runs the open Agent Picks runner integration specs, which need a local Docker daemon. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    testTimeout: 60_000,
  },
});
