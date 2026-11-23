import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackAdapter } from '@chat-adapter/slack';
import { RoomSlackCredentials } from './room-slack-credentials';
import type { SecretsService } from '../secrets/secrets.service';
import type { MetaRepository } from '../db/meta.repository';
import { RoomSlackSdk, RoomSlackTransport, createRoomSlackAdapter } from './room-slack.transport';

const tokens = { appToken: 'xapp-test-app-token-value', botToken: 'xoxb-test-bot-token-value' };
const event = (changes: Record<string, unknown> = {}) => ({
  team_id: 'T123',
  event_id: 'Ev123',
  event: {
    type: 'message',
    channel: 'C123',
    channel_type: 'channel',
    user: 'U123',
    text: '!room-link pairing',
    ts: '1234567890.123456',
    ...changes,
  },
});
interface Routed {
  routeSocketEvent(body: Record<string, unknown>, type: string, ack: () => Promise<void>): Promise<void>;
}
const route = (adapter: unknown) => adapter as Routed;

afterEach(() => vi.restoreAllMocks());

describe('Slack OS credential storage', () => {
  function fixture(kind = 'keychain') {
    const values = new Map<string, string>();
    const store = {
      kind,
      available: () => true,
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key: string) => values.get(key)),
    };
    const secrets = { store, credentialsEnabled: async () => true };
    const meta = { getSetting: vi.fn(async () => false), setSetting: vi.fn(async () => undefined) };
    return {
      store,
      meta,
      service: new RoomSlackCredentials(secrets as unknown as SecretsService, meta as unknown as MetaRepository),
    };
  }
  it('saves one atomic OS credential record and persists only a configured flag', async () => {
    const f = fixture();
    await f.service.onModuleInit();
    expect(f.store.get).not.toHaveBeenCalled();
    await f.service.save(tokens);
    expect(await f.service.read()).toEqual(tokens);
    expect(f.store.set).toHaveBeenCalledWith('rooms.slack', JSON.stringify(tokens));
    expect(f.meta.setSetting).toHaveBeenCalledWith('rooms.slack.configured', true);
    expect(JSON.stringify(f.meta.setSetting.mock.calls)).not.toContain('xoxb');
  });
  it('refuses plaintext fallback and redacts store failures', async () => {
    const file = fixture('file');
    await expect(file.service.save(tokens)).rejects.toThrow(/operating system/);
    expect(file.store.set).not.toHaveBeenCalled();
    const broken = fixture();
    broken.store.set.mockRejectedValue(new Error(tokens.botToken));
    await expect(broken.service.save(tokens)).rejects.toThrow(
      'Slack tokens could not be saved in the operating system credential store.',
    );
    expect(broken.meta.setSetting).not.toHaveBeenCalled();
  });
});

