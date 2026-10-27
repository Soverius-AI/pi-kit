import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Plain vitest for pure functions (like libs/shared/ui). The `@pi-kit/*` aliases come from tsconfig.base.json, so a new library needs no edit here.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const paths: Record<string, string[]> = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')).compilerOptions.paths;
const alias = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => b.length - a.length).filter(([name]) => name.startsWith('@pi-kit/')).map(([name, [target]]) => [name, join(root, target)]));

// The barrel of @pi-kit/ui also holds Angular components, which need the Angular compiler; these specs need one pure file of it (the words for where a credential lives).
alias['@pi-kit/ui'] = join(root, 'libs/shared/ui/src/lib/settings/api-key.ts');

export default defineConfig({
  resolve: { alias },
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
