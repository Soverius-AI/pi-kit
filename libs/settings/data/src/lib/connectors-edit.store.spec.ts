import { TestBed } from '@angular/core/testing';
import {
  connectorsCatalog,
  mcpChange,
  mcpCreate,
  mcpDetail,
  mcpFile,
  mcpOverview,
  mcpSaveFile,
  provideMockApi,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import { CONNECTOR_CATALOG, type McpActionResult, type McpOverview, type McpServerBody } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { ConnectorsStore } from './connectors.store';

/** The edit form and the file editor, as the store drives them (the store's older behaviour is in connectors.store.spec.ts). */
const server = (name: string, state: string, enabled = true) => ({
  name,
  state,
  enabled,
  transport: 'stdio',
  tools: 0,
});
const overview = (...servers: ReturnType<typeof server>[]): McpOverview =>
  ({ servers, errors: [], userConfig: '~/.pi/agent/mcp.json' }) as unknown as McpOverview;

describe('ConnectorsStore: editing', () => {
  let current: McpOverview;
  let threads: ReturnType<typeof fakeThreads>;
  const body: McpServerBody = {
    name: 'docs',
    kind: 'url',
    url: 'https://docs.example/mcp',
    headers: [{ key: 'X-Team', value: 'core' }],
    exposure: 'codemode',
    description: '',
    enabled: true,
  };
  const api = {
    overview: vi.fn(async (_thread: string | undefined) => current),
    catalog: vi.fn(async () => CONNECTOR_CATALOG),
    serverDetail: vi.fn(async (_thread: string | undefined, _name: string, _scope: string) => ({
      name: 'docs',
      scope: 'user',
    })),
    createServer: vi.fn(async (_thread: string | undefined, _body: unknown): Promise<McpActionResult> => ({
      overview: current,
      message: 'Added docs.',
    })),
    updateServer: vi.fn(
      async (_thread: string | undefined, _name: string, _scope: string, _body: unknown): Promise<McpActionResult> => ({
        overview: current,
        message: 'Saved docs.',
      }),
    ),
    file: vi.fn(async (_thread: string | undefined, _scope: string) => ({
      scope: 'user',
      path: '/u/mcp.json',
      text: '{}',
      mtime: 5,
      exists: true,
    })),
    saveFile: vi.fn(async (_thread: string | undefined, _scope: string, put: { text: string; mtime: number }) => ({
      file: { scope: 'user', path: '/u/mcp.json', text: put.text, mtime: put.mtime + 1, exists: true },
      message: 'Saved.',
      overview: current,
    })),
  };

  const make = async () => {
    const store = TestBed.inject(ConnectorsStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    current = overview(server('docs', 'connected'));
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ToastStore, useValue: { show: vi.fn() } },
        ...provideMockApi([
          [mcpOverview, api.overview, (o) => [o.query?.['thread']]],
          [connectorsCatalog, api.catalog, () => []],
          [mcpDetail, api.serverDetail, (o) => [o.query?.['thread'], o.path?.['name'], o.query?.['scope']]],
          [mcpCreate, api.createServer, (o) => [o.query?.['thread'], o.body]],
          [mcpChange, api.updateServer, (o) => [o.query?.['thread'], o.path?.['name'], o.query?.['scope'], o.body]],
          [mcpFile, api.file, (o) => [o.query?.['thread'], o.query?.['scope']]],
          [mcpSaveFile, api.saveFile, (o) => [o.query?.['thread'], o.query?.['scope'], o.body]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('Edit opens the form for that server and file; closing forgets it', async () => {
    const mcp = await make();
    mcp.openEdit('docs', 'project');
    expect(mcp.edit()).toEqual({ name: 'docs', scope: 'project' });
    await mcp.serverDetail('docs', 'project');
    expect(api.serverDetail).toHaveBeenCalledWith('t1', 'docs', 'project');
    mcp.closeEdit();
    expect(mcp.edit()).toBeUndefined();
  });

  it('Save and reconnect sends the body for the server, takes the overview and closes the form; a refusal keeps it open with the notice', async () => {
    const mcp = await make();
    mcp.openEdit('docs', 'user');
    expect(await mcp.saveServer('docs', 'user', body)).toBe(true);
    expect(api.updateServer).toHaveBeenCalledWith('t1', 'docs', 'user', body);
    expect(mcp.edit()).toBeUndefined();
    expect(mcp.notice()).toEqual({ level: 'info', text: 'Saved docs.', server: 'docs' });
    mcp.openEdit('docs', 'user');
    api.updateServer.mockRejectedValueOnce(new Error('has a server named “x” already'));
    expect(await mcp.saveServer('docs', 'user', { ...body, name: 'x' })).toBe(false);
    expect(mcp.edit()).toEqual({ name: 'docs', scope: 'user' });
    expect(mcp.notice()).toMatchObject({ level: 'error', text: 'has a server named “x” already' });
  });

  it('a server of your own from the wizard goes through createServer and closes the wizard when it worked', async () => {
    const mcp = await make();
    mcp.openWizard();
    expect(await mcp.addServer({ ...body, scope: 'user' })).toBe(true);
    expect(api.createServer).toHaveBeenCalledWith('t1', { ...body, scope: 'user' });
    expect(mcp.wizard()).toBeUndefined();
    mcp.openWizard();
    api.createServer.mockRejectedValueOnce(new Error('This folder is not trusted yet.'));
    expect(await mcp.addServer({ ...body, scope: 'project' })).toBe(false);
    expect(mcp.wizard()).toEqual({});
    expect(mcp.notice()).toMatchObject({ level: 'error', trust: true });
  });

  it('the file editor opens per scope, reads the file, and a save hands back the file and refreshes the servers', async () => {
    const mcp = await make();
    mcp.openFileEditor('project');
    expect(mcp.fileEditor()).toBe('project');
    expect(await mcp.file('user')).toMatchObject({ text: '{}', mtime: 5 });
    expect(api.file).toHaveBeenCalledWith('t1', 'user');
    current = overview(server('docs', 'connected'), server('new', 'connecting'));
    const saved = await mcp.saveFile('user', '{"mcpServers":{}}', 5);
    expect(api.saveFile).toHaveBeenCalledWith('t1', 'user', { text: '{"mcpServers":{}}', mtime: 5 });
    expect(saved.file).toMatchObject({ text: '{"mcpServers":{}}', mtime: 6 });
    expect(mcp.servers().map((s) => s.name)).toEqual(['docs', 'new']);
    mcp.closeFileEditor();
    expect(mcp.fileEditor()).toBeUndefined();
  });

  it('a file that is refused (the text is not valid, or it changed) throws to the dialog and leaves the servers as they were', async () => {
    const mcp = await make();
    api.saveFile.mockRejectedValueOnce(
      new Error('Line 3: exposure must be one of codemode, deferred, direct, hidden.'),
    );
    await expect(mcp.saveFile('user', '{', 5)).rejects.toThrow(/Line 3/);
    expect(mcp.servers().map((s) => s.name)).toEqual(['docs']);
  });

  it('does not publish a completed file save into another thread', async () => {
    const mcp = await make();
    const oldOverview = current;
    let finish!: (saved: Awaited<ReturnType<typeof api.saveFile>>) => void;
    api.saveFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = mcp.saveFile('project', '{}', 5);
    current = overview(server('other-project', 'connected'));
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    finish({
      file: { scope: 'project', path: '/old/mcp.json', text: '{}', mtime: 6, exists: true },
      message: 'Saved.',
      overview: oldOverview,
    });
    await pending;
    expect(mcp.servers().map((s) => s.name)).toEqual(['other-project']);
  });
});
