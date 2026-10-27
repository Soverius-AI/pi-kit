import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { proxyEnvironment } from './proxy-env';

describe('the backend environment for a proxy', () => {
  it('does nothing without a proxy variable', () => {
    expect(proxyEnvironment({ PATH: '/usr/bin' })).toEqual({});
  });

  it('turns on Node’s proxy support and keeps the loopback addresses out of it, after what the user already excluded', () => {
    expect(proxyEnvironment({ HTTPS_PROXY: 'http://proxy.corp:3128' })).toEqual({ NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' });
    expect(proxyEnvironment({ http_proxy: 'http://proxy.corp:3128', NO_PROXY: '.corp.example' })).toMatchObject({ NODE_USE_ENV_PROXY: '1', NO_PROXY: '.corp.example,localhost,127.0.0.1,::1' });
  });

  it('makes a Node process send its HTTPS request to the proxy as a CONNECT, and a request to a loopback server straight to it', async () => {
    const connects: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, socket) => {
      connects.push(req.url ?? '');
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    const direct = createServer((_req, res) => res.end('direct'));
    await Promise.all([new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)), new Promise<void>((r) => direct.listen(0, '127.0.0.1', r))]);
    const proxyPort = (proxy.address() as AddressInfo).port;
    const directPort = (direct.address() as AddressInfo).port;
    try {
      const env = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` };
      const run = (code: string) =>
        new Promise<string>((resolve) => {
          const child = spawn(process.execPath, ['-e', code], { env: { ...env, ...proxyEnvironment(env) }, stdio: ['ignore', 'pipe', 'ignore'] });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('close', () => resolve(out.trim()));
        });
      await run(`fetch('https://registry.invalid/ping').then(() => console.log('answered'), () => console.log('failed'))`);
      expect(connects).toEqual(['registry.invalid:443']);
      expect(await run(`fetch('http://127.0.0.1:${directPort}/').then((r) => r.text()).then(console.log, () => console.log('failed'))`)).toBe('direct');
      expect(connects).toEqual(['registry.invalid:443']);
    } finally {
      proxy.close();
      direct.close();
    }
  });
});
