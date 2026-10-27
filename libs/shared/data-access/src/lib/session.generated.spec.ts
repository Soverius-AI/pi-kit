import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  BackendService,
  composerComplete,
  composerComposer,
  queueClear,
  queueMerge,
  queuePromote,
  queueQueue,
  queueRemove,
  sessionAbortBash,
  sessionBash,
  sessionChangelog,
  sessionCompact,
  sessionExport,
  sessionListCommands,
  sessionModels,
  sessionReload,
  sessionSetModel,
  sessionStats,
  sessionUsage,
  sessionWorkspaceFiles,
  settingsPatch,
  threadsListFeedback,
  threadsPutFeedback,
  treeEntry,
  treeGet,
  treeLabel,
  treeNavigate,
  treeSummarize,
  unwrap,
  usageGet,
} from '@pi-kit/api';

interface Call {
  path: string;
  method: string;
  body: unknown;
  contentType: string | null;
  signal: AbortSignal | null | undefined;
}

const THREAD = 'thr 1/x';
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

const target = { kind: 'steering', index: 0 } as never;

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
    name: 'commands',
    call: (a) => unwrap(sessionListCommands({ client: a.client, signal: undefined, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/commands`,
  },
  {
    name: 'stats',
    call: (a) => unwrap(sessionStats({ client: a.client, signal: undefined, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/stats`,
  },
  {
    name: 'usage',
    call: (a) => unwrap(sessionUsage({ client: a.client, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/usage`,
  },
  {
    name: 'models',
    call: (a) => unwrap(sessionModels({ client: a.client, signal: undefined, query: { thread: THREAD } })),
    method: 'GET',
    path: `/api/models?thread=${T}`,
  },
  {
    name: 'setModel',
    call: (a) =>
      unwrap(sessionSetModel({ client: a.client, path: { id: THREAD }, body: { thinkingLevel: 'high' } as never })),
    method: 'PATCH',
    path: `/api/threads/${T}/model`,
    body: { thinkingLevel: 'high' },
  },
  {
    name: 'compact (with instructions)',
    call: (a) =>
      unwrap(sessionCompact({ client: a.client, path: { id: THREAD }, body: { instructions: 'keep the plan' } })),
    method: 'POST',
    path: `/api/threads/${T}/compact`,
    body: { instructions: 'keep the plan' },
  },
  {
    name: 'compact (without)',
    call: (a) => unwrap(sessionCompact({ client: a.client, path: { id: THREAD }, body: {} })),
    method: 'POST',
    path: `/api/threads/${T}/compact`,
    body: {},
  },
  {
    name: 'reload',
    call: (a) => unwrap(sessionReload({ client: a.client, path: { id: THREAD } })),
    method: 'POST',
    path: `/api/threads/${T}/reload`,
  },
  {
    name: 'exportSession (with path)',
    call: (a) => unwrap(sessionExport({ client: a.client, path: { id: THREAD }, body: { path: '/tmp/a.html' } })),
    method: 'POST',
    path: `/api/threads/${T}/export`,
    body: { path: '/tmp/a.html' },
  },
  {
    name: 'exportSession (without)',
    call: (a) => unwrap(sessionExport({ client: a.client, path: { id: THREAD }, body: {} })),
    method: 'POST',
    path: `/api/threads/${T}/export`,
    body: {},
  },
  {
    name: 'entryText',
    call: (a) => unwrap(treeEntry({ client: a.client, path: { id: THREAD, entryId: 'e 1/2' } })),
    method: 'GET',
    path: `/api/threads/${T}/entries/e%201%2F2`,
  },
  {
    name: 'navigate',
    call: (a) => unwrap(treeNavigate({ client: a.client, path: { id: THREAD }, body: { targetId: 'e1' } })),
    method: 'POST',
    path: `/api/threads/${T}/navigate`,
    body: { targetId: 'e1' },
  },
  {
    name: 'summarizeBranch',
    call: (a) => unwrap(treeSummarize({ client: a.client, path: { id: THREAD }, body: { targetId: 'e1' } })),
    method: 'POST',
    path: `/api/threads/${T}/summarize-branch`,
    body: { targetId: 'e1' },
  },
  {
    name: 'label',
    call: (a) => unwrap(treeLabel({ client: a.client, path: { id: THREAD }, body: { targetId: 'e1', label: null } })),
    method: 'POST',
    path: `/api/threads/${T}/label`,
    body: { targetId: 'e1', label: null },
  },
  {
    name: 'feedback',
    call: (a) => unwrap(threadsListFeedback({ client: a.client, signal: undefined, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/feedback`,
  },
  {
    name: 'rate',
    call: (a) =>
      unwrap(threadsPutFeedback({ client: a.client, path: { id: THREAD }, body: { messageId: 'm1', rating: 'up' } })),
    method: 'PUT',
    path: `/api/threads/${T}/feedback`,
    body: { messageId: 'm1', rating: 'up' },
  },
  {
    name: 'composer',
    call: (a) => unwrap(composerComposer({ client: a.client, signal: undefined, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/composer`,
  },
  {
    name: 'complete',
    call: (a, s) =>
      unwrap(
        composerComplete({ client: a.client, path: { id: THREAD }, body: { text: '/skill:', cursor: 7 }, signal: s }),
      ),
    method: 'POST',
    path: `/api/threads/${T}/complete`,
    body: { text: '/skill:', cursor: 7 },
    signal: true,
  },
  {
    name: 'changelog',
    call: (a) => unwrap(sessionChangelog({ client: a.client })),
    method: 'GET',
    path: '/api/changelog',
  },
  {
    name: 'files',
    call: (a, s) =>
      unwrap(
        sessionWorkspaceFiles({
          client: a.client,
          path: { id: '/Users/me/my proj' },
          query: { q: 'a b&c' },
          signal: s,
        }),
      ),
    method: 'GET',
    path: '/api/workspaces/%2FUsers%2Fme%2Fmy%20proj/files?q=a%20b%26c',
    signal: true,
  },
  {
    name: 'queueSnapshot',
    call: (a) => unwrap(queueQueue({ client: a.client, path: { id: THREAD } })),
    method: 'GET',
    path: `/api/threads/${T}/queue`,
  },
  {
    name: 'promoteQueued',
    call: (a) => unwrap(queuePromote({ client: a.client, path: { id: THREAD }, body: target })),
    method: 'POST',
    path: `/api/threads/${T}/queue/promote`,
    body: target,
  },
  {
    name: 'removeQueued',
    call: (a) => unwrap(queueRemove({ client: a.client, path: { id: THREAD }, body: target })),
    method: 'POST',
    path: `/api/threads/${T}/queue/remove`,
    body: target,
  },
  {
    name: 'mergeQueued',
    call: (a) => unwrap(queueMerge({ client: a.client, path: { id: THREAD } })),
    method: 'POST',
    path: `/api/threads/${T}/queue/merge`,
  },
  {
    name: 'clearQueued',
    call: (a) => unwrap(queueClear({ client: a.client, path: { id: THREAD } })),
    method: 'POST',
    path: `/api/threads/${T}/queue/clear`,
  },
  {
    name: 'tree',
    call: (a, s) =>
      (async (threadId: string, signal: AbortSignal) => {
        const answer = await unwrap(treeGet({ client: a.client, path: { id: threadId }, signal }));
        if (!('rows' in answer)) throw new Error('The backend answered the session tree with the raw entries.');
        return answer;
      })(THREAD, s),
    method: 'GET',
    path: `/api/threads/${T}/tree`,
    signal: true,
  },
];

describe('generated operations', () => {
  it.each(cases)(
    '$name sends $method $path and returns the parsed answer',
    async ({ call, method, path, body, signal }) => {
      const answer = { rows: [], ok: true };
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

  it("settingsPatch patches pi's enabledModels, and none means every model cycles", async () => {
    const some = setup(() => json({ enabledModels: ['p/a', 'p/b'] }));
    await unwrap(settingsPatch({ client: some.api.client, query: {}, body: { enabledModels: ['p/a', 'p/b'] } }));
    expect(some.calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/pi-settings',
      body: { enabledModels: ['p/a', 'p/b'] },
    });
    const none = setup(() => json({ enabledModels: null }));
    await unwrap(settingsPatch({ client: none.api.client, query: {}, body: { enabledModels: null } }));
    expect(none.calls[0].body).toEqual({ enabledModels: null });
  });

  it('usageGet asks for the provider, URL-encoded, and turns a body-less null answer into null', async () => {
    const usage = { windows: [{ name: '5 h', used: 38 }] };
    const some = setup(() => json(usage));
    expect(
      await (async (provider: string) => {
        const usage = await unwrap(usageGet({ client: some.api.client, path: { id: provider } }));
        // A `null` answer has no body; the client hands back an empty object for it.
        return usage && 'windows' in usage ? usage : null;
      })('open router'),
    ).toEqual(usage);
    expect(some.calls[0]).toMatchObject({ method: 'GET', path: '/api/providers/open%20router/usage' });
    const none = setup(() => new Response(null, { status: 200, headers: { 'Content-Length': '0' } }));
    expect(
      await (async (provider: string) => {
        const usage = await unwrap(usageGet({ client: none.api.client, path: { id: provider } }));
        // A `null` answer has no body; the client hands back an empty object for it.
        return usage && 'windows' in usage ? usage : null;
      })('radius'),
    ).toBeNull();
  });

  it('treeGet asks for raw=1 and returns the entries that are objects', async () => {
    const { api, calls } = setup(() => json({ entries: [{ id: 'a' }, { id: 'b' }], leafId: 'b' }));
    expect(
      await (async (threadId: string) => {
        const answer = await unwrap(treeGet({ client: api.client, path: { id: threadId }, query: { raw: '1' } }));
        if (!('entries' in answer)) throw new Error('The backend answered the raw entries with the session tree.');
        // The contract types an entry as `unknown` (pi's entries are not modelled); the inspector reads each as an object.
        return {
          entries: answer.entries.filter(
            (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
          ),
          leafId: answer.leafId,
        };
      })(THREAD),
    ).toEqual({ entries: [{ id: 'a' }, { id: 'b' }], leafId: 'b' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe(`/api/threads/${T}/tree?raw=1`);
  });

  it('sessionAbortBash posts to the thread and resolves on 204', async () => {
    const { api, calls } = setup(() => new Response(null, { status: 204 }));
    await expect(unwrap(sessionAbortBash({ client: api.client, path: { id: THREAD } }))).resolves.toBeUndefined();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe(`/api/threads/${T}/abort-bash`);
  });

  it('rejects with the backend message on a 4xx answer', async () => {
    const { api } = setup(() => json({ statusCode: 409, message: 'Stop the run first.' }, 409));
    await expect(unwrap(sessionCompact({ client: api.client, path: { id: THREAD }, body: {} }))).rejects.toThrow(
      new Error('Stop the run first.'),
    );
    await expect(unwrap(sessionAbortBash({ client: api.client, path: { id: THREAD } }))).rejects.toThrow(
      'Stop the run first.',
    );
  });

  it('keeps the bash stream on BackendService.fetch', async () => {
    const { api, calls } = setup(() => new Response('{"running":false}\n'));
    const onLine = vi.fn();
    await api.stream(
      sessionBash({
        client: api.client,
        path: { id: THREAD },
        body: { command: 'ls', excludeFromContext: true },
        parseAs: 'stream',
      }),
      onLine,
    );
    expect(onLine).toHaveBeenCalledWith({ running: false });
    expect(calls[0].path).toBe(`/api/threads/${T}/bash`);
    expect(calls[0].body).toEqual({ command: 'ls', excludeFromContext: true });
  });
});
