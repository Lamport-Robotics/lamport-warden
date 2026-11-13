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
      output: {
        format: 'es', entryFileNames: '[name].mjs', inlineDynamicImports: true,
        // Some bundled dependencies were written for CommonJS and read __filename. In an ES module that name
        // does not exist, and one of them (a native-addon loader) then left Error.prepareStackTrace broken:
        // the next error anywhere crashed the process. scripts/smoke-service.mjs fails if that comes back.
        banner: "import { fileURLToPath as __sentinelFileURLToPath } from 'node:url';\nimport { dirname as __sentinelDirname } from 'node:path';\nconst __filename = __sentinelFileURLToPath(import.meta.url);\nconst __dirname = __sentinelDirname(__filename);",
      },
    },
  },
  ssr: { noExternal: true },
});
console.log('sentinel/service/dist/sentinel.mjs is ready');
