import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PairingPage } from './phone-pairing-page';

const script = readFileSync(resolve(__dirname, '../../renderer/public/phone/pairing.js'), 'utf8');
const code = 'ABCDEFGHIJKL';
function element() {
  const listeners = new Map<string, (event: unknown) => unknown>();
  return {
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    srcObject: null,
    readyState: 2,
    videoWidth: 800,
    videoHeight: 600,
    width: 0,
    height: 0,
    addEventListener: (name: string, callback: (event: unknown) => unknown) => listeners.set(name, callback),
    fire: (name: string, event: unknown = {}) => Promise.resolve(listeners.get(name)?.(event)),
    setAttribute: vi.fn(),
    focus: vi.fn(),
    play: vi.fn(async () => undefined),
    getContext: () => ({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }),
    }),
  };
}
function fixture() {
  const nodes = Object.fromEntries(
    ['code', 'pair', 'status', 'scan', 'camera-panel', 'camera', 'frame', 'request', 'cancel-scan'].map((id) => [
      id,
      element(),
    ]),
  );
  const document = Object.assign(element(), { hidden: false, getElementById: (id: string) => nodes[id] });
  const window = element();
  const stop = vi.fn();
  const media = { getTracks: () => [{ stop }] };
  const getUserMedia = vi.fn<(constraints: unknown) => Promise<unknown>>().mockResolvedValue(media);
  const decode = vi.fn().mockReturnValue(null);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ confirmationCode: '123456' }) });
  const frames = new Map<number, (now: number) => void>();
  let next = 0;
  const history = { replaceState: vi.fn() };
  const context = {
    document,
    window,
    navigator: { mediaDevices: { getUserMedia } },
    URL,
    location: { origin: 'https://safe-node.tailnet.ts.net:8443', hash: '', replace: vi.fn() },
    history,
    jsQR: decode,
    fetch,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    requestAnimationFrame: (callback: (now: number) => void) => {
      frames.set(++next, callback);
      return next;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  runInNewContext(script, context);
  const detect = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((fn) => fn(200));
  };
  return { nodes, context, getUserMedia, media, stop, decode, detect, frames, fetch };
}

describe('on-device pairing camera', () => {
  it('requests no permission on load and keeps the manual form', () => {
    const f = fixture();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.context.history.replaceState).toHaveBeenCalledWith(null, '', '/phone');
    const html = PairingPage.html('test-nonce');
    expect(html).toContain('playsinline');
    expect(html).not.toContain('viewport-fit=cover');
    expect(html).toContain('safe-area-inset-bottom');
    expect(html).toContain('Camera images stay on this device');
    expect(html).toContain('nonce="test-nonce" src="/phone/jsQR.js"');
    expect(html).toContain('nonce="test-nonce" src="/phone/pairing.js"');
  });
  it('replaces an expired code when Safari reuses the same tab for a fresh QR fragment', async () => {
    const f = fixture();
    f.nodes['code'].value = 'EXPIREDVALUE';
    f.context.location.hash = '#' + code;
    await f.context.window.fire('hashchange');
    expect(f.nodes['code'].value).toBe(code);
    expect(f.context.history.replaceState).toHaveBeenLastCalledWith(null, '', '/phone');
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
  it.each([code, `https://safe-node.tailnet.ts.net:8443/phone#${code}`])(
    'scans only a local code and stops without requesting access automatically: %s',
    async (value) => {
      const f = fixture();
      f.decode.mockReturnValue({ data: value });
      await f.nodes['scan'].fire('click');
      expect(f.getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      });
      f.detect();
      expect(f.nodes['code'].value).toBe(code);
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.nodes['camera'].srcObject).toBeNull();
      expect(f.nodes['camera-panel'].hidden).toBe(true);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.frames.size).toBe(0);
    },
  );
  it.each([
    `https://evil.test/phone#${code}`,
    `https://safe-node.tailnet.ts.net:9443/phone#${code}`,
    `https://safe-node.tailnet.ts.net:8443/other#${code}`,
    'javascript:alert(1)',
  ])('never follows a foreign/malformed QR: %s', async (value) => {
    const f = fixture();
    f.decode.mockReturnValue({ data: value });
    await f.nodes['scan'].fire('click');
    f.detect();
    expect(f.nodes['code'].value).toBe('');
    expect(f.context.location.replace).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await f.nodes['cancel-scan'].fire('click');
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('stops a camera granted after the user already cancelled the permission request', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.getUserMedia.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const opening = f.nodes['scan'].fire('click');
    await f.nodes['cancel-scan'].fire('click');
    resolve(f.media);
    await opening;
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.nodes['camera-panel'].hidden).toBe(true);
    expect(f.decode).not.toHaveBeenCalled();
  });
  it('explains a denied permission without exposing the camera error', async () => {
    const f = fixture();
    f.getUserMedia.mockRejectedValue({ name: 'NotAllowedError', message: 'PRIVATE DEVICE INFORMATION' });
    await f.nodes['scan'].fire('click');
    expect(f.nodes['status'].textContent).toContain('Safari settings');
    expect(f.nodes['status'].textContent).not.toContain('PRIVATE');
    expect(f.nodes['request'].disabled).toBe(false);
  });
  it('stops tracks before submitting the explicit pairing request and on pagehide', async () => {
    const f = fixture();
    await f.nodes['scan'].fire('click');
    f.nodes['code'].value = code;
    await f.nodes['pair'].fire('submit', { preventDefault: vi.fn() });
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledWith('/phone/pair', expect.objectContaining({ body: JSON.stringify({ code }) }));
    expect(f.nodes['status'].textContent).toContain('123456');
    await f.context.window.fire('pagehide');
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.context.clearTimeout).toHaveBeenCalled();
  });
});
