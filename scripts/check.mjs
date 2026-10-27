// pnpm run check
//
// The i18n, format and icon checks, the scripts' own tests and tooling lint, then build, lint and unit tests of every
// project, then the OpenAPI document and SDK (doc/api/openapi.yaml) regenerated from the built backend and diffed against the committed files. With CHECK_E2E=1 the Playwright end-to-end tests run
// last (`pnpm run e2e`: they start dev:web against a local model, so the default check stays fast and needs no model).
import { spawnSync } from 'node:child_process';

const steps = [
  ['pnpm', ['run', 'check:i18n']],
  ['pnpm', ['run', 'check:format']],
  ['pnpm', ['run', 'check:icons']],
  ['node', ['--test', 'scripts/dependency-contract.spec.mjs', 'scripts/mac-signing.spec.mjs', 'scripts/mac-notarization.spec.mjs', 'scripts/release-targets.spec.mjs', 'scripts/dev-builder.spec.mjs', 'scripts/e2e-world.spec.mjs']],
  ['pnpm', ['run', 'lint:tooling']],
  // The inferred ESLint target also covers Nest/desktop/Node projects without a legacy Angular `lint` target.
  ['pnpm', ['exec', 'nx', 'run-many', '-t', 'build', 'eslint:lint', 'test', '--output-style=static']],
  ['node', ['scripts/api-openapi.mjs', '--check', '--skip-build']],
  ...(process.env.CHECK_E2E === '1' ? [['pnpm', ['run', 'e2e']]] : []),
];
for (const [command, args] of steps) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const { status } = spawnSync(command, args, { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
if (process.env.CHECK_E2E !== '1') console.log('\n(end-to-end tests skipped; CHECK_E2E=1 pnpm run check includes them)');
