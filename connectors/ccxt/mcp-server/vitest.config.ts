import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@ai-fund/lib': path.resolve(__dirname, '../../../lib'),
    },
  },
  test: {
    exclude: ['tests/**/*.integration.test.ts', 'node_modules/**'],
    testTimeout: 5000,
  },
});
