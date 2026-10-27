// What the sidebar tests and screenshots need besides the scratch project: a second project with its own git branch and sessions
// that are over 90 % of the context window, a third that is only a quarter full. Sessions are written as pi's own JSONL, so the app finds them
// the way it finds the CLI's (the reconcile pass, 3 s in the tests).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeUsageSession } from './demo-sessions.mjs';

/** A git repository next to the scratch project, on its own branch, with two sessions in it. Returns its folder. */
export function writeSecondProject({ base, agentDir, name = 'reporting-api', branch = 'feature/summary' }) {
  const folder = join(base, name);
  mkdirSync(folder, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: folder, stdio: 'ignore' });
  git('init', '-q', '-b', branch);
  writeFileSync(join(folder, 'README.md'), `# ${name}\n`);
  git('add', '-A');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init');
  writeUsageSession({ agentDir, cwd: folder, name: 'Context nearly full', contextTokens: 250_000 });
  writeUsageSession({ agentDir, cwd: folder, name: 'Filling up', contextTokens: 190_000 });
  writeUsageSession({ agentDir, cwd: folder, name: 'Quarter used', contextTokens: 60_000 });
  return folder;
}
