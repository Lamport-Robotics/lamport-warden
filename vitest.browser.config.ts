import { defineConfig } from 'vitest/config';

// The built extension in Chromium: pnpm build && pnpm build:fixtures && pnpm test:browser
export default defineConfig({
  resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
  test: {
    environment: 'node',
    // WARDEN_SHOTS=1 (pnpm shots) takes the store screenshots instead of running the tests
    include: [process.env.WARDEN_SHOTS ? 'test/shots/*.test.ts' : 'test/browser/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