describe('Slack room Socket Mode transport', () => {
  let transport: RoomSlackTransport;
  let adapter: FakeAdapter;
  let credentials: RoomSlackCredentials;
  let meta: MetaRepository;
  const post = vi.fn();
  const download = vi.fn();
  const auth = vi.fn();
  class FakeAdapter {
    readonly webClient = {
      auth: { test: auth },
      chat: { postMessage: post },
      conversations: { info: vi.fn(async () => ({ channel: { name: 'personal-assistant' } })) },
    };
    readonly disconnect = vi.fn(async () => undefined);
    constructor(readonly options: unknown) {
      record(this);
    }
    async initialize() {
      return undefined;
    }
  }
  function record(value: FakeAdapter) {
    adapter = value;
  }
  beforeEach(async () => {
    post.mockReset().mockResolvedValue({ ok: true, ts: '1234567891.123456' });
    download.mockReset().mockResolvedValue(Buffer.from('document'));
    auth.mockReset().mockResolvedValue({ ok: true, team_id: 'T123', user_id: 'U999', bot_id: 'B999' });
    vi.spyOn(RoomSlackSdk, 'load').mockResolvedValue({
      SlackAdapter: FakeAdapter,
      Chat: class {
        constructor(private readonly options: { adapters: { slack: FakeAdapter } }) {}
        async initialize() {
          await this.options.adapters.slack.initialize();
        }
        async shutdown() {
          return undefined;
        }
      },
      createMemoryState: () => ({}),
      downloadAttachment: download,
    } as never);
    credentials = {
      configured: true,
      read: async () => tokens,
      save: vi.fn(async () => undefined),
    } as unknown as RoomSlackCredentials;
    const values = new Map<string, unknown>();
    meta = {
      getSetting: vi.fn(async (key: string) => values.get(key)),
      setSetting: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
    } as unknown as MetaRepository;
    transport = new RoomSlackTransport(credentials, meta);
    await transport.connect();
  });
  it('awaits durable admission before ack and allows Slack retry after failed admission', async () => {
    const order: string[] = [];
    transport.receive = vi.fn(async (message) => {
      expect(message.text).toBe('!room-link pairing');
      order.push('durable');
    });
    await route(adapter).routeSocketEvent(event(), 'events_api', async () => {
      order.push('ack');
    });
    expect(order).toEqual(['durable', 'ack']);
    expect(transport.account).toBe('T123:U999');
    transport.receive = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const ack = vi.fn();
    await route(adapter).routeSocketEvent(event({ ts: '1234567890.123457' }), 'events_api', ack);
    expect(transport.error).toContain('durably accept');
    expect(ack).not.toHaveBeenCalled();
  });
  it('retains stable provider identity on retries and tolerates a socket closing during acknowledgement', async () => {
    const receive = (transport.receive = vi.fn());
    await route(adapter).routeSocketEvent(event(), 'events_api', async () => {
      throw new Error('socket closed');
    });
    await route(adapter).routeSocketEvent(
      { ...event({ type: 'app_mention' }), event_id: 'EvRetry' },
      'events_api',
      vi.fn(),
    );
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['1234567890.123456', '1234567890.123456']);
  });

  it('filters foreign workspaces, bots, edits, deletes and direct messages before common admission', async () => {
    transport.receive = vi.fn();
    const ack = vi.fn();
    for (const body of [
      { ...event(), team_id: 'TFOREIGN' },
      event({ user: 'U999' }),
      event({ bot_id: 'B123' }),
      event({ subtype: 'message_changed' }),
      event({ subtype: 'message_deleted' }),
      event({ channel: 'D123', channel_type: 'im' }),
      event({ channel_type: 'mpim' }),
      event({ team: 'TFOREIGN' }),
    ])
      await route(adapter).routeSocketEvent(body, 'events_api', ack);
    expect(transport.receive).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(8);
  });
  it('keeps a stable channel binding across subthreads and sends one stable UUID without hidden Web API retries', async () => {
    const receive = (transport.receive = vi.fn());
    await route(adapter).routeSocketEvent(
      event({ text: 'follow-up', thread_ts: '1234567000.123456' }),
      'events_api',
      vi.fn(),
    );
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'C123', id: '1234567890.123456', quoteId: '1234567000.123456' }),
    );
    const id = transport.createMessageId();
    expect(
      await transport.send('C123', 'reply', id, { id: '1234567890.123456', sender: 'U123', text: 'follow-up' }),
    ).toBe('1234567891.123456');
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', client_msg_id: id, thread_ts: '1234567000.123456' }),
    );
    expect(adapter.options).toMatchObject({
      mode: 'socket',
      webClientOptions: { timeout: 15000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
    });
  });
  it('recovers thread roots after restart and keeps message text when an attachment is unsupported', async () => {
    transport.receive = vi.fn();
    await route(adapter).routeSocketEvent(
      event({
        thread_ts: '1234567000.123456',
        files: [{ id: 'F123', name: 'huge.txt', size: 17000000, url_private: 'https://files.slack.com/large' }],
      }),
      'events_api',
      vi.fn(),
    );
    expect(transport.receive).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('message text was retained') }),
    );
    await transport.disconnect();
    const recovered = new RoomSlackTransport(credentials, meta);
    await recovered.connect();
    await recovered.send('C123', 'queued reply after restart', recovered.createMessageId(), {
      id: '1234567890.123456',
      sender: 'U123',
      text: 'question',
    });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1234567000.123456' }));
  });

  it('preserves text and attachment metadata and downloads only authenticated, bounded Slack-hosted files', async () => {
    const file = {
      id: 'F123',
      name: 'notes.txt',
      mimetype: 'text/plain',
      size: 20,
      url_private: 'https://files.slack.com/files-pri/T123-F123/notes.txt',
    };
    const receive = (transport.receive = vi.fn());
    await route(adapter).routeSocketEvent(
      event({ text: 'Read my notes', subtype: 'file_share', files: [file] }),
      'events_api',
      vi.fn(),
    );
    const message = receive.mock.calls[0][0];
    expect(message).toMatchObject({
      text: 'Read my notes',
      files: [{ name: 'notes.txt', mime: 'text/plain', size: 20, type: 'file' }],
    });
    expect(Buffer.from(await transport.media(message.raw!)).toString()).toBe('document');
    expect(download).toHaveBeenCalledWith(
      file.url_private,
      expect.objectContaining({
        hosts: ['files.slack.com'],
        limit: 16 * 1024 * 1024,
        redirects: 0,
        headers: { authorization: `Bearer ${tokens.botToken}` },
      }),
    );
    await expect(
      transport.media(JSON.stringify({ team: 'T123', files: [{ url_private: 'https://127.0.0.1/private' }] })),
    ).rejects.toThrow(/not from/);
    await expect(transport.media(JSON.stringify({ team: 'TFOREIGN', files: [file] }))).rejects.toThrow(/not from/);
    expect(download).toHaveBeenCalledOnce();
  });
});

