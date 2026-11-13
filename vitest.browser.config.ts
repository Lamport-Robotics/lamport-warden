import { defineConfig } from 'vitest/config';

// The built extension in Chromium: pnpm build && pnpm build:fixtures && pnpm test:browser
export default defineConfig({
  resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
  test: {
    environment: 'node',
    include: ['test/browser/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
