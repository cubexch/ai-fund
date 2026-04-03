import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['tests/**/*.platform.test.ts', 'tests/**/*.live.test.ts', 'node_modules/**'],
    passWithNoTests: true,
    testTimeout: 15_000,
  },
});
