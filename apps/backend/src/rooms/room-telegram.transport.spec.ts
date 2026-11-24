import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramMessage, TelegramUpdate } from '@chat-adapter/telegram';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { RoomTelegramTransport } from './room-telegram.transport';
import type { RoomTelegramCredentials } from './room-telegram-credentials';
import type { PhoneMessage } from './room-phone.types';

const TOKEN = '123456:abcdefghijklmnopqrstuvwxyz1234567890';
const NEXT_TOKEN = '123456:zyxwvutsrqponmlkjihgfedcba1234567890';
const OTHER_TOKEN = '999999:abcdefghijklmnopqrstuvwxyz1234567890';
const CODE = 'a'.repeat(24);
let dir: string, db: DatabaseService, meta: MetaRepository, transport: RoomTelegramTransport;
let token: string,
  updates: TelegramUpdate[],
  polls: Record<string, unknown>[],
  sends: Record<string, unknown>[],
  methods: string[],
  saved: ReturnType<typeof vi.fn>;
let failure: boolean, webhook: string, username: string, groupAccess: boolean;
let fileResponse: () => Response;
const message = (text: string, id = 1, extra: Record<string, unknown> = {}): TelegramMessage =>
  ({
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -1001, type: 'supergroup', title: 'Personal' },
    from: { id: 77, is_bot: false, first_name: 'Owner' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    ...extra,
  }) as TelegramMessage;
