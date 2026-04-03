import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['tests/**/*.integration.test.ts', 'node_modules/**'],
    testTimeout: 15_000,
  },
});
