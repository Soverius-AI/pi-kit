import { protocol, net } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://pi-kit`;

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * Serves the static Angular build from `root` on app://pi-kit/ with an SPA fallback and a strict
 * CSP that only lets the page talk to its own origin and to the backend.
 */
export function serveRenderer(root: string, backendUrl: string): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${backendUrl}`,
    // MCP Apps: only the backend's sandbox proxy may be framed, never a page the app does not serve.
    `frame-src ${backendUrl}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    // A one-time legacy preference migration runs in a separate hidden renderer, before the chat window exists.
    if (pathname === '/__ui-storage') return new Response('<!doctype html><meta charset="utf-8"><title>UI storage migration</title>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', csp);
    return new Response(res.body, { status: res.status, headers });
  });
}
