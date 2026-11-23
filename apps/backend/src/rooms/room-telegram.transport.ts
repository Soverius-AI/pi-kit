import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Chat, type Logger as ChatLogger } from 'chat';
import { MemoryStateAdapter } from '@chat-adapter/state-memory';
import { AdapterRateLimitError } from '@chat-adapter/shared';
import {
  TelegramAdapter,
  type TelegramAdapterConfig,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
  type TelegramWebhookInfo,
} from '@chat-adapter/telegram';
import { BUILTIN_PATTERNS, type RoomChannelStatus, type RoomPhoneStatus } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { RoomTelegramCredentials, RoomTelegramCredentialsSchema } from './room-telegram-credentials';
import type { RoomMessagingTransport } from './room-messaging.transport';
import type { PhoneMessage } from './room-phone.types';

const API = 'https://api.telegram.org';
const MAX_FILE = 16 * 1024 * 1024;
const MAX_CHECKPOINT = 8 * 1024 * 1024;
type Identity = NonNullable<RoomChannelStatus['identity']>;
type Incoming = TelegramMessage & {
  sender_chat?: unknown;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  new_chat_members?: unknown;
  left_chat_member?: unknown;
  migrate_to_chat_id?: unknown;
  migrate_from_chat_id?: unknown;
};

/** Preserve UTF-16 entity offsets while ensuring pending owner text cannot
 * retain known secret shapes in the database. Provider IDs contain no tokens. */
function maskCheckpoint(value: unknown): unknown {
  if (typeof value === 'string')
    return BUILTIN_PATTERNS.reduce(
      (text, pattern) =>
        text.replace(new RegExp(pattern.pattern.source, pattern.pattern.flags), (match) => '*'.repeat(match.length)),
      value,
    ).replace(/(?:bot)?\d{5,20}:[A-Za-z0-9_-]{20,200}/g, (match) => '*'.repeat(match.length));
  if (Array.isArray(value)) return value.map(maskCheckpoint);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskCheckpoint(item)]));
  return value;
}

/** Only the SDK's bot-scoped polling checkpoint is persistent. Failed updates
 * must reach SQLite before getUpdates is allowed to acknowledge their offset. */
export class RoomTelegramPollingState extends MemoryStateAdapter {
  constructor(
    private readonly meta: MetaRepository,
    private readonly account: string,
  ) {
    super();
  }
  private key(key: string): string | undefined {
    return key.startsWith('telegram:polling:') ? `rooms.telegram.polling:${this.account}:${key}` : undefined;
  }
  override async get<T = unknown>(key: string): Promise<T | null> {
    const stored = this.key(key);
    return stored ? (((await this.meta.getSetting(stored)) as T | undefined) ?? null) : super.get<T>(key);
  }
  override async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const stored = this.key(key);
    if (!stored) return super.set(key, value, ttlMs);
    if (JSON.stringify(value).length > MAX_CHECKPOINT)
      throw new Error('Telegram pending input reached the local queue limit.');
    await this.meta.setSetting(stored, maskCheckpoint(value));
  }
  override async delete(key: string): Promise<void> {
    const stored = this.key(key);
    if (stored) await this.meta.deleteSetting(stored);
    else await super.delete(key);
  }
}

