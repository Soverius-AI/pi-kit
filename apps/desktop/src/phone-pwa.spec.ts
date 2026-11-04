import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PairingPage } from './phone-pairing-page';

const publicRoot = resolve(__dirname, '../../renderer/public');
describe('installable phone metadata', () => {
  it('uses one standalone identity, no pairing secrets, and matching production icons', () => {
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      name: 'pi-kit',
      short_name: 'pi-kit',
      display: 'standalone',
    });
    expect(manifest).not.toHaveProperty('share_target');
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      ]),
    );
    for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
      const bytes = readFileSync(resolve(publicRoot, '.' + icon.src));
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
      expect(bytes[25]).toBe(2); // Opaque RGB, not transparent macOS padding.
    }
  });
  it('exposes the same manifest and Home Screen identity before and after pairing', () => {
    const index = readFileSync(resolve(__dirname, '../../renderer/src/index.html'), 'utf8');
    const pairing = PairingPage.html('test-nonce');
    for (const html of [index, pairing]) {
      expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
      expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png"');
      expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
      expect(html).toContain('name="apple-mobile-web-app-title" content="pi-kit"');
      expect(html).toContain('viewport-fit=cover');
    }
  });
});
