import { defineConfig } from 'vitest/config';

// The built extension in front of the real wallet extensions: pnpm test:wallets (downloads them)
export default defineConfig({
  resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
  test: { environment: 'node', include: ['test/real/*.test.ts'], testTimeout: 60_000, hookTimeout: 240_000, fileParallelism: false },
});
