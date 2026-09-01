import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        // Postgres-wire adapter + migration runner are exercised on every
        // CI run through the integration suite (CI provides DATABASE_URL);
        // without a configured database they skip cleanly.
      ],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 95,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    include: ['packages/*/test/**/*.test.ts'],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
