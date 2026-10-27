import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  attendantAccept,
  attendantDismiss,
  attendantPatch,
  attendantRun,
  attendantStatus,
  BackendService,
  coordinationGet,
  failureText,
  fakeBackend,
  threadsClone,
  threadsCreate,
  threadsFork,
  threadsList,
  threadsPatch,
  threadsRemove,
  threadsSeen,
  unwrap,
  workspacesOrderWorkspaces,
  workspacesPatchWorkspace,
  workspacesWorkspaces,
  worktreeAbort,
  worktreeMerge,
  worktreeMessage,
  worktreeRemove,
  worktreeState,
  worktreeSync,
} from '@pi-kit/api';

/** What goes on the wire for each call: the typed client runs for real, over a stand-in for the backend. */
describe('generated operations', () => {
  let backend: ReturnType<typeof fakeBackend>;
  let api: ApiClient;
  const fetch = vi.fn();

  beforeEach(() => {
    backend = fakeBackend();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: backend.apiClient },
        { provide: BackendService, useValue: { fetch } },
      ],
    });
    api = TestBed.inject(ApiClient);
  });

  const lastCall = () => backend.calls.at(-1);

  it('lists the threads of a folder, the archived ones on request, and returns what the backend answered', async () => {
    backend.reply([{ id: 't1' }]);
    expect(
      await unwrap(
        threadsList({ client: api.client, signal: undefined, query: { workspace: '/work/proj', archived: '1' } }),
      ),
    ).toEqual([{ id: 't1' }]);
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/api/threads?workspace=%2Fwork%2Fproj&archived=1' });
    backend.reply([]);
    await unwrap(
      threadsList({ client: api.client, signal: undefined, query: { workspace: undefined, archived: undefined } }),
    );
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/api/threads' });
  });

  it('answers a pending dialog with the AG-UI resume (the run request the approval block makes), and reads the stream in the background', async () => {
    fetch.mockResolvedValueOnce(new Response('data: {}\n\n', { status: 200 }));
    await (async (threadId: string, dialogId: string, payload: { confirmed: boolean } | { value: string }) => {
      const res = await TestBed.inject(BackendService).fetch('/api/copilotkit/agent/pi/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          threadId,
          runId: crypto.randomUUID(),
          state: {},
          tools: [],
          context: [],
          messages: [],
          forwardedProps: {},
          resume: [{ interruptId: dialogId, status: 'resolved', payload }],
        }),
      });
      if (!res.ok) throw new Error(await failureText(res));
      void res.text().catch(() => undefined);
    })('t1', 'd1', { confirmed: true });
    const [path, init] = fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(path).toBe('/api/copilotkit/agent/pi/run');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      threadId: 't1',
      messages: [],
      resume: [{ interruptId: 'd1', status: 'resolved', payload: { confirmed: true } }],
    });
    expect(typeof body.runId).toBe('string');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Thread t1 not found.' }), { status: 404 }));
    await expect(
      (async (threadId: string, dialogId: string, payload: { confirmed: boolean } | { value: string }) => {
        const res = await TestBed.inject(BackendService).fetch('/api/copilotkit/agent/pi/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            threadId,
            runId: crypto.randomUUID(),
            state: {},
            tools: [],
            context: [],
            messages: [],
            forwardedProps: {},
            resume: [{ interruptId: dialogId, status: 'resolved', payload }],
          }),
        });
        if (!res.ok) throw new Error(await failureText(res));
        void res.text().catch(() => undefined);
      })('t1', 'd1', { value: 'canary' }),
    ).rejects.toThrow('Thread t1 not found.');
  });

  it('creates a thread, in a worktree when asked', async () => {
    backend.reply({ id: 't2' }, 201);
    await unwrap(threadsCreate({ client: api.client, body: { cwd: '/work/proj', ...{}, ...{} } }));
    expect(lastCall()).toMatchObject({ method: 'POST', path: '/api/threads', body: { cwd: '/work/proj' } });
    backend.reply({ id: 't3' }, 201);
    await unwrap(
      threadsCreate({
        client: api.client,
        body: { cwd: '/work/proj', ...{ worktree: { branch: 'feature' } as never }, ...{} },
      }),
    );
    expect(lastCall()?.body).toEqual({ cwd: '/work/proj', worktree: { branch: 'feature' } });
  });

  it.each([
    [
      'workspaces',
      () => unwrap(workspacesWorkspaces({ client: api.client, signal: undefined })),
      'GET',
      '/api/workspaces',
      undefined,
    ],
    [
      'markSeen',
      () => unwrap(threadsSeen({ client: api.client, path: { id: 't1' } })),
      'POST',
      '/api/threads/t1/seen',
      undefined,
    ],
    [
      'patchWorkspace',
      () => unwrap(workspacesPatchWorkspace({ client: api.client, body: { cwd: '/p', collapsed: true } })),
      'PATCH',
      '/api/workspaces',
      { cwd: '/p', collapsed: true },
    ],
    [
      'orderWorkspaces',
      () => unwrap(workspacesOrderWorkspaces({ client: api.client, body: { order: ['/a', '/b'] } })),
      'PUT',
      '/api/workspaces/order',
      { order: ['/a', '/b'] },
    ],
    [
      'patch',
      () => unwrap(threadsPatch({ client: api.client, path: { id: 't1' }, body: { pinned: true } })),
      'PATCH',
      '/api/threads/t1',
      { pinned: true },
    ],
    [
      'remove (keep)',
      () => unwrap(threadsRemove({ client: api.client, path: { id: 't1' }, query: { worktree: undefined } })),
      'DELETE',
      '/api/threads/t1',
      undefined,
    ],
    [
      'remove (force)',
      () => unwrap(threadsRemove({ client: api.client, path: { id: 't1' }, query: { worktree: 'force' } })),
      'DELETE',
      '/api/threads/t1?worktree=force',
      undefined,
    ],
    [
      'coordination',
      () => unwrap(coordinationGet({ client: api.client, signal: undefined, path: { id: 't1' } })),
      'GET',
      '/api/threads/t1/coordination',
      undefined,
    ],
    [
      'worktree',
      () => unwrap(worktreeState({ client: api.client, path: { id: 't1' } })),
      'GET',
      '/api/threads/t1/worktree',
      undefined,
    ],
    [
      'worktreeMessage',
      () => unwrap(worktreeMessage({ client: api.client, path: { id: 't1' } })),
      'GET',
      '/api/threads/t1/worktree/message',
      undefined,
    ],
    [
      'syncWorktree',
      () => unwrap(worktreeSync({ client: api.client, path: { id: 't1' }, body: { strategy: 'rebase' } })),
      'POST',
      '/api/threads/t1/worktree/sync',
      { strategy: 'rebase' },
    ],
    [
      'abortWorktreeOperation',
      () => unwrap(worktreeAbort({ client: api.client, path: { id: 't1' } })),
      'POST',
      '/api/threads/t1/worktree/abort',
      undefined,
    ],
    [
      'mergeWorktree',
      () => unwrap(worktreeMerge({ client: api.client, path: { id: 't1' }, body: { remove: true } })),
      'POST',
      '/api/threads/t1/worktree/merge',
      { remove: true },
    ],
    [
      'removeWorktree',
      () => unwrap(worktreeRemove({ client: api.client, path: { id: 't1' }, body: { force: true } })),
      'POST',
      '/api/threads/t1/worktree/remove',
      { force: true },
    ],
    [
      'fork',
      () => unwrap(threadsFork({ client: api.client, path: { id: 't1' }, body: { entryId: 'e9' } })),
      'POST',
      '/api/threads/t1/fork',
      { entryId: 'e9' },
    ],
    [
      'fork (whole)',
      () => unwrap(threadsFork({ client: api.client, path: { id: 't1' }, body: {} })),
      'POST',
      '/api/threads/t1/fork',
      {},
    ],
    [
      'clone',
      () => unwrap(threadsClone({ client: api.client, path: { id: 't1' }, body: {} })),
      'POST',
      '/api/threads/t1/clone',
      {},
    ],
  ])('%s sends the method, path and body the contract names', async (_name, call, method, path, body) => {
    backend.reply();
    await call();
    expect(lastCall()).toMatchObject({ method, path });
    expect(lastCall()?.body).toEqual(body);
  });

  it('encodes a thread id that has to be encoded', async () => {
    backend.reply();
    await unwrap(threadsSeen({ client: api.client, path: { id: 'a b/c' } }));
    expect(lastCall()?.path).toBe('/api/threads/a%20b%2Fc/seen');
  });

  it('turns an error answer into an Error with the backend’s message, a rejected request with every problem', async () => {
    backend.fail(409, 'Stop the run before deleting the thread.');
    await expect(
      unwrap(threadsRemove({ client: api.client, path: { id: 't1' }, query: { worktree: undefined } })),
    ).rejects.toThrow('Stop the run before deleting the thread.');
    backend.fail(400, ['cwd: Too small: expected string to have >=1 characters', 'title: Invalid input']);
    await expect(unwrap(threadsCreate({ client: api.client, body: { cwd: '', ...{}, ...{} } }))).rejects.toThrow(
      'cwd: Too small: expected string to have >=1 characters, title: Invalid input',
    );
  });

  it('turns an answer that has no message into the status line', async () => {
    backend.reply({}, 502);
    await expect(unwrap(workspacesWorkspaces({ client: api.client, signal: undefined }))).rejects.toThrow(/^502/);
  });
});

