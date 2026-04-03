import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.live.test.ts'],
    exclude: ['node_modules/**'],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
