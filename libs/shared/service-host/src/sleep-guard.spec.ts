import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendActivity } from './sleep-guard';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

/** A backend whose status stream the test writes, line by line. */
async function backend() {
  let stream: ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url !== '/api/threads/events' || req.headers.authorization !== 'Bearer t') {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    stream = res;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: { url: `http://127.0.0.1:${port}`, port, token: 't' },
    send: async (event: unknown) => {
      await vi.waitFor(() => expect(stream).toBeDefined());
      stream?.write(`${JSON.stringify(event)}\n`);
    },
  };
}

const state = (activity: string) => ({ activity, question: null, unread: false });

describe('BackendActivity', () => {
  it('keeps the computer awake while a thread runs or an agent works, not while a thread waits for an answer', async () => {
    const { endpoint, send } = await backend();
    const changes: boolean[] = [];
    const activity = new BackendActivity(
      () => endpoint,
      (active) => changes.push(active),
    );
    activity.start();
    cleanup.push(() => activity.stop());

    await send({ type: 'snapshot', states: { a: state('running'), b: state('idle') } });
    await vi.waitFor(() => expect(changes).toEqual([true]));
    await send({ type: 'agents', id: 'b', agents: [{ status: 'active' }, { status: 'done' }] });
    await send({ type: 'state', id: 'a', state: state('waiting') });
    await send({ type: 'agents', id: 'b', agents: [{ status: 'done' }, { status: 'done' }] });

    await vi.waitFor(() => expect(changes).toEqual([true, false]));
  });
});