describe('generated operations', () => {
  it('reads the status with the signal, patches the settings, runs and answers suggestions', async () => {
    const backend = fakeBackend();
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: backend.apiClient }] });
    const api = TestBed.inject(ApiClient);
    const abort = new AbortController();

    backend.reply({ settings: {} });
    await unwrap(attendantStatus({ client: api.client, signal: abort.signal }));
    expect(backend.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/attendant' });

    backend.reply({ enabled: true });
    await unwrap(attendantPatch({ client: api.client, body: { enabled: true } }));
    expect(backend.calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/api/attendant/settings',
      body: { enabled: true },
    });

    backend.reply({ queued: 1 }, 201);
    expect(await unwrap(attendantRun({ client: api.client, body: { threadId: 't1' } }))).toEqual({ queued: 1 });
    expect(backend.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/attendant/run',
      body: { threadId: 't1' },
    });
    backend.reply({ queued: 3 }, 201);
    await unwrap(attendantRun({ client: api.client, body: {} }));
    expect(backend.calls.at(-1)?.body).toEqual({});

    backend.reply();
    await unwrap(attendantAccept({ client: api.client, path: { id: 7 } }));
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/attendant/suggestions/7/accept' });
    backend.reply();
    await unwrap(attendantDismiss({ client: api.client, path: { id: 7 } }));
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/attendant/suggestions/7/dismiss' });

    backend.fail(409, 'The attendant is off.');
    await expect(unwrap(attendantRun({ client: api.client, body: {} }))).rejects.toThrow('The attendant is off.');
  });
});