/** Extends official protected hooks, without SDK private-state access or webhooks. */
export class RoomTelegramAdapter extends TelegramAdapter {
  constructor(
    config: TelegramAdapterConfig,
    private readonly lifecycle: AbortSignal,
    private readonly admit: (update: TelegramUpdate) => Promise<void>,
    private readonly ready: Promise<void> = Promise.resolve(),
  ) {
    super(config);
  }
  async identity(): Promise<Identity> {
    const me = await this.telegramFetch<TelegramUser & { can_join_groups?: boolean }>('getMe');
    if (me.can_join_groups === false)
      throw new Error('Enable group access with BotFather /setjoingroups before connecting this bot.');
    if (
      !Number.isSafeInteger(me.id) ||
      me.id <= 0 ||
      me.is_bot !== true ||
      !me.username ||
      !/^[A-Za-z0-9_]{5,32}$/.test(me.username)
    )
      throw new Error('Telegram did not verify a valid bot identity.');
    return {
      id: String(me.id),
      username: me.username,
      name: [me.first_name, me.last_name].filter(Boolean).join(' ').slice(0, 200),
    };
  }
  async checkPolling(): Promise<void> {
    const info = await this.telegramFetch<TelegramWebhookInfo>('getWebhookInfo');
    if (info.url)
      throw new Error('This Telegram bot already has a webhook. Remove that deployment before connecting it to Rooms.');
  }
  async installCommands(): Promise<void> {
    const descriptions: Record<string, string> = {
      room: 'Ask the room a question',
      help: 'Show room commands',
      room_link: 'Link this group to a room',
      room_test: 'Verify a round trip',
      memory: 'Show remembered facts',
      remember: 'Remember a fact',
      forget: 'Forget a fact',
      pending: 'Show pending decisions',
      pause: 'Pause the room',
      resume: 'Resume the room',
      done: 'Complete a commitment',
      snooze: 'Snooze a commitment',
      answer: 'Answer a pending question',
      approve: 'Approve a pending action',
      reject: 'Reject a pending action',
    };
    await this.telegramFetch('setMyCommands', {
      commands: Object.entries(descriptions).map(([command, description]) => ({ command, description })),
    });
  }
  protected override processUpdate(update: TelegramUpdate): Promise<void>[] {
    // Chat catches handler exceptions. Admit directly so the polling checkpoint
    // sees failures, and persistThreadHistory=false avoids a second transcript.
    return [this.cancelled(this.ready.then(() => this.admit(update)))];
  }
  private async cancelled<T>(promise: Promise<T>): Promise<T> {
    if (this.lifecycle.aborted) {
      void promise.catch(() => undefined);
      throw new DOMException('Telegram connection cancelled.', 'AbortError');
    }
    let abort: () => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException('Telegram connection cancelled.', 'AbortError'));
      this.lifecycle.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([promise, stopped]);
    } finally {
      this.lifecycle.removeEventListener('abort', abort);
    }
  }
  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
    request?: { signal?: AbortSignal },
  ): Promise<TResult> {
    const signals = [
      this.lifecycle,
      AbortSignal.timeout(method === 'getUpdates' ? 30000 : 20000),
      ...(request?.signal ? [request.signal] : []),
    ];
    const signal = AbortSignal.any(signals);
    try {
      return await super.telegramFetch<TResult>(method, payload, { signal });
    } catch (error) {
      if (this.lifecycle.aborted || request?.signal?.aborted)
        throw new DOMException('Telegram connection cancelled.', 'AbortError');
      if (error instanceof AdapterRateLimitError) throw new AdapterRateLimitError('telegram', error.retryAfter);
      // eslint-disable-next-line preserve-caught-error -- SDK causes can contain token-bearing URLs.
      throw new Error('Telegram request failed. Check the bot token or connection and try again.');
    }
  }
  async sendPlain(group: string, text: string, quoteId?: string): Promise<string> {
    const thread = this.decodeThreadId(group);
    const reply = this.buildReplyParameters(quoteId, thread.chatId);
    const sent = await this.telegramFetch<TelegramMessage>('sendMessage', {
      ...this.buildChatTargetParams(thread),
      text,
      ...(reply ? { reply_parameters: reply } : {}),
    });
    if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0 || String(sent.chat.id) !== thread.chatId)
      throw new Error('Telegram did not confirm this message.');
    return this.encodeMessageId(thread.chatId, sent.message_id);
  }
  protected override async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.telegramFetch<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (
      !file.file_path ||
      !/^[A-Za-z0-9_./-]+$/.test(file.file_path) ||
      file.file_path.split('/').includes('..') ||
      file.file_path.startsWith('/') ||
      (file.file_size ?? 0) > MAX_FILE
    )
      throw new Error('Telegram attachment is unavailable or too large.');
    const token = await this.resolveBotToken();
    const signal = AbortSignal.any([this.lifecycle, AbortSignal.timeout(30000)]);
    try {
      const response = await fetch(`${API}/file/bot${token}/${file.file_path}`, { signal, redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_FILE || !response.body)
        throw new Error('unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > MAX_FILE) throw new Error('limit');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return Buffer.concat(chunks, bytes);
    } catch {
      throw new Error('Telegram attachment download failed or exceeded 16 MiB.');
    }
  }
}