const update = (text: string, id = 1, extra: Record<string, unknown> = {}): TelegramUpdate => ({
  update_id: id,
  message: message(text, id, extra),
});
function credentials(): RoomTelegramCredentials {
  return {
    configured: true,
    read: async () => ({ botToken: token }),
    save: saved,
  } as unknown as RoomTelegramCredentials;
}
function fresh(): RoomTelegramTransport {
  return new RoomTelegramTransport(credentials(), meta);
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('stopped', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
async function checkpoint(): Promise<Record<string, unknown>> {
  const all = await meta.allSettings();
  return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('rooms.telegram.polling:')));
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pi-room-telegram-'));
  db = await DatabaseService.create({ dataDir: dir });
  meta = new MetaRepository(db);
  token = TOKEN;
  updates = [];
  polls = [];
  sends = [];
  methods = [];
  failure = false;
  webhook = '';
  username = 'RoomBot';
  groupAccess = true;
  fileResponse = () => new Response('hello', { headers: { 'content-length': '5' } });
  saved = vi.fn(async (value: { botToken: string }) => {
    token = value.botToken;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      if (url.includes('/file/bot')) return fileResponse();
      const method = url.split('/').at(-1) ?? '';
      methods.push(method);
      const body = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>;
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
      if (method === 'getMe') {
        if (failure) throw new Error(`unsafe ${TOKEN}`);
        return reply({
          id: url.includes(OTHER_TOKEN) ? 999999 : 123456,
          is_bot: true,
          first_name: 'Room',
          username,
          can_join_groups: groupAccess,
        });
      }
      if (method === 'getWebhookInfo') return reply({ url: webhook });
      if (method === 'setMyCommands') return reply(true);
      if (method === 'getUpdates') {
        polls.push(body);
        const offset = Number(body.offset ?? 0);
        updates = updates.filter((value) => value.update_id >= offset);
        if (!updates.length) await wait(25, options?.signal ?? undefined);
        return reply(updates);
      }
      if (method === 'sendMessage') {
        sends.push(body);
        if (failure) throw new Error(`unsafe ${TOKEN}`);
        return reply({
          message_id: 90,
          chat: { id: Number(body.chat_id), type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: body.text,
        });
      }
      if (method === 'getFile') return reply({ file_path: 'documents/file.txt', file_size: 5 });
      throw new Error('Unexpected fake Telegram API method');
    }),
  );
  transport = fresh();
});
afterEach(async () => {
  await transport.disconnect();
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Telegram Rooms with the real official SDK', () => {
  it('keeps a single self-recovering poll failure quiet and ignores expected shutdown aborts', async () => {
    const api = fetch;
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        if (String(input).endsWith('/getUpdates') && ++attempts === 1) throw new Error(`temporary failure ${TOKEN}`);
        return api(input, options);
      }),
    );
    await transport.connect();
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(transport.error).toBeNull();
    await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(transport.error).toBeNull();
    await transport.disconnect();
    expect(transport.error).toBeNull();
    expect(transport.phase).toBe('disconnected');
  });

  it('clears repeated polling errors after healthy receive while a successful send alone does not hide the outage', async () => {
    const api = fetch;
    let unavailable = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        if (String(input).endsWith('/getUpdates') && unavailable) throw new Error(`network failure ${TOKEN}`);
        return api(input, options);
      }),
    );
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(transport.error).toContain('polling is temporarily unavailable'), { timeout: 3000 });
    expect(transport.phase).toBe('connected');
    await transport.send('telegram:-1001', 'outbound still works');
    expect(transport.error).toContain('polling is temporarily unavailable');
    expect(transport.error).not.toContain(TOKEN);
    unavailable = false;
    updates = [update('/memory')];
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(transport.error).toBeNull();
  });

  it.each([401, 403, 404, 409])(
    'keeps a current HTTP %i polling configuration failure actionable even while other API requests succeed',
    async (status) => {
      const api = fetch;
      let rejected = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
          if (String(input).endsWith('/getUpdates')) {
            rejected++;
            return new Response(
              JSON.stringify({ ok: false, error_code: status, description: `Unauthorized ${TOKEN}` }),
              {
                status,
              },
            );
          }
          return api(input, options);
        }),
      );
      await transport.connect();
      await vi.waitFor(() => expect(transport.error).toContain(status === 409 ? 'only one app' : 'BotFather'));
      await transport.send('telegram:-1001', 'outbound succeeds independently');
      await vi.waitFor(() => expect(rejected).toBeGreaterThan(1), { timeout: 3000 });
      expect(transport.error).toContain(status === 409 ? 'only one app' : 'rejected this bot token');
      expect(transport.error).not.toContain(TOKEN);
    },
  );

  it('does not hide failed local admission behind healthy empty polls and clears it after durable retry succeeds', async () => {
    updates = [update('/memory')];
    let unavailable = true;
    const receive = vi.fn(async (_message: PhoneMessage) => {
      if (unavailable) throw new Error('local admission unavailable');
    });
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(transport.error).toContain('pending update'));
    await vi.waitFor(() => expect(polls.length).toBeGreaterThan(2));
    expect(transport.error).toContain('pending update');
    unavailable = false;
    await vi.waitFor(() => expect(receive.mock.calls.length).toBeGreaterThan(1), { timeout: 4000 });
    await vi.waitFor(() => expect(transport.error).toBeNull());
  });

  it('keeps checkpoint failures visible and recovers once the formerly unpersisted input is durably admitted', async () => {
    updates = [update('/memory')];
    const write = vi.spyOn(meta, 'setSetting').mockRejectedValue(new Error('disk unavailable'));
    transport.receive = async () => {
      throw new Error('admission unavailable');
    };
    await transport.connect();
    await vi.waitFor(() => expect(transport.error).toContain('local queue is unavailable'));
    await transport.send('telegram:-1001', 'send succeeds but local queue still needs attention');
    expect(transport.error).toContain('local queue is unavailable');
    expect(polls.every((value) => Number(value.offset ?? 0) <= 1)).toBe(true);
    write.mockRestore();
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await vi.waitFor(() => expect(transport.error).toBeNull());
  });

  it('preserves a command-menu configuration warning across healthy polling', async () => {
    const api = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        if (String(input).endsWith('/setMyCommands')) throw new Error('menu unavailable');
        return api(input, options);
      }),
    );
    await transport.connect();
    await vi.waitFor(() => expect(transport.error).toContain('Typed commands still work'));
    await vi.waitFor(() => expect(polls.length).toBeGreaterThan(2));
    expect(transport.error).toContain('command menu');
  });

  it('verifies getMe before protected save, reports numeric identity, and preserves actionable credential errors', async () => {
    await transport.configure({ botToken: TOKEN });
    expect(saved).toHaveBeenCalledExactlyOnceWith({ botToken: TOKEN });
    expect(transport.details()).toMatchObject({ identity: { id: '123456', username: 'RoomBot' } });
    await expect(transport.configure({ botToken: 'bad' })).rejects.toThrow('BotFather');
    saved.mockRejectedValueOnce(new ConflictException('Enable the operating system credential store'));
    await expect(transport.configure({ botToken: TOKEN })).rejects.toThrow('Enable the operating system');
    failure = true;
    await expect(transport.configure({ botToken: TOKEN })).rejects.toThrow('could not be reached');
    expect(transport.error ?? '').not.toContain(TOKEN);
  });
  it.each([
    { status: 401, expected: 400, message: 'Telegram rejected this bot token' },
    { status: 404, expected: 400, message: 'Telegram rejected this bot token' },
    { status: 429, expected: 429, message: 'Try again in 19 seconds' },
    { status: 502, expected: 503, message: 'Telegram could not be reached' },
  ])(
    'reports safe actionable token verification errors for HTTP $status without saving',
    async ({ status, expected, message }) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: status,
            description: `unsafe provider message ${TOKEN}`,
            parameters: { retry_after: 19 },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
      );
      const error = await transport.configure({ botToken: TOKEN }).catch((error) => error as HttpException);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(expected);
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(saved).not.toHaveBeenCalled();
      expect(transport.phase).toBe('disconnected');
    },
  );
  it('trims copied BotFather whitespace before verification and protected storage', async () => {
    await transport.configure({ botToken: ` \n${TOKEN}\n ` });
    expect(saved).toHaveBeenCalledExactlyOnceWith({ botToken: TOKEN });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });
  it('honors the provider retry delay before making another token verification request', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 19 },
        }),
        { status: 429 },
      ),
    );
    await expect(transport.configure({ botToken: TOKEN })).rejects.toThrow('19 seconds');
    const requests = vi.mocked(fetch).mock.calls.length;
    clock.mockReturnValue(now + 4000);
    await expect(transport.configure({ botToken: TOKEN })).rejects.toThrow('15 seconds');
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(saved).not.toHaveBeenCalled();
    clock.mockReturnValue(now + 19000);
    await transport.configure({ botToken: TOKEN });
    expect(saved).toHaveBeenCalledExactlyOnceWith({ botToken: TOKEN });
  });
  it('uses polling without deleting an existing webhook and requires BotFather group access', async () => {
    webhook = 'https://existing.example/hook';
    await expect(transport.connect()).rejects.toThrow('already has a webhook');
    expect(methods).not.toContain('deleteWebhook');
    webhook = '';
    groupAccess = false;
    await expect(transport.connect()).rejects.toThrow('/setjoingroups');
  });
  it('normalizes privacy-compatible native and deep-link commands, rejecting other bots and forwards', async () => {
    updates = [
      update(`/room_link@RoomBot ${CODE}`, 1),
      update(`/start@RoomBot ${CODE}`, 2),
      update(`/approve@RoomBot token`, 3),
      update(`/room_link@OtherBot ${CODE}`, 4),
      update(`/approve@RoomBot token`, 5, { forward_origin: { type: 'user' } }),
    ];
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(3));
    expect(receive.mock.calls.map(([value]) => value.text)).toEqual([
      `/room-link ${CODE}`,
      `/room-link ${CODE}`,
      '/approve token',
    ]);
    expect(transport.commandSuffix).toBe('@RoomBot');
    expect(transport.commandSeparator).toBe('_');
    expect(methods).toContain('setMyCommands');
  });
  it('accepts mentions and bot replies in groups, preserves topics, and drops private, channel, bot, anonymous and edited updates', async () => {
    const mention = '@RoomBot read this';
    updates = [
      update(mention, 1, {
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 12,
        is_topic_message: true,
      }),
      update('reply', 2, {
        entities: [],
        reply_to_message: message('bot', 80, { from: { id: 123456, is_bot: true, first_name: 'Bot' } }),
        message_thread_id: 80,
      }),
      update('unaddressed', 3, { entities: [] }),
      update('/memory', 4, { chat: { id: 77, type: 'private' } }),
      update('/memory', 5, { chat: { id: -1001, type: 'channel' } }),
      update('/memory', 6, { from: { id: 3, is_bot: true } }),
      update('/memory', 7, { sender_chat: { id: -1002, type: 'channel' } }),
      { update_id: 8, edited_message: message('/memory', 8) },
    ];
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ group: 'telegram:-1001:12', text: 'read this', sender: '77' });
    expect(receive.mock.calls[1]?.[0]).toMatchObject({ group: 'telegram:-1001', quoteId: '-1001:80', text: 'reply' });
  });
  it('saves failed admission durably before acknowledging and replays it after restart without another canonical work item', async () => {
    updates = [update('/memory', 1)];
    const rooms = new RoomsRepository(db);
    await rooms.insert({
      id: 'tg-room',
      title: 'Telegram',
      repository: '',
      baseCommit: '',
      summary: '',
      sourceThreadId: null,
      projectFolder: null,
      createdAt: 1,
    });
    const accept = async (value: PhoneMessage) =>
      rooms.acceptMessage(
        'tg-room',
        { text: value.text },
        `channel:telegram:${transport.account}:${value.group}:${value.id}`,
      );
    transport.receive = async (value) => {
      await accept(value);
      throw new Error('admission reply interrupted');
    };
    await transport.connect();
    await vi.waitFor(() => expect(polls.some((value) => Number(value.offset) > 1)).toBe(true));
    const durable = await checkpoint();
    expect(Object.values(durable)[0]).toMatchObject({ pending: [{ update: { update_id: 1 } }] });
    await transport.disconnect();
    transport = fresh();
    const replayed = vi.fn(async (value: PhoneMessage) => {
      await accept(value);
    });
    transport.receive = replayed;
    await transport.connect();
    await vi.waitFor(() => expect(replayed).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(await rooms.pendingWakes('tg-room')).toBe(1);
    expect((await rooms.events('tg-room')).filter((value) => value.actor === 'owner')).toHaveLength(1);
  });
  it('does not advance the provider offset when failed input cannot be persisted to SQLite', async () => {
    updates = [update('/memory', 1)];
    transport.receive = async () => {
      throw new Error('DB admission unavailable');
    };
    const write = vi.spyOn(meta, 'setSetting').mockRejectedValue(new Error('disk unavailable'));
    await transport.connect();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(polls.every((value) => Number(value.offset ?? 0) <= 1)).toBe(true);
    await transport.disconnect();
    expect(polls.every((value) => Number(value.offset ?? 0) <= 1)).toBe(true);
  });
  it('preserves UTF16 mention routing after redaction and a same-bot token/username rotation', async () => {
    const secret = 'sk-proj-' + 'x'.repeat(45);
    const text = secret + ' @RoomBot help';
    updates = [update(text, 1, { entities: [{ type: 'mention', offset: secret.length + 1, length: 8 }] })];
    transport.receive = async () => {
      throw new Error('later');
    };
    await transport.connect();
    await vi.waitFor(() => expect(polls.some((value) => Number(value.offset) > 1)).toBe(true));
    const before = await checkpoint();
    const reads = vi.spyOn(meta, 'getSetting');
    expect(JSON.stringify(before)).not.toContain(secret);
    expect(JSON.stringify(before)).not.toContain(TOKEN);
    await transport.disconnect();
    username = 'RenamedBot';
    transport = fresh();
    await transport.configure({ botToken: NEXT_TOKEN });
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(receive.mock.calls[0]?.[0].text).toMatch(/^\*+\s+help$/);
    expect(reads.mock.calls.some(([key]) => key === Object.keys(before)[0])).toBe(true);
    transport.receive = async () => {
      throw new Error('pending for old bot');
    };
    updates = [update('/memory', 20)];
    await vi.waitFor(() => expect(polls.some((value) => Number(value.offset) > 20)).toBe(true));
    await transport.disconnect();
    transport = fresh();
    await transport.configure({ botToken: OTHER_TOKEN });
    transport.receive = receive;
    await transport.connect();
    await wait(1100);
    expect(reads.mock.calls.some(([key]) => key.startsWith('rooms.telegram.polling:999999:'))).toBe(true);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(transport.account).toBe('999999');
  });
  it('uses one plain SDK send with a native quote/topic and never retries ambiguous failures', async () => {
    await transport.connect();
    expect(transport.retryStableSends).toBe(false);
    expect(
      await transport.send('telegram:-1001:12', 'punctuation_*[]', 'reserved', {
        id: '-1001:3',
        sender: '77',
        text: 'question',
      }),
    ).toBe('-1001:90');
    expect(sends[0]).toMatchObject({
      chat_id: '-1001',
      message_thread_id: 12,
      text: 'punctuation_*[]',
      reply_parameters: { message_id: 3 },
    });
    expect(sends[0]).not.toHaveProperty('parse_mode');
    failure = true;
    await expect(transport.send('telegram:-1001', 'may have sent', 'reserved')).rejects.toThrow('could not confirm');
    expect(sends).toHaveLength(2);
    expect(transport.error ?? '').not.toContain(TOKEN);
  });
  it('bounds ordinary replies while retaining their footer and preserves unsupported attachment captions', async () => {
    updates = [
      update('@RoomBot inspect caption', 1, {
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        document: { file_id: 'big', file_unique_id: 'u', file_size: MAX_FILE + 1, file_name: 'big.zip' },
      }),
    ];
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('inspect caption') });
    expect(receive.mock.calls[0]?.[0].text).toContain('not imported');
    expect(receive.mock.calls[0]?.[0].files).toBeUndefined();
    await transport.send('telegram:-1001', 'x'.repeat(7000) + '\n/approve@RoomBot token');
    expect(String(sends[0]?.text).length).toBeLessThanOrEqual(4096);
    expect(String(sends[0]?.text)).toContain('/approve@RoomBot token');
    await transport.send('telegram:-1001', 'x'.repeat(2949) + '😀' + 'x'.repeat(3000) + '😀' + 'y'.repeat(999));
    expect(String(sends[1]?.text)).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(String(sends[1]?.text).length).toBeLessThanOrEqual(4096);
  });
  it('downloads authenticated SDK attachments with stream limits and redirects disabled, without persisting token URLs', async () => {
    updates = [
      update('@RoomBot read file', 1, {
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        document: {
          file_id: 'file-1',
          file_unique_id: 'u',
          file_size: 5,
          file_name: 'note.txt',
          mime_type: 'text/plain',
        },
      }),
    ];
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    const raw = receive.mock.calls[0]?.[0].raw;
    if (!raw) throw new Error('missing attachment');
    expect(raw).not.toContain(TOKEN);
    expect(Buffer.from(await transport.media(raw)).toString()).toBe('hello');
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.find(([value]) => String(value).includes('/file/bot'))?.[1]).toMatchObject({
      redirect: 'error',
    });
    fileResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_FILE));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      );
    await expect(transport.media(raw)).rejects.toThrow('smaller than 16 MiB');
  });
  it('bounds an unresolved credential read and refuses late startup completion', async () => {
    let resolve: (value: { botToken: string }) => void = () => undefined;
    const blocked = credentials();
    blocked.read = () => new Promise((done) => (resolve = done));
    transport = new RoomTelegramTransport(blocked, meta);
    vi.useFakeTimers();
    try {
      const connecting = expect(transport.connect()).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(25001);
      await connecting;
      expect(transport.phase).toBe('error');
      resolve({ botToken: TOKEN });
      await Promise.resolve();
      await Promise.resolve();
      expect(transport.phase).toBe('error');
      expect(polls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('immediately cancels a pending keychain read without a late adapter binding', async () => {
    let resolve: (value: { botToken: string }) => void = () => undefined;
    const blocked = credentials();
    blocked.read = () => new Promise((done) => (resolve = done));
    transport = new RoomTelegramTransport(blocked, meta);
    const connecting = transport.connect();
    await transport.disconnect();
    await connecting;
    resolve({ botToken: TOKEN });
    await wait(20);
    expect(transport.phase).toBe('disconnected');
    expect(polls).toHaveLength(0);
  });
  it('offers a privacy-safe ask command without interpreting its question as a control', async () => {
    updates = [
      update('/room@RoomBot What is next?', 1),
      update('/room@RoomBot /approve token', 2),
      update('/room@RoomBot', 3),
      update('/help@RoomBot', 4),
    ];
    const receive = vi.fn(async (_message: PhoneMessage) => undefined);
    transport.receive = receive;
    await transport.connect();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(4));
    expect(receive.mock.calls.map(([value]) => value.text)).toEqual([
      'Owner asks: What is next?',
      'Owner asks: /approve token',
      '/help',
      '/help',
    ]);
  });
  it('aborts startup and in-flight API requests without reviving a disconnected transport', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, options) => {
        await wait(10000, options?.signal ?? undefined);
        throw new Error('unreachable');
      }),
    );
    const connecting = transport.connect();
    await vi.waitFor(() => expect(transport.phase).toBe('connecting'));
    await transport.disconnect();
    await connecting;
    expect(transport.phase).toBe('disconnected');
    expect(transport.error).toBeNull();
  });
});
const MAX_FILE = 16 * 1024 * 1024;
