const { chmod, readFile } = require('node:fs/promises');
const path = require('node:path');

const SRT = '@anthropic-ai/sandbox-runtime';
const PI = '@earendil-works/pi-coding-agent';
const OUTBASE = 'packages/pi-sandbox/lib';
// `<platform>-<arch>` (e.g. linux-x64): the bundle of one release target keeps only that target's code and SRT helper.
// Unset, the bundle serves every platform (development, tests).
const [platform, arch] = process.env.PI_SANDBOX_TARGET?.split('-') ?? [];

module.exports = {
  outExtension: { '.js': '.js' },
  outbase: OUTBASE,
  splitting: true,
  chunkNames: '[name]-[hash]',
  // SRT's helper binaries land at dist/vendor/<path in SRT>, where SRT looks for them next to its bundled code.
  assetNames: '[dir]/[name]',
  ...(platform
    ? { define: { 'process.platform': JSON.stringify(platform), 'process.arch': JSON.stringify(arch) } }
    : {}),
  // Bundled CommonJS dependencies of SRT (commander, node-forge) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __piSandboxRequire } from 'node:module'; const require = __piSandboxRequire(import.meta.url);",
  },
  plugins: [
    {
      // pi exports no tool modules, so the worker bundles grep's own module, without its terminal renderers.
      name: 'pi-grep',
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\/pi-coding-agent\/dist\// }, async (args) => {
          const entry = await build.resolve(PI, { kind: 'import-statement', resolveDir: args.resolveDir });
          return { path: path.join(path.dirname(entry.path), args.path.slice(`${PI}/dist/`.length)) };
        });
        build.onResolve({ filter: /^\.\/renderers\/grep\.js$/ }, (args) =>
          args.importer.includes('pi-coding-agent') ? { path: 'grep', namespace: 'pi-renderers' } : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: 'pi-renderers' }, () => ({
          contents: 'export const grepRenderers = {};',
          loader: 'js',
        }));
      },
    },
    {
      name: 'srt-vendor',
      setup(build) {
        const root = build.initialOptions.absWorkingDir ?? process.cwd();
        build.initialOptions.metafile = true;
        build.onResolve({ filter: /^@anthropic-ai\/sandbox-runtime\/vendor\// }, async (args) => {
          const manifest = await build.resolve(`${SRT}/package.json`, {
            kind: 'import-statement',
            resolveDir: args.resolveDir,
          });
          const file = args.path.slice(SRT.length + 1);
          // Side-effect free: a helper another target needs is dropped together with its unused import.
          return {
            path: path.join(root, OUTBASE, file),
            sideEffects: false,
            pluginData: path.join(path.dirname(manifest.path), file),
          };
        });
        build.onLoad({ filter: /[\\/]vendor[\\/]/ }, async (args) =>
          args.pluginData ? { contents: await readFile(args.pluginData), loader: 'file' } : undefined,
        );
        build.onEnd(async (result) => {
          for (const output of Object.keys(result.metafile?.outputs ?? {}))
            if (/[\\/]vendor[\\/]seccomp[\\/]/.test(output)) await chmod(path.join(root, output), 0o755);
        });
      },
    },
  ],
};
