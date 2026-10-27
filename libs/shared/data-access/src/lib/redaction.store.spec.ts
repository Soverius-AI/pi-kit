import { TestBed } from '@angular/core/testing';
import { provideMockApi, secretsRedactionConfig, secretsSaveRedaction } from '@pi-kit/api';

import { RedactionStore } from './redaction.store';
import { ToastStore } from './toast.store';

const GITHUB = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('RedactionStore', () => {
  const api = { get: vi.fn(), save: vi.fn() };
  const make = () => {
    const store = TestBed.inject(RedactionStore);
    TestBed.tick();
    return store;
  };

  beforeEach(() => {
    api.get.mockReset();
    api.save.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [secretsRedactionConfig, api.get, () => []],
          [secretsSaveRedaction, api.save, (o) => [o.body]],
        ]),
      ],
    });
  });

  it('loads the configuration; until then it masks the built-in key shapes', () => {
    const store = make();
    expect(store.loaded()).toBe(false);
    expect(store.text(`token ${GITHUB}`)).toBe('token [redacted github token …6789]');
  });

  it('masks every string of a message, keeps its ids and roles, and hands back the same object when there is nothing to mask', () => {
    const store = make();
    const dirty = { id: 'm1', role: 'user' as const, content: `use ${GITHUB} please` };
    const clean = {
      id: 'm2',
      role: 'assistant' as const,
      content: 'Hello',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    };
    const out = store.message(dirty);
    expect(out).toEqual({ id: 'm1', role: 'user', content: 'use [redacted github token …6789] please' });
    expect(dirty.content).toContain(GITHUB);
    expect(store.message(clean)).toBe(clean);
  });

  it('masks a key that sits in the arguments of a tool call', () => {
    const store = make();
    const message = {
      id: 'a1',
      role: 'assistant' as const,
      toolCalls: [
        {
          id: 'c1',
          type: 'function' as const,
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: `curl -H "Authorization: Bearer ${'x'.repeat(30)}" https://x` }),
          },
        },
      ],
    };
    const out = store.message(message);
    expect(out.toolCalls?.[0].function.arguments).toContain('[redacted bearer token');
    expect(out.toolCalls?.[0].function.name).toBe('bash');
  });

  it('keeps one redacted copy per message object, and forgets them when the patterns change', async () => {
    const store = make();
    const message = { id: 'm1', role: 'user' as const, content: 'use acme_abcdef123456 here' };
    await store.prepare([message]);
    const first = store.message(message);
    expect(first).toBe(message);
    expect(store.message(message)).toBe(first);
    api.save.mockResolvedValueOnce({
      config: { patterns: [{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }], offFor: [] },
      errors: [],
    });
    expect(await store.save({ patterns: [{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }], offFor: [] })).toBe(true);
    expect(store.message(message)).toEqual({ id: 'm1', role: 'user', content: 'use [redacted acme token …3456] here' });
  });

  it('is off for a folder the person switched it off for', async () => {
    api.get.mockResolvedValueOnce({ config: { patterns: [], offFor: ['/p/secret-notes'] }, errors: [] });
    const store = make();
    await store.load();
    expect(store.loaded()).toBe(true);
    expect(store.enabledFor('/p/secret-notes')).toBe(false);
    expect(store.enabledFor('/p/other')).toBe(true);
    expect(store.enabledFor(undefined)).toBe(true);
  });

  it('masks repeated tool output across cloned messages and refreshes cached text when rules change', async () => {
    const store = make();
    const content = `${'Repeated output. '.repeat(20)}${GITHUB} acme_abcdef123456`;
    const message = { id: 'tool', role: 'tool', content };
    await store.prepare([message]);
    const first = store.message(message);
    expect(store.message(structuredClone(message))).toEqual(first);
    expect(first.content).not.toContain(GITHUB);
    expect(first.content).toContain('acme_abcdef123456');
    api.save.mockResolvedValueOnce({
      config: { patterns: [{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }], offFor: [] },
      errors: [],
    });
    await store.save({ patterns: [{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }], offFor: [] });
    const updated = store.message(structuredClone(message));
    expect(updated.content).not.toContain(GITHUB);
    expect(updated.content).toContain('[redacted acme token …3456]');
    expect(message.content).toBe(content);
  });

  it('still masks tool results after the bounded snapshot cache evicts older output', () => {
    const store = make();
    for (let index = 0; index < 150; index++) {
      const message = { id: String(index), content: `${index} ${'output '.repeat(6000)}${GITHUB}` };
      expect(store.message(message).content).not.toContain(GITHUB);
    }
    expect(store.text(`0 ${'output '.repeat(6000)}${GITHUB}`)).not.toContain(GITHUB);
  });

  it('says so when a save fails, and keeps what it had', async () => {
    const store = make();
    const toasts = TestBed.inject(ToastStore);
    api.save.mockRejectedValueOnce(new Error('offline'));
    expect(await store.save({ patterns: [], offFor: ['/x'] })).toBe(false);
    expect(toasts.items()[0].text).toMatch(/Could not save the redaction settings: offline/);
    expect(store.config().offFor).toEqual([]);
  });
});
