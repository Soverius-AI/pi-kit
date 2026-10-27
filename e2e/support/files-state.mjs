// The working tree state the Files panel tests and screenshots expect, made in the scratch project of e2e/support/env.mjs: one file of each
// git badge (added, modified, deleted, untracked, renamed), a file pi edited in the demo thread "Add a monthly summary" (src/math.ts, as the
// session's edit left it: `mul` after `sub`), and ignored files (dist, .env, node_modules).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function prepareFilesDemo(project) {
  const git = (...args) => spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: project, stdio: 'ignore' });
  // a committed file that is renamed below
  writeFileSync(join(project, 'src', 'legacy.ts'), 'export const legacy = "the same long enough content to count as a rename";\nexport const second = 2;\nexport const third = 3;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'legacy');
  writeFileSync(join(project, 'src', 'greet.ts'), `${readFileSync(join(project, 'src', 'greet.ts'), 'utf8')}// edited by hand\n`); // M
  rmSync(join(project, 'README.md')); // D
  writeFileSync(join(project, 'src', 'added.ts'), 'export const added = true;\n');
  git('add', 'src/added.ts'); // A
  writeFileSync(join(project, 'notes.md'), '# notes\n'); // U
  git('mv', 'src/legacy.ts', 'src/modern.ts'); // R
  writeFileSync(join(project, 'src', 'math.ts'), `${readFileSync(join(project, 'src', 'math.ts'), 'utf8')}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`); // pi's edit
  writeFileSync(join(project, '.gitignore'), 'node_modules\ndist\n.env\n');
  git('commit', '-q', '-m', 'ignore dist', '--', '.gitignore');
  mkdirSync(join(project, 'dist'), { recursive: true });
  writeFileSync(join(project, 'dist', 'out.js'), 'x');
  writeFileSync(join(project, '.env'), 'A=1\n');
  mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'x');
}
