// Builds the Sentinel page into sentinel/web/dist: index.html, sentinel.css and one script. Not minified.
import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'sentinel', 'web');
const dist = join(web, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  root,
  configFile: false,
  mode: 'production',
  logLevel: 'warn',
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    minify: false,
    modulePreload: false,
    rollupOptions: { input: { app: join(web, 'src', 'app.ts') }, output: { format: 'iife', name: 'warden_sentinel_page', entryFileNames: '[name].js', inlineDynamicImports: true } },
  },
});
await cp(join(web, 'index.html'), join(dist, 'index.html'));
await cp(join(web, 'sentinel.css'), join(dist, 'sentinel.css'));
console.log('sentinel/web/dist is ready');
