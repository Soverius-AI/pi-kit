import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  BackendService,
  appSettingsSetSetting,
  appSettingsSettings,
  changesComments,
  changesFile,
  changesList,
  changesPutComments,
  changesRevert,
  changesStage,
  sessionCreateEntry,
  sessionDeleteEntry,
  sessionOpenInEditor,
  sessionRenameEntry,
  sessionRevealInFileManager,
  sessionWorkspaceFiles,
  sessionWorkspaceTree,
  settingsDecide,
  settingsImportSession,
  settingsTrustState,
  terminalInput,
  terminalKill,
  terminalResize,
  terminalStart,
  unwrap,
  workspaceStatusStatus,
  workspacesAddWorkspace,
} from '@pi-kit/api';

interface Call {
  path: string;
  method: string;
  body: unknown;
  contentType: string | null;
  signal: AbortSignal | null | undefined;
}

const CWD = '/Users/me/my proj';
const W = `/api/workspaces/${encodeURIComponent(CWD)}`;
const THREAD = 'thr 1';
const T = encodeURIComponent(THREAD);

/** A fake backend: records the request that reaches `BackendService.fetch` and answers `answer`. */
function setup(answer: () => Response) {
  const calls: Call[] = [];
  const backend = {
    fetch: vi.fn(async (path: string, init: RequestInit = {}) => {
      let body: unknown;
      if (init.body !== undefined && init.body !== null) {
        const text = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer);
        body = text === '' ? undefined : JSON.parse(text);
      }
      calls.push({
        path,
        method: init.method ?? 'GET',
        body,
        contentType: new Headers(init.headers).get('content-type'),
        signal: init.signal,
      });
      return answer();
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: BackendService, useValue: backend }] });
  return { api: TestBed.inject(ApiClient), calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

type Case = {
  name: string;
  call: (api: ApiClient, signal: AbortSignal) => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  signal?: boolean;
};

const cases: Case[] = [
  {
    name: 'tree (root)',
    call: (a, s) =>
      unwrap(
        sessionWorkspaceTree({
          client: a.client,
          path: { id: CWD },
          query: { dir: '', ignored: undefined },
          signal: s,
        }),
      ),
    method: 'GET',
    path: `${W}/tree?dir=`,
    signal: true,
  },
  {
    name: 'tree (folder, with ignored)',
    call: (a) =>
      unwrap(
        sessionWorkspaceTree({
          client: a.client,
          path: { id: CWD },
          query: { dir: 'src/a b', ignored: '1' },
          signal: undefined,
        }),
      ),
    method: 'GET',
    path: `${W}/tree?dir=src%2Fa%20b&ignored=1`,
  },
  {
    name: 'status',
    call: (a) =>
      unwrap(
        workspaceStatusStatus({ client: a.client, path: { id: CWD }, query: { thread: undefined }, signal: undefined }),
      ),
    method: 'GET',
    path: `${W}/status`,
  },
  {
    name: 'status (with thread)',
    call: (a, s) =>
      unwrap(workspaceStatusStatus({ client: a.client, path: { id: CWD }, query: { thread: THREAD }, signal: s })),
    method: 'GET',
    path: `${W}/status?thread=${T}`,
    signal: true,
  },
  {
    name: 'reveal',
    call: (a) =>
      unwrap(sessionRevealInFileManager({ client: a.client, path: { id: CWD }, body: { path: 'src/a.ts' } })),
    method: 'POST',
    path: `${W}/reveal`,
    body: { path: 'src/a.ts' },
  },
  {
    name: 'createEntry',
    call: (a) =>
      unwrap(sessionCreateEntry({ client: a.client, path: { id: CWD }, body: { path: 'src/new', dir: true } })),
    method: 'POST',
    path: `${W}/fs/create`,
    body: { path: 'src/new', dir: true },
  },
  {
    name: 'renameEntry',
    call: (a) => unwrap(sessionRenameEntry({ client: a.client, path: { id: CWD }, body: { from: 'a', to: 'b' } })),
    method: 'POST',
    path: `${W}/fs/rename`,
    body: { from: 'a', to: 'b' },
  },
  {
    name: 'deleteEntry',
    call: (a) =>
      unwrap(sessionDeleteEntry({ client: a.client, path: { id: CWD }, body: { path: 'a', confirm: true } })),
    method: 'POST',
    path: `${W}/fs/delete`,
    body: { path: 'a', confirm: true },
  },
  {
    name: 'search',
    call: (a, s) =>
      unwrap(
        sessionWorkspaceFiles({ client: a.client, path: { id: CWD }, query: { q: 'a b', limit: 100 }, signal: s }),
      ),
    method: 'GET',
    path: `${W}/files?q=a%20b&limit=100`,
    signal: true,
  },
  {
    name: 'openInEditor',
    call: (a) => unwrap(sessionOpenInEditor({ client: a.client, path: { id: CWD }, body: { path: 'a.ts' } })),
    method: 'POST',
    path: `${W}/open`,
    body: { path: 'a.ts' },
  },
  {
    name: 'addWorkspace',
    call: (a) => unwrap(workspacesAddWorkspace({ client: a.client, body: { cwd: CWD } })),
    method: 'POST',
    path: '/api/workspaces',
    body: { cwd: CWD },
  },
  {
    name: 'importSession',
    call: (a) => unwrap(settingsImportSession({ client: a.client, body: { path: '/x/s.jsonl', cwd: CWD } })),
    method: 'POST',
    path: '/api/import',
    body: { path: '/x/s.jsonl', cwd: CWD },
  },
  {
    name: 'startTerminal',
    call: (a) => unwrap(terminalStart({ client: a.client, path: { id: CWD }, body: { cols: 80, rows: 24 } })),
    method: 'POST',
    path: `${W}/terminal`,
    body: { cols: 80, rows: 24 },
  },
  {
    name: 'terminalInput',
    call: (a) => unwrap(terminalInput({ client: a.client, path: { id: CWD }, body: { data: 'ls\r' } })),
    method: 'POST',
    path: `${W}/terminal/input`,
    body: { data: 'ls\r' },
  },
  {
    name: 'terminalResize',
    call: (a) => unwrap(terminalResize({ client: a.client, path: { id: CWD }, body: { cols: 100, rows: 30 } })),
    method: 'POST',
    path: `${W}/terminal/resize`,
    body: { cols: 100, rows: 30 },
  },
  {
    name: 'killTerminal',
    call: (a) => unwrap(terminalKill({ client: a.client, path: { id: CWD } })),
    method: 'DELETE',
    path: `${W}/terminal`,
  },
  {
    name: 'trust',
    call: (a) => unwrap(settingsTrustState({ client: a.client, path: { id: CWD } })),
    method: 'GET',
    path: `${W}/trust`,
  },
  {
    name: 'decideTrust',
    call: (a) => unwrap(settingsDecide({ client: a.client, path: { id: CWD }, body: { decision: 'trust' as never } })),
    method: 'POST',
    path: `${W}/trust`,
    body: { decision: 'trust' },
  },
  {
    name: 'changes',
    call: (a, s) =>
      unwrap(changesList({ client: a.client, path: { id: THREAD }, query: { source: 'worktree' }, signal: s })),
    method: 'GET',
    path: `/api/threads/${T}/changes?source=worktree`,
    signal: true,
  },
  {
    name: 'diff',
    call: (a, s) =>
      unwrap(
        changesFile({
          client: a.client,
          path: { id: THREAD, file: 'src/a b/c.ts' },
          query: { source: 'thread' },
          signal: s,
        }),
      ),
    method: 'GET',
    path: `/api/threads/${T}/changes/src%2Fa%20b%2Fc.ts?source=thread`,
    signal: true,
  },
  {
    name: 'revert',
    call: (a) =>
      unwrap(
        changesRevert({
          client: a.client,
          path: { id: THREAD },
          body: { file: 'src/a.ts', source: 'thread', confirm: true },
        }),
      ),
    method: 'POST',
    path: `/api/threads/${T}/revert`,
    body: { file: 'src/a.ts', source: 'thread', confirm: true },
  },
  {
    name: 'stage (all)',
    call: (a) => unwrap(changesStage({ client: a.client, path: { id: THREAD }, body: { source: 'worktree', ...{} } })),
    method: 'POST',
    path: `/api/threads/${T}/stage`,
    body: { source: 'worktree' },
  },
  {
    name: 'stage (files)',
    call: (a) =>
      unwrap(
        changesStage({
          client: a.client,
          path: { id: THREAD },
          body: { source: 'worktree', ...{ files: ['a', 'b'] } },
        }),
      ),
    method: 'POST',
    path: `/api/threads/${T}/stage`,
    body: { source: 'worktree', files: ['a', 'b'] },
  },
  {
    name: 'reviewComments',
    call: (a) => unwrap(changesComments({ client: a.client, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/review-comments`,
  },
  {
    name: 'putReviewComments',
    call: (a) => unwrap(changesPutComments({ client: a.client, path: { id: THREAD }, body: { comments: [] } })),
    method: 'PUT',
    path: `/api/threads/${T}/review-comments`,
    body: { comments: [] },
  },
  {
    name: 'uiSettings',
    call: (a) => unwrap(appSettingsSettings({ client: a.client })),
    method: 'GET',
    path: '/api/settings',
  },
  {
    name: 'setUiSetting',
    call: (a) => unwrap(appSettingsSetSetting({ client: a.client, path: { key: 'theme' }, body: { value: 'dark' } })),
    method: 'PUT',
    path: '/api/settings/theme',
    body: { value: 'dark' },
  },
];

describe('generated operations', () => {
  it.each(cases)(
    '$name sends $method $path and returns the parsed answer',
    async ({ call, method, path, body, signal }) => {
      const answer = { ok: 1, items: ['a'] };
      const { api, calls } = setup(() => json(answer));
      const result = await call(api, new AbortController().signal);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe(method);
      expect(calls[0].path).toBe(path);
      expect(calls[0].body).toEqual(body);
      if (body !== undefined) expect(calls[0].contentType).toContain('application/json');
      if (signal) expect(calls[0].signal).toBeTruthy();
      expect(result).toEqual(answer);
    },
  );

  it('sends the folder encoded once: %2F, not %252F', async () => {
    const { api, calls } = setup(() => json([]));
    await unwrap(
      sessionWorkspaceTree({
        client: api.client,
        path: { id: '/Users/me/proj' },
        query: { dir: '', ignored: undefined },
        signal: undefined,
      }),
    );
    expect(calls[0].path).toBe('/api/workspaces/%2FUsers%2Fme%2Fproj/tree?dir=');
  });

  it('a 204 resolves', async () => {
    const { api } = setup(() => new Response(null, { status: 204 }));
    await expect(
      unwrap(sessionDeleteEntry({ client: api.client, path: { id: CWD }, body: { path: 'a', confirm: true } })),
    ).resolves.toBeUndefined();
    await expect(unwrap(terminalKill({ client: api.client, path: { id: CWD } }))).resolves.toBeUndefined();
    await expect(
      unwrap(changesPutComments({ client: api.client, path: { id: THREAD }, body: { comments: [] } })),
    ).resolves.toBeUndefined();
  });

  it('rejects with the backend message on a 4xx answer', async () => {
    const { api } = setup(() => json({ statusCode: 409, message: 'Stop the run first.' }, 409));
    await expect(
      unwrap(changesStage({ client: api.client, path: { id: THREAD }, body: { source: 'thread', ...{} } })),
    ).rejects.toThrow(new Error('Stop the run first.'));
    await expect(
      unwrap(
        changesRevert({
          client: api.client,
          path: { id: THREAD },
          body: { file: 'a', source: 'thread', confirm: true },
        }),
      ),
    ).rejects.toThrow('Stop the run first.');
  });
});