it('extends the actual Vercel Slack adapter Socket Mode hook without running its ack-first event path', async () => {
  const { SlackAdapter } = await import('@chat-adapter/slack');
  const receive = vi.fn(async () => undefined);
  const logger = { child: () => logger, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const adapter: SlackAdapter = createRoomSlackAdapter(SlackAdapter, { mode: 'socket', ...tokens, logger }, receive);
  const ack = vi.fn();
  await route(adapter).routeSocketEvent(event(), 'events_api', ack);
  expect(receive).toHaveBeenCalledWith(event());
  expect(ack).toHaveBeenCalledOnce();
  expect(adapter.encodeThreadId({ channel: 'C123', threadTs: '1234567890.123456' })).toContain('C123');
});

async function socketFixture(stall = false) {
  const sdk = await RoomSlackSdk.load();
  const clients: FakeSocket[] = [];
  const webClient = { auth: { test: async () => ({ ok: true, team_id: 'T123', user_id: 'U999', bot_id: 'B999' }) } };
  class FakeSocketAdapter extends sdk.SlackAdapter {
    constructor(config: ConstructorParameters<typeof sdk.SlackAdapter>[0]) {
      super({ ...config, botUserId: 'U999' });
    }
    override get webClient(): SlackAdapter['webClient'] {
      return webClient as unknown as SlackAdapter['webClient'];
    }
  }
  class FakeSocket extends EventEmitter {
    release?: () => void;
    disconnected = 0;
    constructor(readonly options: ConstructorParameters<typeof sdk.SocketModeClient>[0]) {
      super();
      clients.push(this);
    }
    async start() {
      if (stall)
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      this.emit('connected');
      return {};
    }
    async disconnect() {
      this.disconnected++;
      this.emit('disconnected');
    }
    async deliver(body: Record<string, unknown>, ack: () => Promise<void>) {
      const handler = this.listeners('slack_event')[0] as (event: {
        body: Record<string, unknown>;
        type: string;
        ack: () => Promise<void>;
      }) => Promise<void>;
      await handler({ body, type: 'events_api', ack });
    }
  }
  vi.spyOn(RoomSlackSdk, 'load').mockResolvedValue({
    ...sdk,
    SlackAdapter: FakeSocketAdapter,
    SocketModeClient: FakeSocket,
  } as never);
  const transport = new RoomSlackTransport(
    { configured: true, read: async () => tokens } as unknown as RoomSlackCredentials,
    { getSetting: async () => undefined, setSetting: async () => undefined } as unknown as MetaRepository,
  );
  return { transport, clients };
}

it('initializes real Chat and official Slack adapter with bounded public Socket Mode options', async () => {
  const { transport, clients } = await socketFixture();
  try {
    await transport.connect();
    expect(transport.phase).toBe('connected');
    expect(clients[0].options).toMatchObject({
      appToken: tokens.appToken,
      autoReconnectEnabled: false,
      clientOptions: { timeout: 15000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
    });
    expect(clients[0].options?.clientOptions?.headers).toBeUndefined();
    const order: string[] = [];
    transport.receive = async () => {
      order.push('durable');
    };
    await clients[0].deliver(event(), async () => {
      order.push('ack');
    });
    expect(order).toEqual(['durable', 'ack']);
  } finally {
    await transport.disconnect();
  }
});

it('bounds a stalled Socket Mode startup and closes its owned network agent', async () => {
  const { transport, clients } = await socketFixture(true);
  vi.useFakeTimers();
  try {
    const connecting = transport.connect();
    const failed = expect(connecting).rejects.toThrow(/within 20 seconds/);
    await vi.advanceTimersByTimeAsync(20001);
    await failed;
    expect(transport.phase).toBe('error');
    expect(clients[0].disconnected).toBeGreaterThan(0);
    const agent = clients[0].options?.clientOptions?.agent;
    expect(() => agent?.createConnection({})).toThrow(/cancelled/);
    clients[0].release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.phase).toBe('error');
    expect(transport.account).toBeUndefined();
  } finally {
    await transport.disconnect();
    vi.useRealTimers();
  }
});

it('cancels startup promptly and prevents a late authentication or handshake from reconnecting', async () => {
  const { transport, clients } = await socketFixture(true);
  const connecting = transport.connect();
  await vi.waitFor(() => expect(clients).toHaveLength(1));
  await transport.disconnect();
  await connecting;
  clients[0].release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(transport.phase).toBe('disconnected');
  expect(transport.account).toBeUndefined();
  expect(() => clients[0].options?.clientOptions?.agent?.createConnection({})).toThrow(/cancelled/);
});

it('reconnects established sockets in the background with bounded attempts and cancels retry on disconnect', async () => {
  const { transport, clients } = await socketFixture();
  vi.useFakeTimers();
  try {
    await transport.connect();
    clients[0].emit('disconnected');
    expect(transport.phase).toBe('connecting');
    await vi.advanceTimersByTimeAsync(5001);
    expect(clients).toHaveLength(2);
    expect(transport.phase).toBe('connected');
    clients[1].emit('disconnected');
    await transport.disconnect();
    await vi.advanceTimersByTimeAsync(60001);
    expect(clients).toHaveLength(2);
    expect(transport.phase).toBe('disconnected');
  } finally {
    await transport.disconnect();
    vi.useRealTimers();
  }
});
