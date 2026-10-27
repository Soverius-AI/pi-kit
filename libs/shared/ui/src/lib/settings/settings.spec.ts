import { english, german } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import { checkKeyShape, keyHelp, lastFour } from './api-key';
import {
  settingsCatalog,
  settingsSections,
  type SettingEntry,
  matchCounts,
  searchSettings,
  settingById,
  storageLabel,
} from './catalog';

const entry = (id: string): SettingEntry => settingById(english, id) as SettingEntry;
import { canonicalCombo, comboFromEvent, eventMatches, findConflicts, formatCombo, isValidPiKey, usedBy } from './keys';
import { changedShortcuts, resolveShortcuts, shortcutConflicts } from './shortcuts';

const ev = (
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
  code?: string,
) => ({
  key,
  ...(code ? { code } : {}),
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('key combinations', () => {
  it('spells one combination one way', () => {
    expect(canonicalCombo('shift+ctrl+p')).toBe('ctrl+shift+p');
    expect(canonicalCombo('Ctrl+Shift+P')).toBe('ctrl+shift+p');
    expect(canonicalCombo('esc')).toBe('escape');
    expect(canonicalCombo('Alt+Up')).toBe('alt+up');
    expect(canonicalCombo('ctrl++')).toBe('ctrl++');
    expect(canonicalCombo('ctrl+')).toBeUndefined();
    expect(canonicalCombo('')).toBeUndefined();
  });

  it('reads a keyboard event in either scope', () => {
    expect(comboFromEvent(ev('M', { metaKey: true, shiftKey: true }, 'KeyM'), 'pi-kit')).toBe('mod+shift+m');
    expect(comboFromEvent(ev('m', { ctrlKey: true, shiftKey: true }, 'KeyM'), 'pi-kit')).toBe('mod+shift+m');
    expect(comboFromEvent(ev('p', { ctrlKey: true, shiftKey: true }, 'KeyP'), 'pi')).toBe('ctrl+shift+p');
    expect(comboFromEvent(ev('p', { metaKey: true }, 'KeyP'), 'pi')).toBe('super+p');
    // ⌥M types a µ on a Mac; the physical key is what counts.
    expect(comboFromEvent(ev('µ', { altKey: true }, 'KeyM'), 'pi')).toBe('alt+m');
    expect(comboFromEvent(ev('ArrowUp', { altKey: true }), 'pi')).toBe('alt+up');
    expect(comboFromEvent(ev('Escape'), 'pi')).toBe('escape');
    expect(comboFromEvent(ev('Shift', { shiftKey: true }), 'pi')).toBeUndefined();
  });

  it('matches an event against a saved pi-kit combination', () => {
    expect(eventMatches('mod+k', ev('k', { metaKey: true }, 'KeyK'))).toBe(true);
    expect(eventMatches('mod+k', ev('k', { ctrlKey: true }, 'KeyK'))).toBe(true);
    expect(eventMatches('mod+shift+k', ev('k', { metaKey: true }, 'KeyK'))).toBe(false);
    expect(eventMatches('mod+k', ev('k', { metaKey: true, altKey: true }, 'KeyK'))).toBe(false);
  });

  it('formats for the platform', () => {
    expect(formatCombo('mod+shift+m', true)).toBe('⌘⇧M');
    expect(formatCombo('mod+shift+m', false)).toBe('Ctrl+Shift+M');
    expect(formatCombo('escape', true)).toBe('Esc');
    expect(formatCombo('ctrl+p', true)).toBe('⌃P');
  });

  it('finds the actions that share a key', () => {
    const conflicts = findConflicts([
      { id: 'app.model.cycleForward', keys: ['ctrl+p'] },
      { id: 'app.session.togglePath', keys: ['Ctrl+P'] },
      { id: 'app.exit', keys: ['ctrl+d'] },
      { id: 'twice', keys: ['ctrl+x', 'ctrl+x'] },
    ]);
    expect(conflicts.get('app.model.cycleForward')).toEqual(['app.session.togglePath']);
    expect(conflicts.get('app.session.togglePath')).toEqual(['app.model.cycleForward']);
    expect(conflicts.has('app.exit')).toBe(false);
    expect(conflicts.has('twice')).toBe(false);
  });

  it('names who already uses a key', () => {
    const list = [
      { id: 'a', keys: ['mod+k'] },
      { id: 'b', keys: ['mod+n'] },
    ];
    expect(usedBy(list, 'mod+n')).toEqual(['b']);
    expect(usedBy(list, 'mod+n', 'b')).toEqual([]);
    expect(usedBy(list, 'mod+j')).toEqual([]);
  });

  it('accepts the keys pi documents', () => {
    for (const ok of ['ctrl+shift+x', 'alt+up', 'escape', 'f5', 'super+k', 'ctrl+1', 'pageUp', 'ctrl+]'])
      expect(isValidPiKey(ok), ok).toBe(true);
    for (const bad of ['', 'ctrl+', 'banana', 'ctrl+shift']) expect(isValidPiKey(bad), bad).toBe(false);
  });
});

describe('pi-kit shortcuts', () => {
  it('start at the defaults and take saved changes', () => {
    expect(resolveShortcuts(english, undefined)['cycle-model']).toBe('mod+shift+m');
    expect(resolveShortcuts(english, { 'cycle-model': 'Shift+Mod+J' })['cycle-model']).toBe('mod+shift+j');
    // Unusable text falls back to the default instead of leaving an action without a key.
    expect(resolveShortcuts(english, { 'cycle-model': 'banana' })['cycle-model']).toBe('mod+shift+m');
  });

  it('flag a shortcut that takes another’s key, editable or fixed', () => {
    expect(shortcutConflicts(english, resolveShortcuts(english, undefined)).size).toBe(0);
    const clash = shortcutConflicts(english, resolveShortcuts(english, { 'new-thread': 'mod+k' }));
    expect(clash.get('new-thread')).toEqual(['command-palette']);
    expect(clash.get('command-palette')).toEqual(['new-thread']);
    expect(shortcutConflicts(english, resolveShortcuts(english, { 'new-thread': 'escape' })).get('new-thread')).toEqual(
      ['stop'],
    );
  });

  it('keep only what differs from the default', () => {
    expect(
      changedShortcuts(english, resolveShortcuts(english, { 'new-thread': 'mod+j', 'command-palette': 'mod+k' })),
    ).toEqual({
      'new-thread': 'mod+j',
    });
  });
});

describe('the settings catalog and its search', () => {
  it('has unique ids and knows every section', () => {
    const ids = settingsCatalog(english).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sections = new Set(settingsSections(english).map((s) => s.id));
    for (const setting of settingsCatalog(english)) expect(sections.has(setting.section), setting.id).toBe(true);
    for (const section of settingsSections(english))
      expect(
        settingsCatalog(english).some((s) => s.section === section.id),
        section.id,
      ).toBe(true);
  });

  it('finds a setting by a word in its description', () => {
    // “summarises” appears only in the compaction setting’s description.
    expect([...searchSettings(english, 'summarises')]).toEqual(['auto-compaction']);
    expect(searchSettings(english, 'compaction').has('auto-compaction')).toBe(true);
    expect(searchSettings(english, 'SUMMARISES  context').has('auto-compaction')).toBe(true);
    expect(searchSettings(english, 'xyzzy').size).toBe(0);
  });

  it('finds a setting by a keyword and by its section', () => {
    expect(searchSettings(english, 'hotkey').has('keys-pi-kit')).toBe(true);
    expect(searchSettings(english, 'openrouter').has('providers')).toBe(true);
    expect(searchSettings(english, 'keybindings').has('keys-pi')).toBe(true);
  });

  it('routes downloads and skill controls to their own menu items', () => {
    expect(settingsSections(english).find((section) => section.id === 'skills')?.label).toBe('Skills');
    expect(settingsSections(english).find((section) => section.id === 'extensions')?.label).toBe('Extensions');
    expect(entry('skill-commands').section).toBe('skills');
    expect(entry('skills').section).toBe('skills');
    expect(entry('resources').section).toBe('extensions');
    expect(entry('packages').section).toBe('extensions');
    for (const query of ['hf', 'Hugging Face', 'GGUF', 'download'])
      expect(matchCounts(english, searchSettings(english, query)).has('local-models'), query).toBe(true);
    expect(searchSettings(english, 'skills').has('resources')).toBe(false);
  });

  it('matches everything for an empty query and counts per section', () => {
    expect(searchSettings(english, '  ').size).toBe(settingsCatalog(english).length);
    const counts = matchCounts(english, searchSettings(english, 'font'));
    expect(counts.get('appearance')).toBeGreaterThan(0);
    expect(counts.get('general')).toBeUndefined();
  });

  it('says where a setting is stored', () => {
    expect(storageLabel(english, entry('auto-compaction'))).toBe('pi settings.json');
    expect(storageLabel(english, entry('theme'))).toBe('pi-kit database');
    expect(storageLabel(english, { storage: 'project', file: 'mcp.json' })).toBe('project .pi/mcp.json');
    expect(storageLabel(english, entry('providers'))).toBe('pi auth.json');
  });
});

describe('the API key helpers', () => {
  it('knows where to get a key and what it needs', () => {
    expect(keyHelp(english, 'openrouter').url).toContain('openrouter.ai');
    expect(keyHelp(english, 'some-local-thing').url).toBeUndefined();
    expect(keyHelp(english, 'some-local-thing').needs).toMatch(/provider/);
  });

  it('checks the shape of pasted text, not its value', () => {
    expect(checkKeyShape(english, 'openrouter', 'OpenRouter', '').state).toBe('empty');
    expect(checkKeyShape(english, 'openrouter', 'OpenRouter', `sk-or-v1-${'a'.repeat(40)}`).state).toBe('ok');
    expect(checkKeyShape(english, 'openrouter', 'OpenRouter', `sk-ant-${'a'.repeat(40)}`).state).toBe('mismatch');
    expect(checkKeyShape(english, 'openrouter', 'OpenRouter', 'sk-or-v1-short').state).toBe('mismatch');
    expect(
      checkKeyShape(english, 'openrouter', 'OpenRouter', `sk-or-v1-${'a'.repeat(20)} ${'b'.repeat(20)}`).state,
    ).toBe('mismatch');
    expect(checkKeyShape(english, 'acme', 'Acme', 'x'.repeat(24)).state).toBe('unknown');
    expect(checkKeyShape(english, 'acme', 'Acme', 'abc').state).toBe('mismatch');
    expect(checkKeyShape(english, 'anthropic', 'Anthropic', `sk-ant-${'a'.repeat(40)}`).message).toMatch(
      /an Anthropic key/,
    );
  });

  it('never puts the text in its message', () => {
    const secret = `sk-or-v1-${'q9Zk'.repeat(10)}`;
    for (const shape of [
      checkKeyShape(english, 'openrouter', 'OpenRouter', secret),
      checkKeyShape(english, 'anthropic', 'Anthropic', secret),
    ])
      expect(shape.message).not.toContain('q9Zk');
  });

  it('shows the last four characters of a stored key', () => {
    expect(lastFour('sk-or-v1-abcdefgh1234')).toBe('1234');
    expect(lastFour('short')).toBe('');
  });
});

describe('localized settings discovery', () => {
  it('searches translated names and descriptions as displayed in German', () => {
    expect(settingsSections(german).find((section) => section.id === 'models')?.label).toBe('Chatmodelle');
    expect(settingsSections(german).find((section) => section.id === 'local-models')?.label).toBe('Lokale Modelle');
    expect(searchSettings(german, 'Speicherplatz')).toContain('local-models');
    expect(searchSettings(german, 'Sprache Oberfläche')).toContain('language');
    expect(settingById(german, 'language')?.name).toBe('Sprache der Oberfläche');
    expect(searchSettings(english, 'interface language')).toContain('language');
  });
});
