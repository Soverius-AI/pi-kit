import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appSettingsSetSetting, appSettingsSettings, provideMockApi } from '@pi-kit/api';
import { ThemeStore, UiStore } from '@pi-kit/data-access';
import type { Command } from '@pi-kit/protocol';
import { ChatStore } from './chat.store';
import { CommandRegistry } from './commands';
import { PaletteStore } from './palette.store';

const command = (name: string, over: Partial<Command> = {}): Command =>
  ({ name, description: name, kind: 'action', source: 'builtin', ...over }) as unknown as Command;

describe('PaletteStore', () => {
  const commands = signal<Command[]>([
    command('settings'),
    command('model', { argumentHint: '<id>' } as never),
    command('review', { kind: 'prompt' } as never),
    command('skill:pdf-tools', { kind: 'prompt', source: 'skill', origin: 'project' } as never),
    command('triage', { kind: 'prompt', source: 'prompt', origin: 'user' } as never),
  ]);
  const registry = {
    newThread: vi.fn(async () => undefined),
    run: vi.fn(async () => undefined),
    find: (name: string) => commands().find((c) => c.name === name),
    groups: (q: string) => [
      {
        title: 'Commands',
        items: commands()
          .filter((c) => c.name.includes(q))
          .map((c) => ({ id: c.name, name: c.name })),
      },
    ],
  };

  const chat = { addChip: vi.fn() };

  const make = () => {
    const palette = TestBed.inject(PaletteStore);
    TestBed.tick();
    return palette;
  };

  beforeEach(() => {
    localStorage.clear();
    registry.newThread.mockClear();
    registry.run.mockClear();
    chat.addChip.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CommandRegistry, useValue: registry },
        { provide: ChatStore, useValue: chat },
        ...provideMockApi([
          [appSettingsSettings, { all: async () => ({}), set: async () => undefined }.all, () => []],
          [
            appSettingsSetSetting,
            { all: async () => ({}), set: async () => undefined }.set,
            (o) => [o.path?.['key'], o.body?.['value']],
          ],
        ]),
      ],
    });
  });

  it('lists the app actions, then the commands, and filters both by the query', () => {
    const palette = make();
    expect(palette.groups().map((g) => g.title)).toEqual(['App', 'Commands']);
    palette.setQuery('theme');
    expect(palette.groups()[0].items.map((i) => i.id)).toEqual(['app:theme']);
    expect(palette.flat().length).toBeGreaterThan(0);
  });

  it('keeps the selection on a real entry and moves it with the arrows, wrapping', () => {
    const palette = make();
    expect(palette.selectedId()).toBe('app:new');
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    palette.onKey(down);
    expect(down.defaultPrevented).toBe(true);
    expect(palette.selectedId()).toBe('app:theme');
    palette.onKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    palette.onKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(palette.selectedId()).toBe(palette.flat().at(-1)?.id);
    palette.setQuery('settings');
    TestBed.tick();
    expect(palette.selectedId()).toBe('settings');
  });

  it('Enter runs the selected app action and closes the palette', () => {
    const palette = make();
    const ui = TestBed.inject(UiStore);
    ui.togglePalette();
    palette.onKey(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(ui.palette()).toBe(false);
    expect(registry.newThread).toHaveBeenCalled();
  });

  it('a built-in without arguments runs; one that wants an argument, or a prompt, goes into the composer', () => {
    const palette = make();
    const ui = TestBed.inject(UiStore);
    palette.pick({ id: 'settings', name: 'settings' });
    expect(registry.run).toHaveBeenCalledWith(expect.objectContaining({ name: 'settings' }));
    palette.pick({ id: 'model', name: 'model' });
    expect(ui.composerText()?.text).toBe('/model ');
    palette.pick({ id: 'review', name: 'review' });
    expect(ui.composerText()?.text).toBe('/review ');
    expect(registry.run).toHaveBeenCalledTimes(1);
  });

  it('a skill or a prompt template becomes a chip of the composer, not text', () => {
    const palette = make();
    const ui = TestBed.inject(UiStore);
    palette.pick({ id: 'skill:pdf-tools', name: 'skill:pdf-tools' });
    expect(chat.addChip).toHaveBeenLastCalledWith({
      kind: 'skill',
      name: 'pdf-tools',
      pinned: false,
      scope: 'project',
    });
    palette.pick({ id: 'triage', name: 'triage' });
    expect(chat.addChip).toHaveBeenLastCalledWith({ kind: 'prompt', name: 'triage', pinned: false, scope: 'user' });
    expect(ui.composerText()).toBeUndefined();
    expect(ui.composerFocus()).toBe(2);
  });

  it('a disabled entry does nothing; "Switch theme" flips the theme', () => {
    const palette = make();
    palette.pick({ id: 'app:new', name: 'x', disabled: true });
    expect(registry.newThread).not.toHaveBeenCalled();
    const theme = TestBed.inject(ThemeStore);
    const before = theme.theme();
    palette.pick({ id: 'app:theme', name: 'Switch theme' });
    expect(theme.theme()).not.toBe(before);
  });

  it('opens from an empty query and Escape closes it and hands the focus back to the composer', () => {
    const palette = make();
    const ui = TestBed.inject(UiStore);
    palette.setQuery('abc');
    ui.togglePalette();
    TestBed.tick();
    expect(palette.query()).toBe('');
    ui.togglePalette();
    palette.onKey(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(ui.palette()).toBe(false);
    expect(ui.composerFocus()).toBe(1);
  });
});
