import {
  coordinationGet,
  createTypedClient,
  fakeBackend,
  problemText,
  threadsCreate,
  threadsList,
  threadsPatch,
  threadsRemove,
  threadsSeen,
  unwrap,
  worktreeMerge,
} from '../index';

// This function is type-checked but never executed: invalid requests must fail
// compilation without issuing a request or producing an unhandled rejection.
function invalidRequests(client: ReturnType<typeof createTypedClient>): void {
  // @ts-expect-error id is required
  void coordinationGet({ client });
  // @ts-expect-error the path parameter is id, not threadId
  void coordinationGet({ client, path: { threadId: 't1' } });
  // @ts-expect-error workspaceId is not a query parameter
  void threadsList({ client, query: { workspaceId: '/p' } });
  // @ts-expect-error archived accepts only the documented flags
  void threadsList({ client, query: { archived: 'yes' } });
  // @ts-expect-error cwd is required
  void threadsCreate({ client, body: {} });
  // @ts-expect-error folder is not a request field
  void threadsCreate({ client, body: { folder: '/p' } });
  // @ts-expect-error merge mode is merge or pr
  void worktreeMerge({ client, path: { id: 't1' }, body: { mode: 'squash' } });
  // @ts-expect-error seen takes no request body
  void threadsSeen({ client, path: { id: 't1' }, body: { seen: true } });
}
void invalidRequests;

describe('the generated SDK', () => {
  it('serializes path/query/body through the authenticated transport', async () => {
    const { client, calls } = fakeBackend();
    await threadsList({ client, query: { workspace: '/p', archived: '1' } });
    await threadsCreate({ client, body: { cwd: '/p' } });
    await threadsPatch({ client, path: { id: 'thr 1/x' }, body: { pinned: true } });
    await threadsRemove({ client, path: { id: 't1' }, query: { worktree: 'force' } });
    expect(calls).toMatchObject([
      { method: 'GET', path: '/api/threads?workspace=%2Fp&archived=1' },
      { method: 'POST', path: '/api/threads', body: { cwd: '/p' } },
      { method: 'PATCH', path: '/api/threads/thr%201%2Fx', body: { pinned: true } },
      { method: 'DELETE', path: '/api/threads/t1?worktree=force' },
    ]);
  });

  it('types responses from the contract', async () => {
    const backend = fakeBackend();
    backend.reply([{ id: 't1', title: 'A thread' }]);
    const threads = await unwrap(threadsList({ client: backend.client }));
    expect(threads[0].title satisfies string | null).toBe('A thread');
    // @ts-expect-error the title is title, not name
    void threads[0].name;
  });

  it('preserves HTTP and network error messages', async () => {
    const backend = fakeBackend();
    backend.fail(400, ['cwd: missing', 'mode: invalid']);
    await expect(unwrap(threadsCreate({ client: backend.client, body: { cwd: '' } }))).rejects.toThrow(
      'cwd: missing, mode: invalid',
    );
    const client = createTypedClient(async () => {
      throw new Error('Connection refused');
    });
    await expect(unwrap(threadsList({ client }))).rejects.toThrow('Connection refused');
    expect(problemText(undefined, new Response(null, { status: 502, statusText: 'Bad Gateway' }))).toBe(
      '502 Bad Gateway',
    );
  });
});
