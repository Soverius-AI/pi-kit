import {
  connectorsCatalog,
  connectorsConnect,
  connectorsDisconnect,
  connectorsExposure,
  mcpCheck,
  mcpOpenFile,
  mcpRevealFile,
} from '@pi-kit/api';
import { TestBed } from '@angular/core/testing';
import {
  mcpCancelSignIn,
  mcpEnabled,
  mcpLogin,
  mcpLogout,
  mcpOverview,
  mcpPasteSignIn,
  mcpReconnect,
  mcpReload,
  provideMockApi,
  settingsDecide,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import { CONNECTOR_CATALOG, type McpActionResult, type McpOverview } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { ConnectorsStore } from './connectors.store';

const server = (name: string, state: string, enabled = true) => ({
  name,
  state,
  enabled,
  transport: 'stdio',
  tools: 0,
});
const overview = (...servers: ReturnType<typeof server>[]): McpOverview =>
  ({ servers, errors: [], userConfig: '~/.pi/agent/mcp.json' }) as unknown as McpOverview;

describe('ConnectorsStore', () => {
  let current: McpOverview;
  /** An action of the API: answers with the overview as it is now. */
  const action = () =>
    vi.fn(async (...args: unknown[]): Promise<McpActionResult> => {
      void args;
      return { overview: current } as McpActionResult;
    });
  const api = {
    overview: vi.fn(async (thread: string | undefined) => {
      void thread;
      return current;
    }),
    reload: action(),
    setEnabled: action(),
    reconnect: action(),
    login: action(),
    logout: action(),
    cancelSignIn: action(),
    pasteSignIn: action(),
  };
  let threads: ReturnType<typeof fakeThreads>;

  const make = async () => {
    const store = TestBed.inject(ConnectorsStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    current = overview(server('docs', 'connected'), server('linear', 'needs-auth'), server('off', 'disabled', false));
    api.overview.mockClear();
    for (const call of [
      api.reload,
      api.setEnabled,
      api.reconnect,
      api.login,
      api.logout,
      api.cancelSignIn,
      api.pasteSignIn,
    ])
      call.mockClear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        ...provideMockApi([
          [mcpOverview, api.overview, (o) => [o.query?.['thread']]],
          [mcpReload, api.reload, (o) => [o.query?.['thread']]],
          [mcpEnabled, api.setEnabled, (o) => [o.query?.['thread'], o.path?.['name'], o.body?.['enabled']]],
          [mcpReconnect, api.reconnect, (o) => [o.query?.['thread'], o.path?.['name']]],
          [mcpLogin, api.login, (o) => [o.query?.['thread'], o.path?.['name']]],
          [mcpLogout, api.logout, (o) => [o.query?.['thread'], o.path?.['name']]],
          [mcpCancelSignIn, api.cancelSignIn, (o) => [o.query?.['thread'], o.path?.['name']]],
          [mcpPasteSignIn, api.pasteSignIn, (o) => [o.query?.['thread'], o.path?.['name'], o.body?.['url']]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('reads the overview of the selected thread and summarises it for the sidebar', async () => {
    const mcp = await make();
    expect(api.overview).toHaveBeenCalledWith('t1');
    expect(mcp.servers()).toHaveLength(3);
    expect(mcp.enabledCount()).toBe(2);
    expect(mcp.label()).toBe('2 MCP servers');
    expect(mcp.needsAttention()).toBe(true);
    expect(mcp.loading()).toBe(false);
  });

  it('labels the empty and the all-off cases', async () => {
    current = overview();
    const mcp = await make();
    expect(mcp.label()).toBe('No MCP servers');
    current = overview(server('a', 'disabled', false));
    await mcp.refresh();
    expect(mcp.label()).toBe('MCP servers off');
  });

  it('asks again every two seconds while a server connects, and stops after it has', async () => {
    current = overview(server('slow', 'connecting'));
    await make();
    expect(api.overview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.overview).toHaveBeenCalledTimes(2);
    current = overview(server('slow', 'connected'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.overview).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.overview).toHaveBeenCalledTimes(3);
  });

  it.each(['connecting', 'signing-in'])('keeps observing a slow %s operation until it settles', async (phase) => {
    current = overview(server('slow', phase === 'connecting' ? 'connecting' : 'needs-auth'));
    const mcp = await make();
    if (phase === 'signing-in') {
      api.login.mockResolvedValueOnce({ overview: current, url: 'https://example.com/auth' });
      await mcp.login('slow');
    }
    // Both former count limits (40 connection polls / 160 sign-in polls) have elapsed.
    await vi.advanceTimersByTimeAsync(162 * 2000);
    current = overview(server('slow', 'connected'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mcp.servers()[0]?.state).toBe('connected');
    const calls = api.overview.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.overview).toHaveBeenCalledTimes(calls);
  });

  it('stops observing when sign-in is cancelled or the store is destroyed', async () => {
    current = overview(server('slow', 'needs-auth'));
    const mcp = await make();
    api.login.mockResolvedValueOnce({ overview: current, url: 'https://example.com/auth' });
    await mcp.login('slow');
    api.cancelSignIn.mockResolvedValueOnce({ overview: current });
    await mcp.cancelSignIn('slow');
    let calls = api.overview.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.overview).toHaveBeenCalledTimes(calls);
    current = overview(server('slow', 'connecting'));
    await mcp.refresh();
    calls = api.overview.mock.calls.length;
    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.overview).toHaveBeenCalledTimes(calls);
  });

  it('an action needs a thread', async () => {
    threads.open(undefined);
    const mcp = await make();
    await mcp.reload();
    expect(mcp.notice()).toMatchObject({ level: 'error' });
    expect(api.reload).not.toHaveBeenCalled();
  });

  it("an action marks the server busy, takes the new overview and shows the backend's message and sign-in link", async () => {
    const mcp = await make();
    api.login.mockImplementationOnce(async () => ({
      overview: overview(server('linear', 'needs-auth')),
      message: 'Opened your browser',
      url: 'https://example.com/auth',
    }));
    const pending = mcp.login('linear');
    expect(mcp.busy().has('linear')).toBe(true);
    await pending;
    expect(api.login).toHaveBeenCalledWith('t1', 'linear');
    expect(mcp.busy().size).toBe(0);
    expect(mcp.notice()).toEqual({
      level: 'info',
      text: 'Opened your browser',
      url: 'https://example.com/auth',
      server: 'linear',
    });
    expect(mcp.servers()).toHaveLength(1);
    // The sign-in keeps the poll going until the server has connected.
    const before = api.overview.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.overview.mock.calls.length).toBe(before + 1);
  });

  it('enable and disable send the flag; a failed action is the notice and refreshes', async () => {
    const mcp = await make();
    await mcp.setEnabled('docs', false);
    expect(api.setEnabled).toHaveBeenCalledWith('t1', 'docs', false);
    api.reconnect.mockRejectedValueOnce(new Error('bad config'));
    await mcp.reconnect('docs');
    expect(mcp.notice()).toEqual({ level: 'error', text: 'bad config', server: 'docs' });
  });

  describe('the gallery', () => {
    const linearServer = (state = 'connected', extra: Record<string, unknown> = {}) => ({
      ...server('linear', state),
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      exposure: 'direct',
      oauth: true,
      ...extra,
    });
    const workspaceApi = { decideTrust: vi.fn(async () => ({}) as never) };
    const withTrust = (trusted: boolean) => ({ ...current, projectTrusted: trusted }) as McpOverview;

    beforeEach(() => {
      current = overview();
      workspaceApi.decideTrust.mockClear();
      Object.assign(api, {
        catalog: vi.fn(async () => CONNECTOR_CATALOG),
        connect: vi.fn(async (_thread: string | undefined, _request: unknown): Promise<McpActionResult> => ({
          overview: current,
          message: 'Added linear.',
        })),
        disconnect: vi.fn(async (_thread: string | undefined, _name: string): Promise<McpActionResult> => ({
          overview: current,
        })),
        setExposure: vi.fn(async (_thread: string, _name: string, _exposure: string): Promise<McpActionResult> => ({
          overview: current,
        })),
        check: vi.fn(),
        openFile: vi.fn(),
        revealFile: vi.fn(),
      });
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: ThreadsStore, useValue: threads },
          ...provideMockApi([
            [connectorsCatalog, gallery.catalog, () => []],
            [connectorsConnect, gallery.connect, (o) => [o.query?.['thread'], o.body]],
            [connectorsDisconnect, gallery.disconnect, (o) => [o.query?.['thread'], o.path?.['name']]],
            [
              connectorsExposure,
              gallery.setExposure,
              (o) => [o.query?.['thread'], o.path?.['name'], o.body?.['exposure']],
            ],
            [mcpCheck, gallery.check, (o) => [o.body]],
            [mcpOpenFile, gallery.openFile, (o) => [o.query?.['thread'], o.body?.['scope']]],
            [mcpRevealFile, gallery.revealFile, (o) => [o.query?.['thread'], o.body?.['scope']]],
            [mcpOverview, api.overview, (o) => [o.query?.['thread']]],
            [mcpReload, api.reload, (o) => [o.query?.['thread']]],
            [mcpEnabled, api.setEnabled, (o) => [o.query?.['thread'], o.path?.['name'], o.body?.['enabled']]],
            [mcpReconnect, api.reconnect, (o) => [o.query?.['thread'], o.path?.['name']]],
            [mcpLogin, api.login, (o) => [o.query?.['thread'], o.path?.['name']]],
            [mcpLogout, api.logout, (o) => [o.query?.['thread'], o.path?.['name']]],
            [mcpCancelSignIn, api.cancelSignIn, (o) => [o.query?.['thread'], o.path?.['name']]],
            [mcpPasteSignIn, api.pasteSignIn, (o) => [o.query?.['thread'], o.path?.['name'], o.body?.['url']]],
            [settingsDecide, workspaceApi.decideTrust, (o) => [o.path?.['id'], o.body?.['decision']]],
          ]),
        ],
      });
    });
    const gallery = api as unknown as Record<
      'catalog' | 'connect' | 'disconnect' | 'setExposure' | 'check' | 'openFile' | 'revealFile',
      ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>
    >;

    it('asks the backend for the catalog once and makes one card per entry', async () => {
      const mcp = await make();
      expect(gallery.catalog).toHaveBeenCalledTimes(1);
      expect(mcp.cards().map((c) => c.connector.id)).toContain('linear');
      expect(mcp.cards().every((c) => c.state === 'available')).toBe(true);
      await mcp.loadCatalog();
      expect(gallery.catalog).toHaveBeenCalledTimes(1);
    });

    it('Connect on an OAuth connector sends the card’s choices to the backend and keeps the sign-in link under the card', async () => {
      const mcp = await make();
      mcp.choose('linear', { variant: 'readonly', exposure: 'deferred' });
      gallery.connect.mockResolvedValueOnce({
        overview: overview(
          linearServer('needs-auth', { signIn: { phase: 'waiting', url: 'https://auth.example/a' } }) as never,
        ),
        message: 'Sign in to MCP server "linear" in your browser.',
        url: 'https://auth.example/a',
      });
      await mcp.connect('linear');
      expect(gallery.connect).toHaveBeenCalledWith('t1', {
        id: 'linear',
        scope: 'user',
        variant: 'readonly',
        exposure: 'deferred',
      });
      expect(mcp.notice()).toMatchObject({ level: 'info', url: 'https://auth.example/a', server: 'linear' });
      expect(mcp.cards().find((c) => c.connector.id === 'linear')?.state).toBe('signing-in');
      // the sign-in keeps the poll going until the server is connected
      const before = api.overview.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.overview.mock.calls.length).toBe(before + 1);
    });

    it('a connector that needs a typed token opens the wizard on its details and sends nothing until the wizard gives one', async () => {
      const mcp = await make();
      expect(await mcp.connect('github')).toBe(false);
      expect(mcp.wizard()).toEqual({ id: 'github' });
      expect(gallery.connect).not.toHaveBeenCalled();
      await mcp.connect('github', { token: 'ghp_x' });
      expect(gallery.connect).toHaveBeenCalledWith('t1', { id: 'github', scope: 'user', token: 'ghp_x' });
      expect(mcp.wizard()).toBeUndefined();
    });

    it('the "+" opens the wizard on the gallery, and closing it forgets it', async () => {
      const mcp = await make();
      mcp.openWizard();
      expect(mcp.wizard()).toEqual({});
      mcp.closeWizard();
      expect(mcp.wizard()).toBeUndefined();
    });

    it('a wizard that fails stays open and shows the backend’s words', async () => {
      const mcp = await make();
      mcp.openWizard('github');
      gallery.connect.mockRejectedValueOnce(new Error('token: paste the GitHub token.'));
      await mcp.connect('github', { token: 'x' });
      expect(mcp.wizard()).toEqual({ id: 'github' });
      expect(mcp.notice()).toMatchObject({ level: 'error', text: 'token: paste the GitHub token.' });
    });

    it('lists every server as a row, catalog ones with their name, and counts the servers that are on', async () => {
      const placed = (name: string, state: string, enabled = true) => ({
        ...server(name, state, enabled),
        scope: 'global',
        source: '/u/.pi/agent/mcp.json',
        target: 'node server.js',
      });
      current = overview(
        { ...linearServer('connected'), scope: 'global', source: '/u/.pi/agent/mcp.json' } as never,
        placed('mine', 'connected'),
        placed('off', 'disabled', false),
      );
      const mcp = await make();
      expect(mcp.rows().map((r) => [r.name, r.connector?.id, r.chip.text])).toEqual([
        ['linear', 'linear', 'connected'],
        ['mine', undefined, 'connected'],
        ['off', undefined, 'off'],
      ]);
      expect(mcp.onCount()).toBe(2);
    });

    it('checks a server through the backend, and a failed check is an answer, not an error', async () => {
      const mcp = await make();
      gallery.check.mockResolvedValueOnce({ ok: true, status: 'reachable', message: 'Answered in 12 ms.' });
      expect(await mcp.check({ url: 'https://x.example/mcp' })).toMatchObject({ ok: true });
      expect(gallery.check).toHaveBeenCalledWith({ url: 'https://x.example/mcp' });
      gallery.check.mockRejectedValueOnce(new Error('the backend is away'));
      expect(await mcp.check({ command: 'npx' })).toEqual({
        ok: false,
        status: 'unreachable',
        message: 'the backend is away',
      });
    });

    it('opens and shows an mcp.json through the desktop, and says in a toast when it cannot', async () => {
      const mcp = await make();
      const toasts = TestBed.inject(ToastStore);
      gallery.openFile.mockResolvedValueOnce({ opened: true });
      await mcp.openFile('user', 'open');
      expect(gallery.openFile).toHaveBeenCalledWith('t1', 'user');
      expect(toasts.items()).toHaveLength(0);
      gallery.revealFile.mockResolvedValueOnce({
        opened: false,
        reason: 'Revealing a file in the file manager needs the desktop app.',
      });
      await mcp.openFile('project', 'reveal');
      expect(gallery.revealFile).toHaveBeenCalledWith('t1', 'project');
      expect(toasts.items()[0]).toMatchObject({
        level: 'info',
        text: 'Revealing a file in the file manager needs the desktop app.',
      });
    });

    it('a custom server goes through the wizard’s own request', async () => {
      const mcp = await make();
      await mcp.connectCustom({ name: 'docs', url: 'https://example.com/mcp' }, 'tok');
      expect(gallery.connect).toHaveBeenCalledWith('t1', {
        id: 'custom',
        scope: 'user',
        custom: { name: 'docs', url: 'https://example.com/mcp' },
        token: 'tok',
      });
    });

    it('project only in a folder that is not trusted offers the trust and writes nothing; after the trust the connect goes through', async () => {
      current = withTrust(false);
      const mcp = await make();
      mcp.choose('linear', { scope: 'project' });
      expect(await mcp.connect('linear')).toBe(false);
      expect(gallery.connect).not.toHaveBeenCalled();
      expect(mcp.notice()).toMatchObject({ level: 'error', trust: true, server: 'linear' });
      current = withTrust(true);
      await mcp.trustFolder('linear');
      expect(workspaceApi.decideTrust).toHaveBeenCalledWith('/a', 'remember');
      expect(gallery.connect).toHaveBeenCalledWith('t1', { id: 'linear', scope: 'project' });
    });

    it('a user-level connector can be added with no thread open; the thread is the backend’s to ask for', async () => {
      threads.open(undefined);
      const mcp = await make();
      await mcp.connect('linear');
      expect(gallery.connect).toHaveBeenCalledWith(undefined, { id: 'linear', scope: 'user' });
      expect(mcp.notice()?.level).toBe('info');
    });

    it('disconnect and exposure go to the backend; exposure needs a thread', async () => {
      current = overview(linearServer() as never);
      const mcp = await make();
      await mcp.disconnect('linear');
      expect(gallery.disconnect).toHaveBeenCalledWith('t1', 'linear');
      await mcp.setExposure('linear', 'deferred');
      expect(gallery.setExposure).toHaveBeenCalledWith('t1', 'linear', 'deferred');
      threads.open(undefined);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(await mcp.setExposure('linear', 'direct')).toBe(false);
      expect(mcp.notice()?.level).toBe('error');
    });

    it('sign-in actions of the card use the server’s name', async () => {
      current = overview(linearServer('needs-auth') as never);
      const mcp = await make();
      await mcp.cancelSignIn('linear');
      expect(api.cancelSignIn).toHaveBeenCalledWith('t1', 'linear');
      await mcp.pasteSignIn('linear', 'http://127.0.0.1:1/callback?code=x');
      expect(api.pasteSignIn).toHaveBeenCalledWith('t1', 'linear', 'http://127.0.0.1:1/callback?code=x');
    });

    it('feeds the / menu with connected direct connectors and counts the connected ones for Settings', async () => {
      current = overview(
        linearServer('connected', { toolList: [{ name: 'create_issue' }, { name: 'search_issues' }] }) as never,
        { ...server('docs', 'connected'), exposure: 'codemode' } as never,
      );
      const mcp = await make();
      expect(mcp.menuGroups().map((g) => g.line)).toEqual(['Linear: create issue, search issues']);
      expect(mcp.connectedCount()).toBe(1);
      expect(mcp.ownServers().map((s) => s.name)).toEqual(['docs']);
    });
  });

  it('starts over when another thread opens', async () => {
    const mcp = await make();
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.overview).toHaveBeenLastCalledWith('t2');
    expect(mcp.threadId()).toBe('t2');
  });

  it.each(['success', 'failure'])(
    'ignores an old action %s after leaving and reopening its thread',
    async (outcome) => {
      const mcp = await make();
      let resolve!: (result: McpActionResult) => void;
      let reject!: (error: Error) => void;
      api.reconnect.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          }),
      );
      const old = mcp.reconnect('docs');
      threads.open(thread('t2'));
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      current = overview(server('current', 'connected'));
      threads.open(thread('t1'));
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      let finish!: (result: McpActionResult) => void;
      api.reconnect.mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      );
      const active = mcp.reconnect('docs');
      try {
        if (outcome === 'success') resolve({ overview: overview(server('old', 'connecting')), message: 'Old result' });
        else reject(new Error('Old failure'));
        const accepted = await old;
        expect(mcp.servers().map((entry) => entry.name)).toEqual(['current']);
        expect(mcp.notice()).toBeUndefined();
        expect(mcp.busy().has('docs')).toBe(true);
        expect(accepted).toBe(false);
      } finally {
        finish({ overview: current });
        await active;
      }
    },
  );
});
