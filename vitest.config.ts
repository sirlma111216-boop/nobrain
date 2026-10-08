import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/e2e/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
