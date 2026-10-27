import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelStore, WHISTLE, whistleSpec } from './model-store';

describe('ModelStore (the consented, pinned download of Whistle)', () => {
  let dir: string;
  let fixture: string;
  const content = Buffer.from('a stand-in for the 17 MB model'.repeat(40));
  const sha = createHash('sha256').update(content).digest('hex');
  const spec = (over: Partial<ReturnType<typeof whistleSpec>> = {}) => ({ ...WHISTLE, url: pathToFileURL(fixture).href, bytes: content.length, sha256: sha, ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-kit-model-'));
    fixture = join(dir, 'fixture.cact');
    writeFileSync(fixture, content);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is missing until someone asks: creating the store and reading its status writes nothing', () => {
    const store = new ModelStore(join(dir, 'data'), spec());
    expect(store.status()).toMatchObject({ state: 'missing', file: 'whistle.cact', name: 'Whistle', license: 'Apache-2.0', bytes: content.length, sha256: sha });
    expect(store.present).toBe(false);
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });

  it('downloads into the data folder, checks size and SHA-256, and reports ready', async () => {
    const store = new ModelStore(join(dir, 'data'), spec());
    const done = store.download();
    expect(store.status().state).toBe('downloading');
    await done;
    expect(store.status()).toMatchObject({ state: 'ready', path: join(dir, 'data', 'models', 'whistle', 'whistle.cact') });
    expect(statSync(store.path).size).toBe(content.length);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'data', 'models', 'whistle'))).toEqual(['whistle.cact']);
    expect(await store.verify()).toBe(true);
  });

  it('joins a second request made during the download instead of starting another', async () => {
    const store = new ModelStore(join(dir, 'data'), spec());
    const first = store.download();
    expect(store.download()).toBe(first);
    await first;
  });

  it('throws a download away when the hash is not the pinned one', async () => {
    const store = new ModelStore(join(dir, 'data'), spec({ sha256: '0'.repeat(64) }));
    await expect(store.download()).rejects.toThrow(/does not match the pinned size and SHA-256/);
    expect(store.present).toBe(false);
    expect(store.status()).toMatchObject({ state: 'error', error: expect.stringContaining('discarded') });
    expect(existsSync(`${store.path}.part`)).toBe(false);
  });

  it('refuses a file larger or smaller than the pinned size', async () => {
    const big = new ModelStore(join(dir, 'a'), spec({ bytes: content.length - 5 }));
    await expect(big.download()).rejects.toThrow(/larger than the pinned/);
    expect(existsSync(`${big.path}.part`)).toBe(false);
    const small = new ModelStore(join(dir, 'b'), spec({ bytes: content.length + 5 }));
    await expect(small.download()).rejects.toThrow(/does not match/);
    expect(small.present).toBe(false);
  });

  it('says so when the source does not exist, and tries again on request', async () => {
    const store = new ModelStore(join(dir, 'data'), spec({ url: pathToFileURL(join(dir, 'nope.cact')).href }));
    await expect(store.download()).rejects.toThrow(/does not exist/);
    expect(store.status().state).toBe('error');
    const retry = new ModelStore(join(dir, 'data'), spec());
    await retry.download();
    expect(retry.status().state).toBe('ready');
  });

  it('notices a file of the right size that is not the model, and removal clears everything', async () => {
    const store = new ModelStore(join(dir, 'data'), spec());
    await store.download();
    writeFileSync(store.path, Buffer.alloc(content.length, 1));
    expect(store.present).toBe(true);
    expect(await store.verify()).toBe(false);
    store.fail('damaged');
    expect(store.status().state).toBe('ready');
    store.remove();
    expect(store.status().state).toBe('missing');
    expect(existsSync(store.path)).toBe(false);
  });

  it('pins the real file, and only a test environment may point elsewhere', () => {
    const real = whistleSpec({});
    expect(real.url).toBe('https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact');
    expect(real.bytes).toBe(16_919_407);
    expect(real.sha256).toBe('b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb');
    const test = whistleSpec({ PI_KIT_WHISTLE_URL: 'file:///x', PI_KIT_WHISTLE_SHA256: 'ab', PI_KIT_WHISTLE_BYTES: '12' });
    expect(test).toMatchObject({ url: 'file:///x', sha256: 'ab', bytes: 12 });
    expect(whistleSpec({ NODE_ENV: 'production', PI_KIT_WHISTLE_URL: 'file:///x' }).url).toBe(real.url);
  });
});
