// A mock MCP server with a mock OAuth authorization server in front of it, for the connector tests and screenshots. Nothing leaves this machine.
//
//   /mcp           Streamable HTTP MCP, protected by OAuth: no valid token gets a 401 with the resource-metadata challenge pi follows
//   /readonly/mcp  the same server with a different path (the Linear-style read-only variant)
//   /bearer/mcp    the same tools behind a fixed bearer token (`BEARER_TOKEN`), for the token path with no OAuth at all
//   /.well-known/* /register /authorize /token   protected resource metadata, authorization server metadata (with `iss`), dynamic client registration, the authorization page, the token endpoint (PKCE S256, refresh)
//
// The tools are the example server's (examples/mcp-app-server/server.mjs, an issue tracker with an MCP App form): each path bridges to a stdio child of that server, so the card lists
// real tools and an MCP App. `mode` decides what the authorization page does when the "browser" (the test) opens it: `approve`, `deny` (error=access_denied), `hold` (never answers).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { root } from './env.mjs';

export const BEARER_TOKEN = 'mock-bearer-token-0123456789';

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

/** A stdio MCP server as a function from a JSON-RPC message to its answer. */
function bridge() {
  const child = spawn('node', [join(root, 'examples', 'mcp-app-server', 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    } catch {
      // not JSON
    }
  });
  let counter = 0;
  return {
    call(message) {
      if (message.id === undefined) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return Promise.resolve(undefined);
      }
      // Ids are the client's; two clients may reuse one, so the child sees ours.
      const id = ++counter;
      return new Promise((resolve) => {
        waiting.set(id, (answer) => resolve({ ...answer, id: message.id }));
        child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      });
    },
    close: () => child.kill(),
  };
}

/**
 * Starts the mock on `port` (0 for a free one). Returns `{ url, port, close, mode, tokens, authorizations, registrations, revoke(), expire() }`:
 *  - `mode`: what `/authorize` does (set it before the "browser" opens the URL),
 *  - `expiresIn`: seconds an access token lives (a short one makes pi refresh),
 *  - `revoke()`: forgets every token (the next call gets a 401, as after a sign-out at the vendor),
 *  - `authorizations`, `registrations`, `refreshes`: what pi did, for assertions.
 */
export async function startMockOAuthMcp({ port = 0, expiresIn = 3600 } = {}) {
  const state = {
    mode: 'approve',
    expiresIn,
    codes: new Map(),
    clients: new Map(),
    access: new Map(),
    refresh: new Map(),
    authorizations: [],
    registrations: [],
    refreshes: 0,
    tokenRequests: [],
    mcpCalls: [],
  };
  const children = { oauth: bridge(), bearer: bridge() };
  let base = '';

  const issue = (clientId) => {
    const access = `at-${randomBytes(8).toString('hex')}`;
    const refresh = `rt-${randomBytes(8).toString('hex')}`;
    state.access.set(access, { clientId, expires: Date.now() + state.expiresIn * 1000 });
    state.refresh.set(refresh, { clientId });
    return { access_token: access, token_type: 'Bearer', expires_in: state.expiresIn, refresh_token: refresh, scope: 'read write' };
  };

  const authorized = (req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const found = state.access.get(token);
    return !!found && found.expires > Date.now();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        const resource = `${base}${path.slice('/.well-known/oauth-protected-resource'.length) || '/mcp'}`;
        return json(res, 200, { resource, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'Mock issues' });
      }
      if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ['read', 'write'],
        });
      }
      if (path === '/register' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const client = { client_id: `client-${randomBytes(6).toString('hex')}`, client_id_issued_at: Math.floor(Date.now() / 1000), ...body, token_endpoint_auth_method: 'none' };
        state.clients.set(client.client_id, client);
        state.registrations.push({ client_name: body.client_name, redirect_uris: body.redirect_uris });
        return json(res, 201, client);
      }
      if (path === '/authorize') {
        const query = Object.fromEntries(url.searchParams);
        state.authorizations.push(query);
        const client = state.clients.get(query.client_id);
        if (!client || !(client.redirect_uris ?? []).includes(query.redirect_uri)) return json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
        if (state.mode === 'hold') return; // the browser tab that never comes back
        const target = new URL(query.redirect_uri);
        target.searchParams.set('state', query.state ?? '');
        target.searchParams.set('iss', base);
        if (state.mode === 'deny') {
          target.searchParams.set('error', 'access_denied');
          target.searchParams.set('error_description', 'The user denied the request');
        } else {
          const code = `code-${randomBytes(8).toString('hex')}`;
          state.codes.set(code, { clientId: query.client_id, challenge: query.code_challenge, redirect: query.redirect_uri });
          target.searchParams.set('code', code);
        }
        res.writeHead(302, { Location: target.href });
        return res.end();
      }
      if (path === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        state.tokenRequests.push(Object.fromEntries(form));
        if (form.get('grant_type') === 'authorization_code') {
          const entry = state.codes.get(form.get('code') ?? '');
          state.codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!entry || entry.challenge !== challenge || entry.clientId !== form.get('client_id')) return json(res, 400, { error: 'invalid_grant', error_description: 'the code or its verifier did not match' });
          return json(res, 200, issue(entry.clientId));
        }
        if (form.get('grant_type') === 'refresh_token') {
          const entry = state.refresh.get(form.get('refresh_token') ?? '');
          if (!entry) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
          state.refreshes += 1;
          return json(res, 200, issue(entry.clientId));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (path === '/mcp' || path === '/readonly/mcp' || path === '/bearer/mcp') {
        const isBearer = path === '/bearer/mcp';
        const ok = isBearer ? req.headers.authorization === `Bearer ${BEARER_TOKEN}` : authorized(req);
        if (!ok) {
          state.mcpCalls.push({ path, status: 401 });
          return json(res, 401, { error: 'unauthorized' }, isBearer ? { 'WWW-Authenticate': 'Bearer' } : { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${path}"` });
        }
        if (req.method === 'DELETE') {
          res.writeHead(200);
          return res.end();
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST, DELETE' });
          return res.end();
        }
        const message = JSON.parse((await readBody(req)) || '{}');
        state.mcpCalls.push({ path, status: 200, method: message.method });
        const answer = await (isBearer ? children.bearer : children.oauth).call(message);
        if (!answer) {
          res.writeHead(202);
          return res.end();
        }
        return json(res, 200, answer);
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  base = `http://127.0.0.1:${actual}`;
  return {
    port: actual,
    url: base,
    state,
    get mode() {
      return state.mode;
    },
    set mode(value) {
      state.mode = value;
    },
    set expiresIn(value) {
      state.expiresIn = value;
    },
    get authorizations() {
      return state.authorizations;
    },
    get registrations() {
      return state.registrations;
    },
    get refreshes() {
      return state.refreshes;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    get mcpCalls() {
      return state.mcpCalls;
    },
    /** Every token stops working at once (and the refresh tokens too), as after the person revoked the app at the vendor. */
    revoke() {
      state.access.clear();
      state.refresh.clear();
    },
    /** Access tokens expire now; refresh tokens still work. */
    expire() {
      for (const entry of state.access.values()) entry.expires = 0;
    },
    async close() {
      children.oauth.close();
      children.bearer.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * The browser: opens an authorization URL the way a person's browser would (follows the redirect to pi's loopback callback) and returns how the callback answered.
 * `deny` and `hold` are the mock's `mode`, set before this is called.
 */
export async function openAuthorizationUrl(url) {
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (!location) return { status: authorize.status, redirected: false };
  const callback = await fetch(location);
  return { status: callback.status, redirected: true, location, page: await callback.text() };
}