@Injectable()
export class RoomTelegramTransport implements RoomMessagingTransport {
  readonly retryStableSends = false;
  readonly commandPrefix = '/';
  readonly entryCommand = 'room';
  readonly commandSeparator = '_' as const;
  readonly maxMessageLength = 4096;
  phase: RoomPhoneStatus['connection'] = 'disconnected';
  qr: string | null = null;
  error: string | null = null;
  readonly input: NonNullable<RoomPhoneStatus['input']> = {
    lastGroupAt: null,
    lastOwnGroupAt: null,
    lastAcceptedAt: null,
    ignoredHistory: 0,
  };
  receive: (message: PhoneMessage) => Promise<void> = async () => undefined;
  receipt: (id: string, status: number, group: string) => Promise<void> = async () => undefined;
  private verified: Identity | undefined;
  private adapter: RoomTelegramAdapter | undefined;
  private chat: Chat | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private connectCancel: { generation: number; cancel: () => void } | undefined;
  constructor(
    private readonly credentials: RoomTelegramCredentials,
    private readonly meta: MetaRepository,
  ) {}
  get account(): string | undefined {
    return this.verified?.id;
  }
  get commandSuffix(): string | undefined {
    return this.verified ? `@${this.verified.username}` : undefined;
  }
  details(): Pick<RoomChannelStatus, 'configured' | 'identity'> {
    return { configured: this.credentials.configured, ...(this.verified ? { identity: this.verified } : {}) };
  }
  createMessageId(): string {
    return randomUUID();
  }
  private logger(generation = this.generation): ChatLogger {
    const logger: ChatLogger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => {
        if (generation !== this.generation) return;
        this.error = 'Telegram polling is temporarily unavailable. Check the connection and local queue.';
      },
      error: () => {
        if (generation !== this.generation) return;
        this.error = 'Telegram could not process an update. Reconnect if the problem continues.';
      },
    };
    return logger;
  }
  private config(token: string, userName?: string): TelegramAdapterConfig {
    return {
      botToken: token,
      apiUrl: API,
      mode: 'polling',
      longPolling: {
        deleteWebhook: false,
        dropPendingUpdates: false,
        allowedUpdates: ['message'],
        timeout: 20,
        limit: 100,
        retryDelayMs: 1000,
      },
      businessMode: false,
      persistThreadHistory: false,
      mentionOnReply: true,
      allowedUserIds: [],
      longMessages: 'truncate',
      ...(userName ? { userName } : {}),
      logger: this.logger(),
    };
  }
  async configure(values: Record<string, string>): Promise<void> {
    const parsed = RoomTelegramCredentialsSchema.safeParse(values);
    if (!parsed.success) throw new BadRequestException('Enter a valid Telegram bot token from BotFather.');
    const input = parsed.data;
    await this.disconnect();
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const probe = new RoomTelegramAdapter(this.config(input.botToken), abort.signal, async () => undefined);
    try {
      const identity = await probe.identity();
      if (generation !== this.generation) throw new Error('cancelled');
      await this.credentials.save(input);
      if (generation === this.generation) {
        this.verified = identity;
        this.error = null;
      }
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error instanceof Error && error.message.startsWith('Enable group access with BotFather')) throw error;
      throw new BadRequestException(
        'Telegram token could not be verified or saved. Check BotFather and the operating system credential store.',
      );
    } finally {
      if (this.abort === abort) this.abort = undefined;
      abort.abort();
    }
  }
  async connect(): Promise<void> {
    if (this.phase === 'connected' || this.phase === 'connecting') return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.phase = 'connecting';
    this.error = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (generation === this.generation) {
          this.generation++;
          abort.abort();
          this.adapter = undefined;
          const chat = this.chat;
          this.chat = undefined;
          this.phase = 'error';
          this.error = 'Telegram connection timed out. Check the credential store and network, then reconnect.';
          void chat?.shutdown().catch(() => undefined);
        }
        reject(new Error('Telegram connection timed out. Reconnect and try again.'));
      }, 25000);
      timer.unref();
    });
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    this.connectCancel = { generation, cancel };
    try {
      await Promise.race([this.open(generation, abort), timeout, cancelled]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.connectCancel?.generation === generation) this.connectCancel = undefined;
    }
  }
  private async open(generation: number, abort: AbortController): Promise<void> {
    let ready: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (ready = resolve));
    try {
      const { botToken } = await this.credentials.read();
      if (generation !== this.generation) return;
      const adapter: RoomTelegramAdapter = new RoomTelegramAdapter(
        this.config(botToken),
        abort.signal,
        (update): Promise<void> => this.admit(adapter, update, generation),
        gate,
      );
      this.adapter = adapter;
      const identity = await adapter.identity();
      await adapter.checkPolling();
      if (generation !== this.generation) return;
      this.verified = identity;
      const chat = new Chat({
        userName: identity.username,
        adapters: { telegram: adapter },
        state: new RoomTelegramPollingState(this.meta, identity.id),
        concurrency: 'concurrent',
        logger: this.logger(),
      });
      this.chat = chat;
      await chat.initialize();
      if (generation !== this.generation) {
        await chat.shutdown();
        return;
      }
      this.phase = 'connected';
      this.error = null;
      ready();
      void adapter.installCommands().catch(() => {
        if (generation === this.generation)
          this.error = 'Telegram command menu could not be installed. Typed commands still work.';
      });
    } catch (error) {
      if (generation !== this.generation) return;
      abort.abort();
      const chat = this.chat;
      this.chat = undefined;
      this.adapter = undefined;
      await chat?.shutdown().catch(() => undefined);
      if (generation !== this.generation) return;
      this.phase = 'error';
      this.error =
        error instanceof Error &&
        (error.message.includes('already has a webhook') ||
          error.message.startsWith('Enable group access with BotFather'))
          ? error.message
          : 'Telegram could not connect. Check its saved bot token and network connection.';
      // eslint-disable-next-line preserve-caught-error -- Keep provider credentials and token URLs out of API error causes.
      throw new Error(this.error);
    }
  }
  async disconnect(): Promise<void> {
    this.generation++;
    this.connectCancel?.cancel();
    this.connectCancel = undefined;
    this.abort?.abort();
    this.abort = undefined;
    const chat = this.chat;
    this.chat = undefined;
    this.adapter = undefined;
    this.phase = 'disconnected';
    if (chat) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          chat.shutdown().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  async send(
    group: string,
    text: string,
    _id?: string,
    quote?: { id: string; sender: string; text: string },
  ): Promise<string> {
    const adapter = this.adapter;
    const generation = this.generation;
    if (!adapter || this.phase !== 'connected' || !/^telegram:-\d+(?::\d+)?$/.test(group))
      throw new Error('Connect Telegram and link a group before sending.');
    const body =
      text.length <= 4096
        ? text
        : `${text.slice(0, 2950).replace(/[\uD800-\uDBFF]$/, '')}\n\n[Open the room for the full update.]\n\n${text.slice(-1000).replace(/^[\uDC00-\uDFFF]/, '')}`;
    try {
      const id = await adapter.sendPlain(group, body, quote?.id);
      if (generation !== this.generation) throw new Error('cancelled');
      return id;
    } catch {
      throw new Error('Telegram could not confirm this send. Review it in the group before trying again.');
    }
  }
  async media(raw: string): Promise<Uint8Array> {
    const adapter = this.adapter;
    const generation = this.generation;
    if (!adapter || this.phase !== 'connected' || raw.length > 65536)
      throw new Error('Reconnect Telegram to download this attachment.');
    try {
      const parsed = JSON.parse(raw) as { account?: string; message?: TelegramMessage };
      if (
        parsed.account !== this.account ||
        !parsed.message ||
        !['group', 'supergroup'].includes(parsed.message.chat.type)
      )
        throw new Error('invalid');
      const message = adapter.parseMessage(parsed.message);
      if (message.attachments.length !== 1) throw new Error('count');
      const file = message.attachments[0];
      if (!file.fetchData || (file.size ?? 0) > MAX_FILE) throw new Error('size');
      const data = await file.fetchData();
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (generation !== this.generation || bytes.length > MAX_FILE) throw new Error('cancelled');
      return bytes;
    } catch {
      throw new Error('Telegram attachment could not be downloaded. Send one file smaller than 16 MiB.');
    }
  }
  private async admit(adapter: RoomTelegramAdapter, update: TelegramUpdate, generation: number): Promise<void> {
    if (generation !== this.generation || this.phase !== 'connected')
      throw new DOMException('Telegram connection cancelled.', 'AbortError');
    const raw = update.message as Incoming | undefined;
    if (
      !raw ||
      !['group', 'supergroup'].includes(raw.chat.type) ||
      !Number.isSafeInteger(raw.chat.id) ||
      raw.chat.id >= 0 ||
      !raw.from ||
      raw.from.is_bot ||
      !Number.isSafeInteger(raw.from.id) ||
      raw.from.id <= 0 ||
      raw.sender_chat ||
      raw.new_chat_members ||
      raw.left_chat_member ||
      raw.migrate_to_chat_id ||
      raw.migrate_from_chat_id
    )
      return;
    this.input.lastGroupAt = Date.now();
    if (!Number.isSafeInteger(raw.message_id) || raw.message_id <= 0 || !this.verified) return;
    const original = raw.text ?? raw.caption ?? '';
    if (original.length > 8000) return;
    const replay = (update as TelegramUpdate & { roomAdmission?: { account: string; username: string } }).roomAdmission;
    const username =
      replay && replay.account === this.account && /^[A-Za-z0-9_]{5,32}$/.test(replay.username)
        ? replay.username
        : this.verified.username;
    const command = /^\/([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_]+))?(?=\s|$)/.exec(original);
    if (command?.[2] && command[2].toLowerCase() !== username.toLowerCase()) return;
    let text = command ? original.replace(/^\/(\S+?)(?:@[A-Za-z0-9_]+)?(?=\s|$)/, `/${command[1]}`) : original;
    const entities = raw.entities ?? raw.caption_entities ?? [];
    const mentions = entities.filter(
      (entity) =>
        (entity.type === 'mention' &&
          original.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
            `@${username.toLowerCase()}`) ||
        (entity.type === 'text_mention' && String(entity.user?.id) === this.account),
    );
    const reply = raw.reply_to_message && String(raw.reply_to_message.from?.id) === this.account;
    if (!command && !mentions.length && !reply) return;
    if (!command)
      for (const entity of [...mentions].sort((a, b) => b.offset - a.offset))
        text = text.slice(0, entity.offset) + text.slice(entity.offset + entity.length);
    text = text.trim();
    if ((raw.forward_origin || raw.forward_from || raw.forward_from_chat) && text.startsWith('/')) return;
    if (/^\/room(?=\s|$)/.test(text)) {
      const question = text.slice(5).trim();
      text = question ? `Owner asks: ${question}` : '/help';
    }
    if (/^\/(?:room_link|start)\s+[a-f0-9]{24}$/.test(text))
      text = text.replace(/^\/(?:room_link|start)/, '/room-link');
    else text = text.replace(/^\/room_test(?=\s|$)/, '/room-test');
    // Public parseMessage treats any message_thread_id as a topic. Regular
    // reply chains must retain the group's canonical conversation identity.
    const normalized = { ...raw, ...(!raw.is_topic_message ? { message_thread_id: undefined } : {}) };
    const message = adapter.parseMessage(normalized);
    let files = message.attachments.map((file) => ({
      name: file.name ?? `attachment-${raw.message_id}`,
      mime: file.mimeType ?? 'application/octet-stream',
      size: file.size ?? 0,
      type: file.type,
    }));
    let metadata: string | undefined;
    if (files.length) {
      metadata = JSON.stringify({ account: this.account, message: normalized });
      if (files.length > 1 || files.some((file) => file.size > MAX_FILE) || metadata.length > 65536) {
        files = [];
        metadata = undefined;
        text = text.slice(0, 7850) + '\n[Telegram attachment was not imported. Send one file smaller than 16 MiB.]';
      }
    }
    if (!text && !files.length) return;
    const quoteId = raw.reply_to_message ? `${raw.chat.id}:${raw.reply_to_message.message_id}` : undefined;
    (update as TelegramUpdate & { roomAdmission?: { account: string; username: string } }).roomAdmission = {
      account: this.verified.id,
      username,
    };
    await this.receive({
      id: message.id,
      group: message.threadId,
      sender: String(raw.from.id),
      senderName: [raw.from.first_name, raw.from.last_name].filter(Boolean).join(' '),
      groupName: raw.chat.title ?? '',
      text,
      ...(quoteId ? { quoteId } : {}),
      ...(files.length ? { raw: metadata, files } : {}),
    });
    if (generation !== this.generation) throw new DOMException('Telegram connection cancelled.', 'AbortError');
    this.input.lastAcceptedAt = Date.now();
  }
}
