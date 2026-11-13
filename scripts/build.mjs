// Builds dist/ as a loadable unpacked MV3 extension: one single-file IIFE bundle per script (content scripts
// cannot import), the manifest, the settings page and the icons. Not minified: anyone can read what runs on
// every page.
import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const name of ['inpage', 'content', 'background', 'options']) {
  await build({
    root,
    configFile: false,
    mode: 'production',
    logLevel: 'warn',
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), global: 'globalThis' },
    resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      minify: false,
      modulePreload: false,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: { [name]: join(root, 'src', `${name}.ts`) },
        output: { format: 'iife', name: `lamport_warden_${name}`, entryFileNames: '[name].js', inlineDynamicImports: true },
      },
    },
  });
  console.log(`built ${name}.js`);
}
await cp(join(root, 'manifest.json'), join(dist, 'manifest.json'));
await cp(join(root, 'public', 'options.html'), join(dist, 'options.html'));
await cp(join(root, 'public', 'icons'), join(dist, 'icons'), { recursive: true });
console.log('dist/ is ready: chrome://extensions -> Load unpacked');
