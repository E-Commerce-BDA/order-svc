import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    // The e2e config does not load .env, so NODE_ENV is not a reliable guard.
    // Without this every e2e run would boot a real relay against the broker,
    // and the recovery sweep would race the suites over the same order rows.
    env: { DISABLE_OUTBOX_RELAY: 'true', DISABLE_RECOVERY_SWEEP: 'true' },
  },
});
