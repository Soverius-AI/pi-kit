import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { overrideTrusts } from './trust.service';
import { countMcpServers, scanTrustResources } from './trust-scan';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'pk-trust-')));
const put = (root: string, rel: string, text = '') => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('scanTrustResources', () => {
  it('finds what pi gates behind project trust: extensions, skills, MCP servers, prompts, settings, system prompts', () => {
    const root = tmp();
    put(root, '.pi/extensions/git-guard.ts');
    put(root, '.pi/extensions/tools/index.ts');
    put(root, '.pi/skills/pdf-tools/SKILL.md');
    put(root, '.pi/skills/not-a-skill/readme.txt');
    put(root, '.pi/prompts/fix.md');
    put(root, '.pi/themes/mine.json');
    put(root, '.pi/mcp.json', JSON.stringify({ mcpServers: { fs: {}, git: {} } }));
    put(root, '.pi/settings.json', '{}');
    put(root, '.pi/SYSTEM.md');
    expect(scanTrustResources(root)).toEqual([
      { kind: 'extension', path: '.pi/extensions/git-guard.ts' },
      { kind: 'extension', path: '.pi/extensions/tools' },
      { kind: 'skill', path: '.pi/skills/pdf-tools/SKILL.md' },
      { kind: 'prompt', path: '.pi/prompts/fix.md' },
      { kind: 'theme', path: '.pi/themes/mine.json' },
      { kind: 'mcp', path: '.pi/mcp.json', servers: 2 },
      { kind: 'settings', path: '.pi/settings.json' },
      { kind: 'prompt-file', path: '.pi/SYSTEM.md' },
    ]);
  });

  it('finds .agents/skills in the folder and in an ancestor, but not the user\'s own', () => {
    const root = tmp();
    const child = join(root, 'a', 'b');
    mkdirSync(child, { recursive: true });
    put(root, '.agents/skills/up/SKILL.md');
    put(child, '.agents/skills/here/SKILL.md');
    const found = scanTrustResources(child, join(root, '.agents', 'skills')).map((r) => r.path);
    expect(found).toEqual(['.agents/skills/here/SKILL.md']);
    expect(scanTrustResources(child).map((r) => r.path)).toEqual(['.agents/skills/here/SKILL.md', '../../.agents/skills/up/SKILL.md']);
  });

  it('is empty for a bare .pi folder', () => {
    const root = tmp();
    mkdirSync(join(root, '.pi'));
    expect(scanTrustResources(root)).toEqual([]);
  });

  it('counts MCP servers, and says nothing for a file it cannot read', () => {
    const root = tmp();
    put(root, 'ok.json', '{"mcpServers":{"a":{}}}');
    put(root, 'bad.json', '{nope');
    expect(countMcpServers(join(root, 'ok.json'))).toBe(1);
    expect(countMcpServers(join(root, 'bad.json'))).toBeUndefined();
  });
});

describe('overrideTrusts (the test-only PI_KIT_TRUSTED_CWDS flag)', () => {
  const env = { PI_KIT_TRUSTED_CWDS: '/work/a:/work/b' };

  it('trusts the listed folders and their children, nothing else', () => {
    expect(overrideTrusts('/work/a', env)).toBe(true);
    expect(overrideTrusts('/work/b/sub', env)).toBe(true);
    expect(overrideTrusts('/work/ab', env)).toBe(false);
    expect(overrideTrusts('/other', env)).toBe(false);
  });

  it('is ignored in production, which is how the desktop app runs the backend', () => {
    expect(overrideTrusts('/work/a', { ...env, NODE_ENV: 'production' })).toBe(false);
    expect(overrideTrusts('/work/a', {})).toBe(false);
  });
});
