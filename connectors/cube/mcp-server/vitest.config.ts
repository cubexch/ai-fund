import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'tests/**/*.integration.test.ts',
      'tests/**/*.platform.test.ts',
      'tests/**/*.live.test.ts',
      'node_modules/**',
    ],
    passWithNoTests: true,
    testTimeout: 15_000,
  },
});
