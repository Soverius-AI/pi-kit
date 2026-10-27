import nx from "@nx/eslint-plugin";
import angular from 'angular-eslint';
import ngrx from '@ngrx/eslint-plugin';
import nest from '@darraghor/eslint-plugin-nestjs-typed';
import unusedImports from 'eslint-plugin-unused-imports';
import { angularRoots } from './scripts/frontend-scope.mjs';

const angularTs = angularRoots.map((root) => `${root}/src/**/*.ts`);
const angularHtml = angularRoots.map((root) => `${root}/src/**/*.html`);

// The domains of pi-kit. A domain library is tagged `scope:<domain>` and `type:<api|feature|ui|data|util>`;
// the kernel under libs/shared is `scope:shared`. The generator adds a domain here when it creates the domain's first library
// (`pnpm exec nx g ./tools/generators/domain-lib:lib`, doc/docs/structure.md).
const domains = [
    "threads",
    "chat",
    "review",
    "files",
    "session-tree",
    "terminal",
    "settings",
    "onboarding",
    "update",
    "artifacts",
    "agents"
];

const depConstraints = [
    // Transport must stay independent of stores and domain facades.
    { sourceTag: "layer:transport", onlyDependOnLibsWithTags: ["layer:transport"] },
    // scope: who may reach whom
    { sourceTag: "scope:shared", onlyDependOnLibsWithTags: ["scope:shared"] },
    { sourceTag: "scope:backend", onlyDependOnLibsWithTags: ["scope:backend", "scope:shared"] },
    { sourceTag: "scope:app", onlyDependOnLibsWithTags: ["*"] },
    // a domain: itself, the kernel, and the public `type:api` of any other domain
    ...domains.map((domain) => ({
        sourceTag: `scope:${domain}`,
        onlyDependOnLibsWithTags: [`scope:${domain}`, "scope:shared", "type:api"]
    })),
    // type: what a library of each kind may use (the scope rules above narrow it to its own domain)
    {
        sourceTag: "type:feature",
        onlyDependOnLibsWithTags: ["type:feature", "type:ui", "type:data", "type:util", "type:api", "scope:shared"]
    },
    { sourceTag: "type:ui", onlyDependOnLibsWithTags: ["type:ui", "type:util", "scope:shared"] },
    { sourceTag: "type:data", onlyDependOnLibsWithTags: ["type:data", "type:util", "type:api", "scope:shared"] },
    { sourceTag: "type:util", onlyDependOnLibsWithTags: ["type:util", "scope:shared"] },
    { sourceTag: "type:api", onlyDependOnLibsWithTags: ["type:data", "type:util", "scope:shared"] }
];

export default [
    ...nx.configs["flat/base"],
    ...nx.configs["flat/typescript"],
    ...nx.configs["flat/javascript"],
    {
        ignores: [
            "**/dist",
            "**/out-tsc",
            "**/node_modules/**",
            "output/**",
            "coverage/**",
            "libs/shared/api/src/generated/**"
        ]
    },
    {
        files: [
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx"
        ],
        rules: {
            "@nx/enforce-module-boundaries": [
                "error",
                {
                    enforceBuildableLibDependency: true,
                    allow: [
                        "^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$"
                    ],
                    depConstraints
                }
            ]
        }
    },
    {
        files: [
            "**/*.ts",
            "**/*.tsx",
            "**/*.cts",
            "**/*.mts",
            "**/*.js",
            "**/*.jsx",
            "**/*.cjs",
            "**/*.mjs"
        ],
        plugins: { 'unused-imports': unusedImports },
        rules: {
            'unused-imports/no-unused-imports': 'error',
            'no-debugger': 'error',
            // A leading underscore marks a parameter or binding that is unused on purpose (a stub's argument, a key
            // dropped by a rest spread); everything else unused is still reported.
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
        }
    },
    {
        files: ['**/*.spec.ts'],
        // A test that dereferences a value that may be undefined fails on its own; the assertion keeps the test readable.
        rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    {
        files: angularTs,
        plugins: { '@angular-eslint': angular.tsPlugin, '@ngrx': ngrx },
        processor: angular.processInlineTemplates,
        rules: {
            '@angular-eslint/prefer-standalone': 'error',
            '@ngrx/enforce-type-call': 'error',
            '@ngrx/prefer-protected-state': 'error',
            '@ngrx/signal-store-feature-should-use-generic-type': 'error',
        },
    },
    {
        files: angularHtml,
        languageOptions: { parser: angular.templateParser },
        plugins: { '@angular-eslint/template': angular.templatePlugin },
        rules: {
            '@angular-eslint/template/no-negated-async': 'error',
            '@angular-eslint/template/alt-text': 'error',
            '@angular-eslint/template/elements-content': 'error',
            '@angular-eslint/template/label-has-associated-control': 'error',
            '@angular-eslint/template/valid-aria': 'error',
        },
    },
    {
        files: ['apps/backend/src/**/*.ts', 'apps/desktop/src/**/*.ts', ...angularTs],
        ignores: ['**/*.spec.ts', '**/test-setup.ts'],
        languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
        rules: {
            '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
        },
    },
    {
        // pi-durable and chord stay behind one adapter; their types never reach the renderer or the protocol.
        files: ['apps/**/*.ts', 'libs/**/*.ts', 'packages/**/*.ts'],
        ignores: [
            'apps/backend/src/bg-agents/bg-agents.service.ts',
            'apps/backend/src/bg-agents/agent-questions.ts',
            'apps/backend/src/bg-agents/durable-storage.ts',
            'apps/backend/src/bg-agents/agent-extension.ts',
            'apps/backend/src/bg-agents/agent-events.ts',
            'apps/backend/src/bg-agents/*.spec.ts',
        ],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['@earendil-works/pi-durable', '@earendil-works/pi-durable/*', '@earendil-works/chord', '@earendil-works/chord/*'],
                    message: 'pi-durable and chord imports belong to the explicitly listed background-agent adapter owners.',
                }],
            }],
        },
    },
    {
        files: angularTs,
        ignores: ['**/*.spec.ts', '**/test-setup.ts'],
        rules: {
            '@angular-eslint/no-uncalled-signals': 'error',
            '@angular-eslint/prefer-on-push-component-change-detection': 'error',
            '@ngrx/signal-state-no-arrays-at-root-level': 'error',
            '@ngrx/with-state-no-arrays-at-root-level': 'error',
        },
    },
    {
        files: ['apps/backend/src/**/*.ts'],
        plugins: { '@darraghor/nestjs-typed': nest },
        rules: {
            '@darraghor/nestjs-typed/no-duplicate-decorators': 'error',
            '@darraghor/nestjs-typed/provided-injected-should-match-factory-parameters': 'error',
            '@darraghor/nestjs-typed/use-injectable-provided-token': 'error',
            '@darraghor/nestjs-typed/param-decorator-name-matches-route-param': 'error',
        },
    },
].map((config) => ({ ...config, basePath: import.meta.dirname }));
