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

// The practice page (site/try): the same way, into site/try/dist. It uses the Sentinel page's stylesheet.
const tryPage = join(root, 'site', 'try');
const tryDist = join(tryPage, 'dist');
await rm(tryDist, { recursive: true, force: true });
await mkdir(tryDist, { recursive: true });
await build({
  root,
  configFile: false,
  mode: 'production',
  logLevel: 'warn',
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: tryDist,
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    minify: false,
    modulePreload: false,
    rollupOptions: { input: { try: join(tryPage, 'src', 'try.ts') }, output: { format: 'iife', name: 'warden_try_page', entryFileNames: '[name].js', inlineDynamicImports: true } },
  },
});
await cp(join(tryPage, 'index.html'), join(tryDist, 'index.html'));
await cp(join(tryPage, 'try.css'), join(tryDist, 'try.css'));
console.log('site/try/dist is ready');
