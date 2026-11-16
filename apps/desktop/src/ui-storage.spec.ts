import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { UiStorage } from './ui-storage';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((file) => rm(file, { recursive: true, force: true })));
});

it('migrates UI preferences once, excludes credentials, and preserves ordered writes across a restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-kit-ui-cache-'));
  folders.push(folder);
  const file = join(folder, 'ui-storage.json');
  const cache = new UiStorage(file);
  const migrate = vi.fn(async () => ({
    'pi-kit.theme': 'pi-light',
    'pi-kit.pinned-chips': '["skill"]',
    'pk.graph.fold.t1': '0',
    'pi-kit.token': 'not-a-real-token',
  }));
  await cache.load(migrate);
  expect(cache.snapshot()).toEqual({
    'pi-kit.theme': 'pi-light',
    'pi-kit.pinned-chips': '["skill"]',
    'pk.graph.fold.t1': '0',
  });
  await Promise.all([cache.set('pi-kit.theme', 'pi-dark'), cache.set('pi-kit.theme', 'pi-light')]);
  await cache.flush();
  expect(JSON.parse(await readFile(file, 'utf8'))['pi-kit.theme']).toBe('pi-light');
  const reopened = new UiStorage(file);
  await reopened.load(migrate);
  expect(reopened.snapshot()).toEqual(cache.snapshot());
  expect(migrate).toHaveBeenCalledTimes(1);
  await expect(cache.set('pi-kit.token', 'anything')).rejects.toThrow('Invalid UI preference');
});

it('persists thread selection and all current renderer preferences across a restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-kit-ui-selection-'));
  folders.push(folder);
  const file = join(folder, 'ui-storage.json');
  const cache = new UiStorage(file);
  const values = {
    'pi-kit.theme': 'pi-dark',
    'pi-kit.look': '{"density":"compact"}',
    'pi-kit.showUsage': 'true',
    'pi-kit.copilotInspector': 'false',
    'pi-kit.entryInstance': 'local-instance',
    'pi-kit.workbench-ref.v1': JSON.stringify({
      instanceId: 'local-instance',
      cwd: 'C:\\projects\\example',
      threadId: 'selected-thread',
    }),
    'pi-kit.pinned-chips': '["skill"]',
    'pk.files.showIgnored': '1',
    'pk.graph.fold.selected-thread': '0',
    'pi-kit.preview-dismissals.v1': '["selected-thread"]',
    'pi-kit.preview-auto-open.v1': 'ask',
    'pi-kit.preview-hint-dismissed.v1': '1',
    'pi-kit.remoteAccess.port': '4317',
  };
  await cache.load(async () => ({}));
  for (const [key, value] of Object.entries(values)) await cache.set(key, value);
  const reopened = new UiStorage(file);
  await reopened.load(async () => {
    throw new Error('must use the saved file');
  });
  expect(reopened.snapshot()).toEqual(values);
});

it('preserves owner-scoped preferences independently for each remote project owner', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-kit-ui-scoped-'));
  folders.push(folder);
  const file = join(folder, 'ui-storage.json');
  const scoped = (owner: string, key: string) => JSON.stringify(['pi-kit.owner.v1', owner, key]);
  const values = {
    [scoped('owner-a', 'pi-kit.pinned-chips')]: '["skill-a"]',
    [scoped('owner-b', 'pi-kit.pinned-chips')]: '["skill-b"]',
    [scoped('owner-a', 'pk.files.showIgnored')]: '1',
    [scoped('owner-b', 'pk.files.showIgnored')]: '0',
    [scoped('owner-a', 'pk.graph.fold.thread')]: '0',
  };
  const cache = new UiStorage(file);
  await cache.load(async () => ({}));
  for (const [key, value] of Object.entries(values)) await cache.set(key, value);
  const reopened = new UiStorage(file);
  await reopened.load(async () => ({}));
  expect(reopened.snapshot()).toEqual(values);
});

it('filters credentials and malformed scoped keys during migration as well as writes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-kit-ui-filter-'));
  folders.push(folder);
  const cache = new UiStorage(join(folder, 'ui-storage.json'));
  const invalidKeys = [
    'pi-kit.token',
    'pi-kit.owner',
    'pi-kit.backendUrl',
    'pi-kit.unknown',
    'pk.graph.fold.',
    JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pi-kit.token']),
    JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pi-kit.owner']),
    JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pi-kit.backendUrl']),
    JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pi-kit.theme']),
    JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pk.graph.fold.']),
    JSON.stringify([
      'pi-kit.owner.v1',
      'owner-a',
      JSON.stringify(['pi-kit.owner.v1', 'owner-b', 'pk.files.showIgnored']),
    ]),
    JSON.stringify(['pi-kit.owner.v1', '', 'pk.files.showIgnored']),
    JSON.stringify(['pi-kit.owner.v1', null, 'pk.files.showIgnored']),
    JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pk.files.showIgnored', 'extra']),
    JSON.stringify(['unknown-scope', 'owner-a', 'pk.files.showIgnored']),
    JSON.stringify({ key: 'pk.files.showIgnored' }),
    '["pi-kit.owner.v1",',
  ];
  const validKey = JSON.stringify(['pi-kit.owner.v1', 'owner-a', 'pk.files.showIgnored']);
  await cache.load(async () => ({
    ...Object.fromEntries(invalidKeys.map((key) => [key, 'not-a-real-token'])),
    'pi-kit.workbench-ref.v1': '{"instanceId":"local-instance"}',
    'pi-kit.theme': 'x'.repeat(512 * 1024 + 1),
    'pi-kit.remoteAccess.port': 4317,
    [validKey]: '1',
  }));
  for (const key of invalidKeys) await expect(cache.set(key, 'anything')).rejects.toThrow('Invalid UI preference');
  expect(cache.snapshot()).toEqual({
    'pi-kit.workbench-ref.v1': '{"instanceId":"local-instance"}',
    [validKey]: '1',
  });
  await expect(cache.set(123, 'anything')).rejects.toThrow('Invalid UI preference');
  await expect(cache.set('pi-kit.theme', null)).rejects.toThrow('Invalid UI preference');
  await expect(cache.set('pi-kit.theme', 'x'.repeat(512 * 1024 + 1))).rejects.toThrow('Invalid UI preference');
});
