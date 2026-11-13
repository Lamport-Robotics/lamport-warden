import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the engine lives in the pincer1 submodule (pincer1/daemon/src); its imports resolve to this package's own copies
  resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
