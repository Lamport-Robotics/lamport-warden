import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the engine lives in the pincer1 submodule (pincer1/daemon/src); its imports resolve to this package's own copies
  resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
  test: {
    environment: 'node',
    // test/browser needs Chromium: pnpm test:browser. sentinel/service is the watcher, run in Node like the rest.
    include: ['test/*.test.ts', 'sentinel/service/test/*.test.ts'],
  },
});
