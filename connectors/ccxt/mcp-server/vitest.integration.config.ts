import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 30000,
  },
});
