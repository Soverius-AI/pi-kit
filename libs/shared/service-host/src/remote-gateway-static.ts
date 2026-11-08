import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { PairingPage } from './phone-pairing-page';
import { Http } from './remote-gateway-http';

/** The packaged renderer: its files for paired devices, the pairing page for everyone else. */
export class RendererFiles {
  private static readonly MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };

  constructor(private readonly rendererRoot: string) {}

  /** Fail before publishing a listener if packaging omitted or escaped the renderer. */
  async verify(): Promise<void> {
    const root = await realpath(this.rendererRoot);
    const index = await realpath(resolve(root, 'index.html'));
    if (!index.startsWith(root + sep) || !(await stat(index)).isFile()) throw new Error('Renderer unavailable');
  }

  /** A renderer file under the root; extensionless navigations fall back to the app shell, which only a paired device gets. */
  async serve(
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    authenticated: boolean,
    connection: 'device' | 'owner' = 'device',
  ): Promise<void> {
    const root = await realpath(this.rendererRoot);
    let file: string;
    let index = path === '/' || path === '/index.html';
    try {
      const candidate = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!candidate.startsWith(root + sep)) throw new Error();
      file = await realpath(candidate);
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
        return Http.json(res, 404, { error: 'Not found' });
    } catch {
      if (extname(path) || path.startsWith('/assets/') || path.split('/').some((part) => part.startsWith('.')))
        return Http.json(res, 404, { error: 'Not found' });
      file = await realpath(resolve(root, 'index.html'));
      if (!file.startsWith(root + sep)) return Http.json(res, 404, { error: 'Not found' });
      index = true;
    }
    if (index && !authenticated) return this.pairingPage(res, req.method === 'HEAD');
    const type = RendererFiles.MIME[extname(file)];
    if (!type || path.split('/').some((part) => part.startsWith('.')) || (extname(file) === '.html' && !index))
      return Http.json(res, 404, { error: 'Not found' });
    res.setHeader('Content-Type', type);
    if (index) {
      const html = (await readFile(file, 'utf8')).replace(
        /<head(?:\s[^>]*)?>/i,
        `$&<meta name="pi-kit-connection" content="${connection}">`,
      );
      res.end(req.method === 'HEAD' ? undefined : html);
    } else if (req.method === 'HEAD') res.end();
    else pipeline(createReadStream(file), res, () => undefined);
  }

  pairingPage(res: ServerResponse, head: boolean): void {
    const nonce = Http.secret();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'`,
    );
    res.end(head ? undefined : PairingPage.html(nonce));
  }
}
