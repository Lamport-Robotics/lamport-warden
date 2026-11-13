// Builds what the browser tests load beside the extension: a stand-in wallet extension and a small dapp page.
import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'test', 'browser', 'fixtures');
const out = join(root, 'test', 'browser', 'dist');
await rm(out, { recursive: true, force: true });

for (const [dir, entry, name] of [['wallet-ext', 'wallets.ts', 'wallets'], ['page', 'app.ts', 'app']]) {
  await mkdir(join(out, dir), { recursive: true });
  await build({
    root, configFile: false, mode: 'production', logLevel: 'warn', publicDir: false,
    build: {
      outDir: join(out, dir), emptyOutDir: false, target: 'es2022', sourcemap: false, minify: false, modulePreload: false,
      rollupOptions: { input: { [name]: join(src, dir, entry) }, output: { format: 'iife', name: `fixture_${name}`, entryFileNames: '[name].js', inlineDynamicImports: true } },
    },
  });
}
await cp(join(src, 'wallet-ext', 'manifest.json'), join(out, 'wallet-ext', 'manifest.json'));
await cp(join(src, 'page', 'index.html'), join(out, 'page', 'index.html'));
console.log('browser test fixtures built');
