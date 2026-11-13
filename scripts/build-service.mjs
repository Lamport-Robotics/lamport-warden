// Builds the Sentinel service into one file Node runs as it is: sentinel/service/dist/sentinel.mjs.
// The sources are TypeScript and share the engine with the extension (the pincer1 submodule), so they are
// bundled the same way the extension is. Not minified: what runs on the server can be read.
import { build } from 'vite';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  root,
  configFile: false,
  mode: 'production',
  logLevel: 'warn',
  publicDir: false,
  resolve: { dedupe: ['@solana/web3.js', 'buffer'] },
  build: {
    outDir: join(root, 'sentinel', 'service', 'dist'),
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: { sentinel: join(root, 'sentinel', 'service', 'src', 'cli.ts') },
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'es', entryFileNames: '[name].mjs', inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true },
});
console.log('sentinel/service/dist/sentinel.mjs is ready');
