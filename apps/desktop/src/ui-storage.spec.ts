import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { UiStorage } from './ui-storage';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((file) => rm(file, { recursive: true, force: true }))); });

it('migrates UI preferences once, excludes credentials, and preserves ordered writes across a restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-kit-ui-cache-')); folders.push(folder);
  const file = join(folder, 'ui-storage.json');
  const cache = new UiStorage(file);
  const migrate = vi.fn(async () => ({ 'pi-kit.theme': 'pi-light', 'pi-kit.pinned-chips': '["skill"]', 'pk.graph.fold.t1': '0', 'pi-kit.token': 'not-a-real-token' }));
  await cache.load(migrate);
  expect(cache.snapshot()).toEqual({ 'pi-kit.theme': 'pi-light', 'pi-kit.pinned-chips': '["skill"]', 'pk.graph.fold.t1': '0' });
  await Promise.all([cache.set('pi-kit.theme', 'pi-dark'), cache.set('pi-kit.theme', 'pi-light')]);
  await cache.flush();
  expect(JSON.parse(await readFile(file, 'utf8'))['pi-kit.theme']).toBe('pi-light');
  const reopened = new UiStorage(file); await reopened.load(migrate);
  expect(reopened.snapshot()).toEqual(cache.snapshot());
  expect(migrate).toHaveBeenCalledTimes(1);
  await expect(cache.set('pi-kit.token', 'anything')).rejects.toThrow('Invalid UI preference');
});
