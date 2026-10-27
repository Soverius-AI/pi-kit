import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustService } from './trust.service';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('./load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

let base: string;
let trust: TrustService;
const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
const previousTrusted = process.env['PI_KIT_TRUSTED_CWDS'];

/** A folder with project resources (an extension, a skill, an mcp.json) or without any. */
function folder(name: string, resources: boolean, extension = 'export default () => {};\n'): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), name);
  if (resources) {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'extensions', 'hello.ts'), extension);
  }
  return dir;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-trustscratch-')));
  mkdirSync(join(base, 'agent'));
  process.env['PI_CODING_AGENT_DIR'] = join(base, 'agent');
  delete process.env['PI_KIT_TRUSTED_CWDS'];
  trust = new TrustService();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
  else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
  if (previousTrusted !== undefined) process.env['PI_KIT_TRUSTED_CWDS'] = previousTrusted;
});

describe('trustScratch: the scratch worktree of a verification run', () => {
  it('is trusted for this app run when the base commit has no project resources, even in a project nobody answered for', async () => {
    const project = folder('project', true);
    const scratch = folder('scratch', false);
    expect(await trust.trustScratch(scratch, project)).toBeUndefined();
    expect(await trust.folderTrusted(scratch)).toBe(true);
    // The draft skill is written afterwards; the answer for the folder stands.
    mkdirSync(join(scratch, '.pi', 'skills', 'x'), { recursive: true });
    writeFileSync(join(scratch, '.pi', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: d\n---\nB\n');
    expect(await trust.folderTrusted(scratch)).toBe(true);
    expect(await trust.resolveForOpen(scratch, {} as never)).toBe(true);
    // Nothing was saved for later: the project's own answer is untouched, and forgetting the scratch folder takes the answer away.
    expect(await trust.folderTrusted(project)).toBe(false);
    trust.forgetScratch(scratch);
    expect(await trust.folderTrusted(scratch)).toBe(false);
  });

  it('is refused when the base commit has resources and the project is not trusted, with the reason', async () => {
    const project = folder('project', true);
    const scratch = folder('scratch', true);
    expect(await trust.trustScratch(scratch, project)).toMatch(/not trusted yet/);
    expect(await trust.folderTrusted(scratch)).toBe(false);
  });

  it('is refused when the resources at the base commit are not the ones the project holds now', async () => {
    const project = folder('project', true);
    const scratch = folder('scratch', true, 'export default () => { run(); };\n');
    await trust.decide(project, 'once');
    expect(await trust.trustScratch(scratch, project)).toMatch(/differ from the ones in the project now/);
    expect(await trust.folderTrusted(scratch)).toBe(false);
  });

  it('is trusted when it holds the project’s own resources and the project is trusted', async () => {
    const project = folder('project', true);
    const scratch = folder('scratch', true);
    await trust.decide(project, 'once');
    expect(await trust.trustScratch(scratch, project)).toBeUndefined();
    expect(await trust.folderTrusted(scratch)).toBe(true);
  });

  it('does not leak into another folder', async () => {
    const project = folder('project', true);
    const scratch = folder('scratch', false);
    const other = folder('other', true);
    await trust.trustScratch(scratch, project);
    expect(await trust.folderTrusted(other)).toBe(false);
  });
});
