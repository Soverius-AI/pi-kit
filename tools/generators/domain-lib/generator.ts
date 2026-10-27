import { addProjectConfiguration, generateFiles, joinPathFragments, logger, offsetFromRoot, updateJson, workspaceRoot, type Tree } from '@nx/devkit';
import { join } from 'node:path';

/**
 * `pnpm exec nx g ./tools/generators/domain-lib:lib --domain threads --type feature --name sidebar` (doc/docs/structure.md).
 *
 * Creates `libs/<domain>/<type>[-<name>]`: project.json with the tags `scope:<domain>` and `type:<type>` and the `lint` and `test`
 * targets, tsconfig files, a test setup, `src/index.ts`, the `@pi-kit/<domain>/<type>[-<name>]` path in tsconfig.base.json, and the
 * domain in the list at the top of eslint.config.mjs when it is new.
 */
export const LIBRARY_TYPES = ['api', 'feature', 'ui', 'data', 'util'] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];

export interface DomainLibSchema {
  domain: string;
  type: LibraryType;
  /** Required for `feature` (one library per lazy entry), not allowed for the other types (one per domain). */
  name?: string;
  /** `angular` (the Angular unit-test builder, jsdom) or `node` (plain vitest). Default: node for util, angular otherwise. */
  testing?: 'angular' | 'node';
}

const RULES: Record<LibraryType, string> = {
  api: 'What other domains may import: a facade over the domain\'s store and selected types. May use this domain\'s `data` and `util` and `scope:shared`.',
  feature: 'A lazy entry: container components wired to the stores, one per lazy chunk. May use `feature`, `ui`, `data`, `util` of this domain, `scope:shared`, and the `api` of other domains.',
  ui: 'Presentational components: inputs and outputs only, no store, no HTTP. May use `ui`, `util` and `scope:shared`.',
  data: 'The SignalStores, direct generated API operations and mappers. May use `data`, `util`, `scope:shared` and the `api` of other domains.',
  util: 'Pure functions of the domain. May use `util` and `scope:shared`.',
};

// The templates sit next to this file; the path comes from the workspace root because `__dirname` does not exist when Nx loads the generator as ESM.
const TEMPLATES = join(workspaceRoot, 'tools/generators/domain-lib/files');

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function describeLibrary(options: DomainLibSchema) {
  const { domain, type, name } = options;
  if (!NAME.test(domain)) throw new Error(`--domain must be lower-case words joined by "-" (got "${domain}")`);
  if (domain === 'shared') throw new Error('The kernel (libs/shared/*) is not a domain; create its libraries by hand and tag them scope:shared.');
  if (!LIBRARY_TYPES.includes(type)) throw new Error(`--type must be one of ${LIBRARY_TYPES.join(', ')} (got "${type}")`);
  if (type === 'feature' && !name) throw new Error('A feature library needs --name (libs/<domain>/feature-<name>), e.g. --name sidebar');
  if (type !== 'feature' && name) throw new Error(`Only feature libraries take --name; ${type} is one per domain (libs/${domain}/${type})`);
  if (name && !NAME.test(name)) throw new Error(`--name must be lower-case words joined by "-" (got "${name}")`);
  const dirName = name ? `${type}-${name}` : type;
  return {
    dirName,
    root: joinPathFragments('libs', domain, dirName),
    projectName: `${domain}-${dirName}`,
    alias: `@pi-kit/${domain}/${dirName}`,
    testing: options.testing ?? (type === 'util' ? 'node' : 'angular'),
  };
}

/** Adds `domain` to the `const domains = [...]` list of eslint.config.mjs (the scope rule needs one entry per domain). */
function registerDomain(tree: Tree, domain: string): 'added' | 'present' | 'missing-list' {
  const file = 'eslint.config.mjs';
  const source = tree.exists(file) ? tree.read(file, 'utf-8') ?? '' : '';
  const match = /const domains = \[([\s\S]*?)\n\];/.exec(source);
  if (!match) return 'missing-list';
  if ([...match[1].matchAll(/"([^"]+)"/g)].some((m) => m[1] === domain)) return 'present';
  const updated = source.replace(match[0], `const domains = [${match[1]},\n    "${domain}"\n];`);
  tree.write(file, updated);
  return 'added';
}

export default async function domainLibGenerator(tree: Tree, options: DomainLibSchema): Promise<void> {
  const { dirName, root, projectName, alias, testing } = describeLibrary(options);
  const { domain, type } = options;
  if (tree.exists(joinPathFragments(root, 'project.json'))) throw new Error(`${root} already exists`);

  const targets: Parameters<typeof addProjectConfiguration>[2]['targets'] = {
    lint: { executor: '@nx/eslint:lint' },
    test:
      testing === 'angular'
        ? {
            executor: '@angular/build:unit-test',
            cache: true,
            inputs: ['default', '^production'],
            options: {
              tsConfig: `${root}/tsconfig.spec.json`,
              // The builder wants an application build for its options (zone.js, the Angular compiler settings); the renderer's is the one.
              buildTarget: 'renderer:build:development',
              runner: 'vitest',
              include: [`${root}/src/**/*.spec.ts`],
              setupFiles: [`${root}/src/test-setup.ts`],
            },
          }
        : {
            executor: 'nx:run-commands',
            cache: true,
            inputs: ['default', '^production'],
            options: { command: 'vitest run', cwd: root },
          },
  };
  addProjectConfiguration(tree, projectName, {
    root,
    sourceRoot: `${root}/src`,
    projectType: 'library',
    prefix: 'pk',
    tags: [`scope:${domain}`, `type:${type}`],
    targets,
  });

  const substitutions = { tmpl: '', offset: offsetFromRoot(root), domain, type, projectName, alias, rule: RULES[type], dirName };
  generateFiles(tree, join(TEMPLATES, 'common'), root, substitutions);
  generateFiles(tree, join(TEMPLATES, testing), root, substitutions);

  updateJson(tree, 'tsconfig.base.json', (json) => {
    json.compilerOptions ??= {};
    json.compilerOptions.paths ??= {};
    if (json.compilerOptions.paths[alias]) throw new Error(`${alias} is already a path in tsconfig.base.json`);
    json.compilerOptions.paths[alias] = [`./${root}/src/index.ts`];
    return json;
  });

  const registered = registerDomain(tree, domain);
  if (registered === 'added') logger.info(`Added "${domain}" to the domains list in eslint.config.mjs.`);
  if (registered === 'missing-list') logger.warn(`eslint.config.mjs has no \`const domains = [...]\` list; add "${domain}" to it so the scope rule applies to the new library.`);
  logger.info(`Created ${root} (${alias}, tags scope:${domain} type:${type}, ${testing} tests). Check: pnpm exec nx run ${projectName}:lint`);
}
