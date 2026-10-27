import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandsService } from './commands.service';
import { FilesService } from './files.service';

describe('CommandsService.merge', () => {
  const service = new CommandsService(undefined as never, undefined as never);
  const commands = service.merge([
    { name: 'skill:pdf-tools', description: 'PDFs', source: 'skill', scope: 'user', origin: 'user', path: '/x/SKILL.md' },
    { name: 'fix-tests', description: 'Fix them', source: 'prompt', scope: 'project', origin: 'project', path: '/x/fix-tests.md' },
    { name: 'review', description: 'Review the diff', source: 'extension', scope: undefined, origin: 'project', path: '/p/.pi/extensions/git-guard/index.ts' },
  ]);

  it('lists discovered commands as prompt commands, with a badge-ready origin', () => {
    expect(commands.slice(0, 3).map((c) => [c.name, c.source, c.kind, c.origin])).toEqual([
      ['skill:pdf-tools', 'skill', 'prompt', 'user'],
      ['fix-tests', 'prompt', 'prompt', 'project'],
      ['review', 'extension', 'prompt', 'git-guard'],
    ]);
  });

  it('turns the /mcp command of pi\'s MCP extension into an action that opens the panel', () => {
    const merged = service.merge([{ name: 'mcp', description: 'Manage MCP servers: sign in, reconnect, enable or disable, and change exposure', source: 'extension', scope: undefined, origin: 'user', path: 'builtin:mcp' }]);
    expect(merged[0]).toMatchObject({ name: 'mcp', source: 'extension', kind: 'action', origin: 'pi' });
  });

  it('adds every built-in as an action, and marks only the out-of-scope ones disabled with a reason', () => {
    const builtins = commands.filter((c) => c.source === 'builtin');
    expect(builtins.every((c) => c.kind === 'action')).toBe(true);
    const names = builtins.map((c) => c.name);
    for (const name of ['model', 'thinking', 'scoped-models', 'tree', 'fork', 'clone', 'new', 'resume', 'compact', 'name', 'session', 'cost', 'reload', 'export', 'copy', 'settings', 'login', 'logout', 'trust', 'hotkeys', 'changelog', 'quit', 'share', 'bug', 'llama']) {
      expect(names).toContain(name);
    }
    for (const name of ['share', 'bug']) expect(builtins.find((c) => c.name === name)).toMatchObject({ disabled: true, disabledReason: expect.any(String) });
    for (const name of ['settings', 'login', 'logout', 'trust', 'scoped-models', 'import', 'llama']) expect(builtins.find((c) => c.name === name)?.disabled).toBeUndefined();
    expect(builtins.find((c) => c.name === 'compact')?.disabled).toBeUndefined();
    expect(builtins.find((c) => c.name === 'compact')?.argumentHint).toBe('[instructions]');
  });
});

describe('FilesService', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pk-files-'));
  mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
  mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'lib', 'alpha.ts'), '');
  writeFileSync(join(cwd, 'src', 'beta.ts'), '');
  writeFileSync(join(cwd, 'README.md'), '');
  writeFileSync(join(cwd, 'node_modules', 'x', 'i.js'), '');
  writeFileSync(join(cwd, 'secret.log'), '');
  writeFileSync(join(cwd, '.gitignore'), 'secret.log\n');
  const files = new FilesService();

  it('finds files by fuzzy path, ignoring node_modules and what .gitignore names (no git needed)', async () => {
    expect((await files.search(cwd, 'alp')).map((f) => f.path)).toEqual(['src/lib/alpha.ts']);
    const all = (await files.search(cwd, 'x')).map((f) => f.path);
    expect(all.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect((await files.search(cwd, 'secret')).length).toBe(0);
  });

  it('lists the top level first when there is no query, folders before files', async () => {
    expect((await files.search(cwd, '')).map((f) => f.path)).toEqual(['src/', '.gitignore', 'README.md']);
  });

  it('lists the entries of one folder for the Files panel: folders first, nothing ignored', async () => {
    const bare = (nodes: Awaited<ReturnType<typeof files.children>>) => nodes.map(({ name, path, dir }) => ({ name, path, dir }));
    expect(bare(await files.children(cwd))).toEqual([
      { name: 'src', path: 'src', dir: true },
      { name: '.gitignore', path: '.gitignore', dir: false },
      { name: 'README.md', path: 'README.md', dir: false },
    ]);
    expect(bare(await files.children(cwd, 'src'))).toEqual([
      { name: 'lib', path: 'src/lib', dir: true },
      { name: 'beta.ts', path: 'src/beta.ts', dir: false },
    ]);
    expect(bare(await files.children(cwd, 'src/lib/'))).toEqual([{ name: 'alpha.ts', path: 'src/lib/alpha.ts', dir: false }]);
    expect(await files.children(cwd, 'nope')).toEqual([]);
  });

  it('gives files their size and modification time (folders their time only)', async () => {
    const [folder, ...rest] = await files.children(cwd, 'src');
    expect(folder).toMatchObject({ dir: true, mtime: expect.any(Number) });
    expect(folder.size).toBeUndefined();
    expect(rest[0]).toMatchObject({ name: 'beta.ts', size: 0, mtime: expect.any(Number) });
  });

  it('lists what is ignored, greyed, only when asked: the walk skips, "show ignored" reads the disk (and all of an ignored folder)', async () => {
    const top = await files.children(cwd, '', { showIgnored: true });
    expect(top.filter((n) => n.ignored).map((n) => n.name).sort()).toEqual(['node_modules', 'secret.log']);
    expect(top.find((n) => n.name === 'src')?.ignored).toBeUndefined();
    const inside = await files.children(cwd, 'node_modules', { showIgnored: true });
    expect(inside).toMatchObject([{ name: 'x', path: 'node_modules/x', dir: true, ignored: true }]);
    expect((await files.children(cwd, 'node_modules/x', { showIgnored: true })).map((n) => n.name)).toEqual(['i.js']);
    expect((await files.children(cwd)).some((n) => n.ignored)).toBe(false);
  });

  it('offers folders too, marked as such', async () => {
    expect(await files.search(cwd, 'lib/')).toContainEqual({ path: 'src/lib/', dir: true });
  });
});
