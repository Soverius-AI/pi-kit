import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piKeybindings, savePiKeybindings } from './pi-keybindings';

const agentDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'pk-keys-')));
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'keybindings.json'), 'utf8')) as Record<string, unknown>;

describe('pi key bindings', () => {
  it('lists pi’s defaults when there is no keybindings.json', () => {
    const list = piKeybindings(agentDir());
    const cycle = list.find((b) => b.id === 'app.model.cycleForward');
    expect(cycle).toMatchObject({ keys: ['ctrl+p'], default: ['ctrl+p'], custom: false });
  });

  it('writes only what differs from the default and reads it back', () => {
    const dir = agentDir();
    const saved = savePiKeybindings(dir, { 'app.session.new': ['ctrl+shift+n'], 'app.model.cycleForward': ['ctrl+p'], 'app.exit': ['ctrl+d'] }).find((b) => b.id === 'app.session.new');
    expect(saved).toMatchObject({ keys: ['ctrl+shift+n'], custom: true });
    expect(read(dir)).toEqual({ 'app.session.new': 'ctrl+shift+n' });
    expect(piKeybindings(dir).find((b) => b.id === 'app.model.cycleForward')?.custom).toBe(false);
  });

  it('keeps keys the table does not know and drops an action that goes back to its default', () => {
    const dir = agentDir();
    writeFileSync(join(dir, 'keybindings.json'), JSON.stringify({ $schema: 'https://pi.dev/schemas/keybindings.schema.json', 'tui.altScreen.pageUp': [], 'app.session.new': 'ctrl+shift+n' }));
    savePiKeybindings(dir, {});
    expect(read(dir)).toEqual({ $schema: 'https://pi.dev/schemas/keybindings.schema.json', 'tui.altScreen.pageUp': [] });
  });

  it('switches an action off with an empty list and allows several keys', () => {
    const dir = agentDir();
    savePiKeybindings(dir, { 'app.suspend': [], 'app.session.tree': ['ctrl+shift+t', 'alt+shift+t'] });
    expect(read(dir)).toEqual({ 'app.suspend': [], 'app.session.tree': ['ctrl+shift+t', 'alt+shift+t'] });
    const list = piKeybindings(dir);
    expect(list.find((b) => b.id === 'app.suspend')).toMatchObject({ keys: [], custom: true });
  });

  it('refuses an action pi does not have', () => {
    expect(() => savePiKeybindings(agentDir(), { 'app.nothing': ['ctrl+x'] })).toThrow(/no action called app.nothing/);
  });

  it('shows pi’s defaults when the file cannot be read', () => {
    const dir = agentDir();
    writeFileSync(join(dir, 'keybindings.json'), '{ not json');
    expect(piKeybindings(dir).find((b) => b.id === 'app.exit')).toMatchObject({ keys: ['ctrl+d'], custom: false });
  });
});
