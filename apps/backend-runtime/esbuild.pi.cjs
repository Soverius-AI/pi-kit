const path = require('node:path');

module.exports = {
  outbase: 'apps/backend-runtime/src/pi',
  outdir: 'dist/apps/backend-runtime/assets/pi/dist',
  splitting: true,
  chunkNames: 'chunk-[hash]',
  keepNames: true,
  mainFields: ['module', 'main'],
  define: { PI_BUNDLED_NODE: 'true' },
  alias: { 'pi-internal': path.resolve(__dirname, '../../node_modules/@earendil-works/pi-coding-agent/dist') },
  plugins: [{
    name: 'dynamic-cjs-exports',
    setup(build) {
      // Dynamic import of a CJS bundle otherwise exposes only `default`.
      // Pi expects these named exports, as Node exposes them for the npm files.
      const exports = {
        '@silvia-odwyer/photon-node': 'PhotonImage, SamplingFilter, resize, fliph, flipv',
        'https-proxy-agent': 'HttpsProxyAgent',
      };
      build.onResolve({ filter: /^(@silvia-odwyer\/photon-node|https-proxy-agent)$/ }, (args) =>
        args.kind === 'dynamic-import' ? { path: args.path, namespace: 'named-cjs' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'named-cjs' }, ({ path: name }) => ({
        contents: `export { ${exports[name]} } from ${JSON.stringify(name)};`,
        loader: 'js',
        resolveDir: path.resolve(__dirname, '../..'),
      }));
    },
  }],
  // CJS dependencies in the ESM SDK still use Node builtins and relative WASM.
  banner: { js: 'import { createRequire as __pkCreateRequire } from "node:module"; import { fileURLToPath as __pkFileURLToPath } from "node:url"; import { dirname as __pkDirname } from "node:path"; const require = __pkCreateRequire(import.meta.url); const __filename = __pkFileURLToPath(import.meta.url); const __dirname = __pkDirname(__filename);' },
};
