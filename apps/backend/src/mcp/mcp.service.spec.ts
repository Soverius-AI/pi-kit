import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiSessionService } from '../pi/pi-session.service';
import type { ThreadsService } from '../threads/threads.service';
import { McpService } from './mcp.service';

const pi = vi.hoisted(() => ({
  tokens: new Map<string, unknown>(),
  signIn: vi.fn(),
  openBrowser: vi.fn(),
}));

vi.mock('../pi/load-pi', () => ({
  loadPiInternals: async () => ({
    oauth: {
      McpOAuthCredentialStore: class {
        tokens(name: string, url: string) {
          return pi.tokens.get(`${name}|${url}`);
        }
        forServer(name: string, url: string) {
          return { name, url };
        }
      },
      signInMcpServer: pi.signIn,
    },
    config: { resolveConfigValueOrThrow: (value: string) => value },
    openBrowser: pi.openBrowser,
  }),
}));

describe('McpService without a thread', () => {
  let agentDir: string;
  let mcp: McpService;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pk-mcp-'));
    writeFileSync(
      join(agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          linear: { url: 'https://mcp.linear.app/mcp' },
          composio: { url: 'https://connect.composio.dev/mcp' },
          local: { command: 'node', args: ['server.js'] },
        },
      }),
    );
    pi.tokens.clear();
    pi.signIn.mockReset();
    pi.openBrowser.mockReset();
    vi.stubEnv('PI_KIT_NO_BROWSER', '');
    mcp = new McpService({ agentDir: async () => agentDir } as unknown as PiSessionService, {} as ThreadsService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('says which OAuth servers pi holds a sign-in for', async () => {
    pi.tokens.set('linear|https://mcp.linear.app/mcp', { access_token: 'x' });
    const { servers } = await mcp.overview();
    const byName = new Map(servers.map((server) => [server.name, server]));
    expect(byName.get('linear')?.signedIn).toBe(true);
    expect(byName.get('composio')?.signedIn).toBeUndefined();
    expect(byName.get('local')?.signedIn).toBeUndefined();
  });

  it('signs in on its own: opens the page, shows it while it waits, and forgets it once pi stored the tokens', async () => {
    let finish: () => void = () => undefined;
    pi.signIn.mockImplementation(
      (options: { prompt: { showAuthorizationUrl(url: URL): void } }) =>
        new Promise<void>((resolve) => {
          options.prompt.showAuthorizationUrl(new URL('https://connect.composio.dev/oauth/authorize?x=1'));
          finish = resolve;
        }),
    );
    const started = await mcp.login(undefined, 'composio');
    expect(started.url).toBe('https://connect.composio.dev/oauth/authorize?x=1');
    expect(pi.openBrowser).toHaveBeenCalledWith('https://connect.composio.dev/oauth/authorize?x=1');
    expect(pi.signIn.mock.calls[0]?.[0]).toMatchObject({ serverUrl: 'https://connect.composio.dev/mcp' });
    expect(started.overview.servers.find((s) => s.name === 'composio')?.signIn?.phase).toBe('waiting');

    pi.tokens.set('composio|https://connect.composio.dev/mcp', { access_token: 'x' });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = (await mcp.overview()).servers.find((s) => s.name === 'composio');
    expect(after?.signIn).toBeUndefined();
    expect(after?.signedIn).toBe(true);
  });

  it('gives up a waiting sign-in when the person cancels', async () => {
    pi.signIn.mockImplementation(
      (options: { prompt: { showAuthorizationUrl(url: URL): void }; signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          options.prompt.showAuthorizationUrl(new URL('https://mcp.linear.app/authorize'));
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    await mcp.login(undefined, 'linear');
    const { overview } = await mcp.cancelSignIn(undefined, 'linear');
    expect(overview.servers.find((s) => s.name === 'linear')?.signIn).toMatchObject({
      phase: 'cancelled',
      message: 'Sign-in cancelled.',
    });
  });

  it('refuses a server that does not sign in with OAuth', async () => {
    await expect(mcp.login(undefined, 'local')).rejects.toThrow('does not sign in with OAuth');
  });
});
