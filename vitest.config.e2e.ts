import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    // The e2e config does not load .env, so NODE_ENV is not a reliable guard.
    // Without this every e2e run would boot a real relay against the broker.
    env: { DISABLE_OUTBOX_RELAY: 'true' },
  },
});
