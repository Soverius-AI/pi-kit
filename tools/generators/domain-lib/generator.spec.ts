import { readJson, readProjectConfiguration, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import domainLibGenerator, { describeLibrary } from './generator';

const ESLINT = `const domains = [
    "threads",
    "chat"
];

export default [];
`;

describe('domain-lib generator (virtual tree)', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@pi-kit/protocol': ['./libs/shared/protocol/src/index.ts'] } } }, null, 2));
    tree.write('eslint.config.mjs', ESLINT);
  });

  it('scaffolds a feature library with the scope and type tags, lint and test targets, and an index', async () => {
    await domainLibGenerator(tree, { domain: 'threads', type: 'feature', name: 'sidebar' });

    const project = readProjectConfiguration(tree, 'threads-feature-sidebar');
    expect(project.root).toBe('libs/threads/feature-sidebar');
    expect(project.tags).toEqual(['scope:threads', 'type:feature']);
    expect(Object.keys(project.targets ?? {})).toEqual(['lint', 'test']);
    expect(project.targets?.['lint']?.executor).toBe('@nx/eslint:lint');
    expect(project.targets?.['test']?.executor).toBe('@angular/build:unit-test');
    expect(project.targets?.['test']?.options.include).toEqual(['libs/threads/feature-sidebar/src/**/*.spec.ts']);

    // `sideEffects: false` lets the bundler drop what a barrel re-exports and nobody imports (a lazy chunk must not end up in the initial bundle through an index.ts).
    expect(readJson(tree, 'libs/threads/feature-sidebar/package.json')).toMatchObject({ name: '@pi-kit/threads-feature-sidebar', sideEffects: false });
    for (const file of ['project.json', 'package.json', 'tsconfig.json', 'tsconfig.lib.json', 'tsconfig.spec.json', 'eslint.config.mjs', 'README.md', 'src/index.ts', 'src/test-setup.ts']) {
      expect(tree.exists(`libs/threads/feature-sidebar/${file}`), file).toBe(true);
    }
    expect(tree.exists('libs/threads/feature-sidebar/vitest.config.mts')).toBe(false);
    expect(readJson(tree, 'libs/threads/feature-sidebar/tsconfig.json').extends).toBe('../../../tsconfig.base.json');
    expect(tree.read('libs/threads/feature-sidebar/eslint.config.mjs', 'utf-8')).toContain('"../../../eslint.config.mjs"');
    expect(tree.read('libs/threads/feature-sidebar/src/index.ts', 'utf-8')).toContain('@pi-kit/threads/feature-sidebar');
  });

  it('adds the import alias without touching the others', async () => {
    await domainLibGenerator(tree, { domain: 'chat', type: 'data' });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({
      '@pi-kit/protocol': ['./libs/shared/protocol/src/index.ts'],
      '@pi-kit/chat/data': ['./libs/chat/data/src/index.ts'],
    });
  });

  it('gives a util library plain vitest (node) with aliases read from tsconfig.base.json', async () => {
    await domainLibGenerator(tree, { domain: 'chat', type: 'util' });
    const project = readProjectConfiguration(tree, 'chat-util');
    expect(project.targets?.['test']).toMatchObject({ executor: 'nx:run-commands', options: { command: 'vitest run', cwd: 'libs/chat/util' } });
    expect(tree.exists('libs/chat/util/vitest.config.mts')).toBe(true);
    expect(tree.exists('libs/chat/util/src/test-setup.ts')).toBe(false);
    expect(tree.read('libs/chat/util/vitest.config.mts', 'utf-8')).toContain("new URL('../../../', import.meta.url)");
  });

  it('registers a new domain in eslint.config.mjs and leaves a known one alone', async () => {
    await domainLibGenerator(tree, { domain: 'review', type: 'ui' });
    expect(tree.read('eslint.config.mjs', 'utf-8')).toContain('"chat",\n    "review"\n];');
    await domainLibGenerator(tree, { domain: 'review', type: 'util' });
    expect(tree.read('eslint.config.mjs', 'utf-8')?.match(/"review"/g)).toHaveLength(1);
  });

  it('names the projects <domain>-<type>[-<name>]', () => {
    expect(describeLibrary({ domain: 'session-tree', type: 'feature', name: 'tree' })).toMatchObject({ projectName: 'session-tree-feature-tree', alias: '@pi-kit/session-tree/feature-tree', root: 'libs/session-tree/feature-tree' });
    expect(describeLibrary({ domain: 'settings', type: 'api' })).toMatchObject({ projectName: 'settings-api', alias: '@pi-kit/settings/api', testing: 'angular' });
  });

  it('refuses what does not allow', async () => {
    await expect(domainLibGenerator(tree, { domain: 'threads', type: 'feature' })).rejects.toThrow(/needs --name/);
    await expect(domainLibGenerator(tree, { domain: 'threads', type: 'data', name: 'x' })).rejects.toThrow(/Only feature libraries take --name/);
    await expect(domainLibGenerator(tree, { domain: 'shared', type: 'util' })).rejects.toThrow(/not a domain/);
    await expect(domainLibGenerator(tree, { domain: 'Threads', type: 'util' })).rejects.toThrow(/--domain/);
    await expect(domainLibGenerator(tree, { domain: 'threads', type: 'service' as never })).rejects.toThrow(/--type/);
    await domainLibGenerator(tree, { domain: 'threads', type: 'ui' });
    await expect(domainLibGenerator(tree, { domain: 'threads', type: 'ui' })).rejects.toThrow(/already exists/);
  });
});
