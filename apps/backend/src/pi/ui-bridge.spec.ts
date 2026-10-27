import { describe, expect, it } from 'vitest';
import type { PiUiEvent } from '@pi-kit/pi-adapter';
import type { AutocompleteProviderFactory } from './autocomplete';
import { UiBridge } from './ui-bridge';

describe('UiBridge', () => {
  it('holds a confirm dialog as a pending promise until it is answered', async () => {
    const ui = new UiBridge();
    const seen: string[] = [];
    ui.onDialog(() => seen.push('dialog'));
    const answer = ui.confirm('Run git push?', 'origin main');
    expect(seen).toEqual(['dialog']);
    const [pending] = ui.list();
    expect(pending.request).toEqual({ method: 'confirm', title: 'Run git push?', message: 'origin main' });
    expect(ui.answer(pending.id, { status: 'resolved', confirmed: true })).toBe(true);
    await expect(answer).resolves.toBe(true);
    expect(ui.size).toBe(0);
    expect(ui.answer(pending.id, { status: 'cancelled' })).toBe(false);
  });

  it('carries pi’s timeout and the running tool with the request, and does not enforce the timeout itself', async () => {
    const ui = new UiBridge();
    ui.activeTool = () => 'bash';
    const before = Date.now();
    const answer = ui.confirm('Run it?', '', { timeout: 30_000 });
    const [pending] = ui.list();
    expect(pending.request).toMatchObject({ method: 'confirm', title: 'Run it?', tool: 'bash', timeoutMs: 30_000 });
    expect(pending.request.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(pending.request.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(ui.size).toBe(1);
    ui.answer(pending.id, { status: 'cancelled' });
    await expect(answer).resolves.toBe(false);
    // A dialog with no timeout and no tool carries neither.
    ui.activeTool = () => undefined;
    void ui.select('Pick', ['a']);
    expect(ui.list()[0].request).toEqual({ method: 'select', title: 'Pick', options: ['a'] });
  });

  it('answers select, input and editor with a value, and a dismissal with false or undefined', async () => {
    const ui = new UiBridge();
    const select = ui.select('Which?', ['a', 'b']);
    const input = ui.input('Name?', 'placeholder');
    const editor = ui.editor('Edit', 'prefill');
    const confirm = ui.confirm('Sure?', '');
    const [s, i, e, c] = ui.list();
    expect(s.request).toMatchObject({ method: 'select', options: ['a', 'b'] });
    expect(i.request).toMatchObject({ method: 'input', placeholder: 'placeholder' });
    expect(e.request).toMatchObject({ method: 'editor', prefill: 'prefill' });
    ui.answer(s.id, { status: 'resolved', value: 'b' });
    ui.answer(i.id, { status: 'cancelled' });
    ui.answer(e.id, { status: 'resolved', value: 'edited' });
    ui.answer(c.id, { status: 'cancelled' });
    await expect(select).resolves.toBe('b');
    await expect(input).resolves.toBeUndefined();
    await expect(editor).resolves.toBe('edited');
    await expect(confirm).resolves.toBe(false);
  });

  it('reports each dialog to a client once, and dismisses all of them when a run is stopped', async () => {
    const ui = new UiBridge();
    const first = ui.confirm('One?', '');
    ui.markReported(ui.list().map((d) => d.id));
    const second = ui.confirm('Two?', '');
    expect(ui.list(true).map((d) => d.request.title)).toEqual(['Two?']);
    expect(ui.takeAborted()).toBe(false);
    ui.cancelAll();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(ui.takeAborted()).toBe(true);
    expect(ui.takeAborted()).toBe(false);
  });

  it('dismisses a dialog whose AbortSignal fires, and never opens one for a signal that already did', async () => {
    const ui = new UiBridge();
    const controller = new AbortController();
    const answer = ui.confirm('Wait?', '', { signal: controller.signal });
    controller.abort();
    await expect(answer).resolves.toBe(false);
    expect(ui.size).toBe(0);
    await expect(ui.confirm('Late?', '', { signal: controller.signal })).resolves.toBe(false);
    expect(ui.size).toBe(0);
  });

  it('passes notify, status, title and string widgets on, and ignores component widgets', () => {
    const ui = new UiBridge();
    const events: unknown[] = [];
    ui.onUi((e) => events.push(e));
    ui.notify('hi', 'warning');
    ui.setStatus('git', '3 staged');
    ui.setStatus('git', undefined);
    ui.setStatus('speed', '\u001b[38;5;102m87.2 tok/s\u001b[39m');
    expect(ui.statuses.get('speed')).toBe('\u001b[38;5;102m87.2 tok/s\u001b[39m');
    ui.setStatus('speed', undefined);
    ui.setTitle('pi - x');
    ui.setWidget('todo', ['a', 'b'], { placement: 'belowEditor' });
    ui.setWidget('fancy', () => ({}));
    expect(events).toEqual([
      { kind: 'notify', message: 'hi', level: 'warning' },
      { kind: 'status', key: 'git', text: '3 staged' },
      { kind: 'status', key: 'git', text: undefined },
      { kind: 'status', key: 'speed', text: '\u001b[38;5;102m87.2 tok/s\u001b[39m' },
      { kind: 'status', key: 'speed', text: undefined },
      { kind: 'title', title: 'pi - x' },
      { kind: 'widget', key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' },
    ]);
    expect(ui.statuses.size).toBe(0);
  });

  it('builds the context object pi gets, with the TUI-only methods as no-ops', async () => {
    const ui = new UiBridge();
    const context = ui.context({ theme: { fg: 't' } }) as Record<string, (...a: unknown[]) => unknown> & { theme: unknown };
    expect(context['getEditorText']()).toBe('');
    expect(context['getAllThemes']()).toEqual([]);
    await expect(context['custom']()).resolves.toBeUndefined();
    expect(context.theme).toEqual({ fg: 't' });
  });
});

const fruitFactory: AutocompleteProviderFactory = (current) => ({
  ...current,
  async getSuggestions(lines, line, col, options) {
    const match = /^\/pk-fruit (\S*)$/.exec((lines[line] ?? '').slice(0, col));
    if (!match) return current.getSuggestions(lines, line, col, options);
    return { prefix: match[1], items: ['apple', 'banana'].filter((f) => f.startsWith(match[1])).map((f) => ({ value: f, label: f, description: 'fruit' })) };
  },
});
const colorFactory: AutocompleteProviderFactory = (current) => ({
  ...current,
  async getSuggestions(lines, line, col, options) {
    const match = /^\/pk-color (\S*)$/.exec((lines[line] ?? '').slice(0, col));
    if (!match) return current.getSuggestions(lines, line, col, options);
    return { prefix: match[1], items: [{ value: 'red', label: 'red' }] };
  },
});

describe('UiBridge autocomplete providers', () => {
  it('is what the context hands to addAutocompleteProvider, and stacks the factories in order', async () => {
    const ui = new UiBridge();
    const context = ui.context({ theme: {} }) as { addAutocompleteProvider: (factory: AutocompleteProviderFactory) => void };
    context.addAutocompleteProvider(fruitFactory);
    context.addAutocompleteProvider(colorFactory);
    expect(ui.autocompleteProviders).toBe(2);
    // the second factory has nothing for /pk-fruit and delegates to the first through `current`
    expect((await ui.complete('/pk-fruit b', 11)).items.map((i) => i.insert.text)).toEqual(['/pk-fruit banana']);
    expect((await ui.complete('/pk-color ', 10)).items.map((i) => i.value)).toEqual(['red']);
    expect((await ui.complete('hello', 5)).items).toEqual([]);
  });

  it('forgets the factories when the extensions are reloaded, so they do not pile up', async () => {
    const ui = new UiBridge();
    ui.addAutocompleteProvider(fruitFactory);
    await ui.reloading(async () => {
      expect(ui.autocompleteProviders).toBe(0);
      // the reloaded extension adds its provider again at session_start
      ui.addAutocompleteProvider(fruitFactory);
    });
    expect(ui.autocompleteProviders).toBe(1);
    expect((await ui.complete('/pk-fruit a', 11)).items.map((i) => i.value)).toEqual(['apple']);
  });

  it('forgets everything when the session is closed', async () => {
    const ui = new UiBridge();
    ui.addAutocompleteProvider(fruitFactory);
    ui.registerComposer({ op: 'action', id: 'a', label: 'A', text: 'x' });
    ui.clearExtensions();
    expect(ui.autocompleteProviders).toBe(0);
    expect(ui.composerRegistrations()).toEqual([]);
  });
});

describe('UiBridge composer registrations', () => {
  const hello = { op: 'action', id: 'hello', label: 'Say hello', icon: 'Hi', text: '/pk-fruit ' } as const;

  it('relays a valid registration as a composer event and keeps the latest per id', () => {
    const ui = new UiBridge();
    const events: PiUiEvent[] = [];
    ui.onUi((e) => events.push(e));
    expect(ui.registerComposer(hello)).toBe(true);
    expect(ui.registerComposer({ ...hello, label: 'Greet' })).toBe(true);
    expect(ui.registerComposer({ op: 'suggestion', id: 'ask', title: 'Ask', text: 'apple' })).toBe(true);
    expect(events.map((e) => (e.kind === 'composer' ? e.registration.id : e.kind))).toEqual(['hello', 'hello', 'ask']);
    expect(ui.composerRegistrations()).toEqual([
      { ...hello, label: 'Greet' },
      { op: 'suggestion', id: 'ask', title: 'Ask', text: 'apple' },
    ]);
  });

  it('drops an invalid payload without throwing, and says so', () => {
    const ui = new UiBridge();
    const events: PiUiEvent[] = [];
    ui.onUi((e) => events.push(e));
    for (const bad of [undefined, null, 'x', {}, { op: 'action', id: 'a' }, { op: 'action', id: 'a', label: 'x', icon: 'far too long', text: 't' }, { op: 'nope', id: 'a' }]) {
      expect(ui.registerComposer(bad)).toBe(false);
    }
    expect(events).toEqual([]);
    expect(ui.composerRegistrations()).toEqual([]);
  });

  it('does not repeat an identical registration, and a removal only counts for a known id', () => {
    const ui = new UiBridge();
    const events: PiUiEvent[] = [];
    ui.onUi((e) => events.push(e));
    ui.registerComposer(hello);
    ui.registerComposer(hello);
    ui.registerComposer({ op: 'remove', id: 'unknown' });
    ui.registerComposer({ op: 'remove', id: 'hello' });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ kind: 'composer', registration: { op: 'remove', id: 'hello' } });
    expect(ui.composerRegistrations()).toEqual([]);
  });

  it('hands events that no run listens to to the unattached listeners instead', () => {
    const ui = new UiBridge();
    const orphans: PiUiEvent[] = [];
    ui.onUnattached((e) => orphans.push(e));
    ui.registerComposer(hello);
    const events: PiUiEvent[] = [];
    const off = ui.onUi((e) => events.push(e));
    ui.registerComposer({ ...hello, label: 'Greet' });
    off();
    expect(orphans).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('on reload removes what the reloaded extensions did not register again', async () => {
    const ui = new UiBridge();
    ui.registerComposer(hello);
    ui.registerComposer({ op: 'suggestion', id: 'old', title: 'Old', text: 'x' });
    const events: PiUiEvent[] = [];
    ui.onUi((e) => events.push(e));
    await ui.reloading(async () => {
      ui.registerComposer(hello);
    });
    expect(events).toEqual([{ kind: 'composer', registration: { op: 'remove', id: 'old' } }]);
    expect(ui.composerRegistrations().map((r) => r.id)).toEqual(['hello']);
  });

  it('also sweeps when the reload fails', async () => {
    const ui = new UiBridge();
    ui.registerComposer(hello);
    await expect(ui.reloading(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(ui.composerRegistrations()).toEqual([]);
  });
});

