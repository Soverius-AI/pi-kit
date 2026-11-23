import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomWhatsAppTransport } from './room-whatsapp.transport';

const sdk = vi.hoisted(() => ({
  handler: undefined as ((thread: unknown, message: Message) => Promise<void>) | undefined,
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  sendText: vi.fn(),
  media: vi.fn(),
  thread: vi.fn(async () => ({ channelName: 'Personal' })),
  config: undefined as
    | undefined
    | {
        onConnectionUpdate?: (value: { connection: string; loggedOut: boolean }) => void;
        onMessageBatch?: (batch: { type: string; groups: number; ownGroups: number }) => void;
        onDelivery?: (value: { id: string; threadId: string; status: number }) => Promise<void>;
      },
}));
vi.mock('chat', () => ({
  Chat: class {
    constructor(_config: unknown) {
      return;
    }
    onNewMessage(_pattern: RegExp, handler: typeof sdk.handler) {
      sdk.handler = handler;
    }
    onNewMention() {
      return undefined;
    }
    onSubscribedMessage() {
      return undefined;
    }
    async initialize() {
      return undefined;
    }
    async shutdown() {
      return undefined;
    }
  },
}));
vi.mock('@chat-adapter/state-memory', () => ({ createMemoryState: () => ({}) }));
vi.mock('chat-adapter-baileys', () => ({
  createBaileysAdapter: (config: typeof sdk.config) => {
    sdk.config = config;
    return {
      botUserId: 'assistant:42@s.whatsapp.net',
      connect: async () => {
        await sdk.connect();
        config?.onConnectionUpdate?.({ connection: 'open', loggedOut: false });
      },
      disconnect: sdk.disconnect,
      postMessage: sdk.send,
      sendText: sdk.sendText,
      fetchMedia: sdk.media,
      fetchThread: sdk.thread,
    };
  },
}));
vi.mock('baileys', () => ({
  BufferJSON: { reviver: (_key: string, value: unknown) => value, replacer: (_key: string, value: unknown) => value },
  extractMessageContent: (message: unknown) => message,
  useMultiFileAuthState: async () => ({
    state: { keys: { set: async () => undefined } },
    saveCreds: async () => undefined,
  }),
  DEFAULT_CONNECTION_CONFIG: { logger: { child: () => ({}) } },
}));

