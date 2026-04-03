import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@ai-fund/lib': path.resolve(__dirname, '../../../lib'),
    },
  },
  test: {
    testTimeout: 15_000,
  },
});
