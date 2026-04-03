import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.platform.test.ts'],
    exclude: ['node_modules/**'],
    passWithNoTests: true,
    testTimeout: 15_000,
  },
});