describe('WhatsApp transport admission', () => {
  const folders: string[] = [];
  afterEach(() => {
    vi.clearAllMocks();
    for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  it('ignores account sync, bot echoes, DMs and empty messages before durable ingestion', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pi-wa-transport-'));
    folders.push(folder);
    const transport = new RoomWhatsAppTransport({ dataDir: folder });
    transport.receive = vi.fn();
    await transport.connect();
    const data = {
      id: 'incoming',
      threadId: 'baileys:group',
      text: 'hello',
      author: { userId: 'owner@lid', userName: 'Owner', fullName: 'Owner', isMe: false },
      raw: { key: { remoteJid: 'group@g.us', fromMe: false } },
    };
    const receive = async (override: Record<string, unknown>) =>
      sdk.handler?.({}, { ...data, ...override } as unknown as Message);
    await receive({ raw: { key: { remoteJid: 'group@g.us', fromMe: true } } });
    await receive({ author: { ...data.author, isMe: true } });
    await receive({ raw: { key: { remoteJid: 'owner@s.whatsapp.net' } } });
    await receive({ text: '' });
    expect(transport.receive).not.toHaveBeenCalled();
    await receive({ text: '/room-link abc' });
    expect(transport.receive).toHaveBeenCalledExactlyOnceWith({
      id: 'incoming',
      group: 'baileys:group',
      groupName: 'Personal',
      sender: 'owner@lid',
      senderName: 'Owner',
      text: '/room-link abc',
    });
    expect(transport.account).toBe('assistant@s.whatsapp.net');
    await transport.disconnect();
    expect(transport.phase).toBe('disconnected');
    expect(transport.qr).toBeNull();
  });
  it('never admits the linked assistant account through a same-account callback', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pi-wa-dedicated-'));
    folders.push(folder);
    const transport = new RoomWhatsAppTransport({ dataDir: folder });
    transport.receive = vi.fn();
    await transport.connect();
    expect(sdk.config).not.toHaveProperty('onOwnMessage');
    for (const isMe of [false, true])
      await sdk.handler?.({}, {
        id: 'self-link',
        threadId: 'baileys:group@g.us',
        text: '/room-link abc',
        author: { userId: 'assistant@s.whatsapp.net', userName: 'Assistant', isMe },
        raw: { key: { remoteJid: 'group@g.us', fromMe: true } },
      } as unknown as Message);
    expect(transport.receive).not.toHaveBeenCalled();
    await transport.disconnect();
  });
  it('reports aggregate input diagnostics, admits linking despite stalled metadata and surfaces callback errors', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pi-wa-diagnostics-'));
    folders.push(folder);
    const transport = new RoomWhatsAppTransport({ dataDir: folder });
    transport.receive = vi.fn();
    await transport.connect();
    sdk.config?.onMessageBatch?.({ type: 'append', groups: 2, ownGroups: 1 });
    expect(transport.input).toMatchObject({
      lastGroupAt: expect.any(Number),
      lastOwnGroupAt: expect.any(Number),
      ignoredHistory: 2,
      lastAcceptedAt: null,
    });
    sdk.thread.mockImplementationOnce(() => new Promise(() => undefined));
    const incoming = {
      id: 'manual-link',
      threadId: 'baileys:group@g.us',
      text: '/room-link abc',
      author: { userId: 'owner@lid', userName: 'Owner', fullName: 'Owner', isMe: false },
      raw: { key: { remoteJid: 'group@g.us', fromMe: false } },
    } as unknown as Message;
    await sdk.handler?.({}, incoming);
    expect(transport.receive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ groupName: '', text: '/room-link abc' }),
    );
    expect(transport.input.lastAcceptedAt).toEqual(expect.any(Number));
    expect(transport.input.ignoredHistory).toBe(2);
    transport.receive = vi.fn(async () => {
      throw new Error('private content must not leak');
    });
    await sdk.handler?.({}, { ...incoming, text: 'hello' } as Message);
    expect(transport.error).toBe('WhatsApp could not process a group message. Try again or reconnect.');
    await transport.disconnect();
  });
  it('preserves attachment-only inputs and quote identity without downloading before admission', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pi-wa-media-'));
    folders.push(folder);
    const transport = new RoomWhatsAppTransport({ dataDir: folder });
    transport.receive = vi.fn();
    await transport.connect();
    await sdk.handler?.({}, {
      id: 'voice',
      threadId: 'baileys:group',
      text: '',
      attachments: [{ name: 'note.ogg', mimeType: 'audio/ogg', size: 4, type: 'audio' }],
      author: { userId: 'owner:7@lid', userName: 'Owner', fullName: 'Owner', isMe: false },
      raw: {
        key: { remoteJid: 'group@g.us', fromMe: false },
        message: { audioMessage: { contextInfo: { stanzaId: 'quoted-id' } } },
      },
    } as unknown as Message);
    expect(transport.receive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: 'voice',
        sender: 'owner@lid',
        quoteId: 'quoted-id',
        files: [{ name: 'note.ogg', mime: 'audio/ogg', type: 'audio', size: 4 }],
        raw: expect.any(String),
      }),
    );
    expect(sdk.media).not.toHaveBeenCalled();
    sdk.media.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    expect(await transport.media('{"message":"saved"}')).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(sdk.media).toHaveBeenCalledWith({ message: 'saved' }, 16 * 1024 * 1024);
    await transport.disconnect();
  });
  it('uses the persisted message id and quoted source, and reports delivery and logout lifecycle events', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pi-wa-send-'));
    folders.push(folder);
    const transport = new RoomWhatsAppTransport({ dataDir: folder });
    transport.receipt = vi.fn();
    await transport.connect();
    sdk.sendText.mockResolvedValue({ id: 'stable-id' });
    const quote = { id: 'owner-message', sender: 'owner@lid', text: 'please prepare' };
    expect(await transport.send('baileys:group', 'Prepared', 'stable-id', quote)).toBe('stable-id');
    expect(sdk.sendText).toHaveBeenCalledExactlyOnceWith('baileys:group', 'Prepared', 'stable-id', quote);
    await sdk.config?.onDelivery?.({ id: 'stable-id', threadId: 'baileys:group', status: 4 });
    expect(transport.receipt).toHaveBeenCalledExactlyOnceWith('stable-id', 4, 'baileys:group');
    sdk.config?.onConnectionUpdate?.({ connection: 'close', loggedOut: true });
    expect(transport.phase).toBe('disconnected');
    expect(transport.error).toContain('Linked devices');
    await transport.disconnect();
  });
  it('fences old session callbacks after disconnect and reconnect', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pi-wa-session-'));
    folders.push(folder);
    const transport = new RoomWhatsAppTransport({ dataDir: folder });
    transport.receive = vi.fn();
    transport.receipt = vi.fn();
    await transport.connect();
    const old = sdk.config;
    const oldReceive = sdk.handler;
    await transport.disconnect();
    old?.onConnectionUpdate?.({ connection: 'close', loggedOut: false });
    expect(transport.phase).toBe('disconnected');
    await transport.connect();
    old?.onConnectionUpdate?.({ connection: 'close', loggedOut: true });
    await old?.onDelivery?.({ id: 'old-id', status: 4, threadId: 'old-group' });
    await oldReceive?.({}, {
      text: 'old message',
      author: { isMe: false },
      raw: { key: { remoteJid: 'old@g.us' } },
    } as unknown as Message);
    expect(transport.phase).toBe('connected');
    expect(transport.error).toBeNull();
    expect(transport.receive).not.toHaveBeenCalled();
    expect(transport.receipt).not.toHaveBeenCalled();
    await transport.disconnect();
  });
});
