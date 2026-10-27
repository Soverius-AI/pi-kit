const { readFile } = require('node:fs/promises');
const ts = require('typescript');
const { nativePackages, optionalImports } = require('../../scripts/backend-runtime.cjs');

module.exports = {
  outExtension: { '.js': '.js' },
  // Node normally prefers CJS. Prefer ESM when a package offers both so esbuild
  // can remove unused exports (in particular CopilotKit's provider integrations).
  mainFields: ['module', 'main'],
  keepNames: true,
  treeShaking: true,
  external: [...nativePackages, ...optionalImports],
  // Drizzle's adapter imports this name; use the same encrypted native driver in packaged builds.
  alias: { 'better-sqlite3': 'better-sqlite3-multiple-ciphers' },
  // Nest 12 uses import.meta.url for its optional synchronous package loader.
  // The backend remains CJS so existing launchers and __dirname assets work.
  define: { 'import.meta.url': '__piKitModuleUrl' },
  banner: { js: 'const __piKitModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  plugins: [
    {
      name: 'nest-decorator-metadata',
      setup(build) {
        // esbuild erases types without emitting design:paramtypes. Let TypeScript
        // emit Nest's decorators/metadata first, then esbuild bundles and minifies
        // the resulting ESM. Nx still performs the full project type check.
        build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          if (path.includes('/node_modules/') || path.includes('\\node_modules\\')) return;
          const source = await readFile(path, 'utf8');
          const result = ts.transpileModule(source, {
            fileName: path,
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
              esModuleInterop: true,
              sourceMap: false,
              inlineSourceMap: Boolean(build.initialOptions.sourcemap),
              inlineSources: Boolean(build.initialOptions.sourcemap),
            },
          });
          return { contents: result.outputText, loader: 'js' };
        });
      },
    },
  ],
};
