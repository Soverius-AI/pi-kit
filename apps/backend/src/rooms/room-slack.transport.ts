import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Agent } from 'node:https';
import type { Chat, Logger as ChatLogger } from 'chat';
import type { SlackAdapter, SlackAdapterConfig } from '@chat-adapter/slack';
import type { RoomPhoneStatus } from '@pi-kit/protocol';
import { z } from 'zod';
import type { RoomMessagingTransport } from './room-messaging.transport';
import type { PhoneMessage } from './room-phone.types';
import { MetaRepository } from '../db/meta.repository';
import { RoomSlackCredentials, RoomSlackCredentialsSchema } from './room-slack-credentials';

const SlackId = /^[A-Z][A-Z0-9]{1,40}$/;
const Timestamp = /^\d{1,20}\.\d{6}$/;
const Envelope = z.object({
  team_id: z.string().regex(SlackId),
  event_id: z.string().min(1).max(200),
  event: z.object({
    type: z.enum(['message', 'app_mention']),
    subtype: z.string().optional(),
    channel: z.string().regex(/^[CG][A-Z0-9]{1,40}$/),
    channel_type: z.string().optional(),
    user: z.string().regex(/^[UW][A-Z0-9]{1,40}$/),
    ts: z.string().regex(Timestamp),
    team: z.string().optional(),
    text: z.string().max(8000).default(''),
    thread_ts: z.string().regex(Timestamp).optional(),
    bot_id: z.string().optional(),
    bot_profile: z.unknown().optional(),
    files: z.array(z.unknown()).optional(),
  }),
});
const SlackFile = z.object({
  id: z.string().max(100),
  name: z.string().max(500).optional(),
  mimetype: z.string().max(200).optional(),
  size: z
    .number()
    .nonnegative()
    .max(16 * 1024 * 1024),
  url_private: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'files.slack.com';
    }),
});
const Media = z.object({ team: z.string().regex(SlackId), url: z.string().url() }).strict();

export class RoomSlackSdk {
  static async load() {
    const [chat, slack, state, shared, socket] = await Promise.all([
      import('chat'),
      import('@chat-adapter/slack'),
      import('@chat-adapter/state-memory'),
      import('@chat-adapter/shared'),
      import('@slack/socket-mode'),
    ]);
    return {
      Chat: chat.Chat,
      SlackAdapter: slack.SlackAdapter,
      createMemoryState: state.createMemoryState,
      downloadAttachment: shared.downloadAttachment,
      SocketModeClient: socket.SocketModeClient,
      LogLevel: socket.LogLevel,
    };
  }
}

/** Closing a connection also refuses a late Socket Mode handshake after cancelled HTTP authentication. */
export class RoomSlackConnectionAgent extends Agent {
  private ended = false;
  override createConnection(...args: Parameters<Agent['createConnection']>): ReturnType<Agent['createConnection']> {
    if (this.ended) throw new Error('Slack connection was cancelled.');
    return super.createConnection(...args);
  }
  close(): void {
    this.ended = true;
    this.destroy();
  }
}

type SlackSocketRuntime = Pick<Awaited<ReturnType<typeof RoomSlackSdk.load>>, 'SocketModeClient' | 'LogLevel'> & {
  state(state: 'connected' | 'disconnected' | 'error'): void;
};

/** Use public Slack Socket Mode options: Vercel's default path deliberately drops timeout/retry settings. */
export function createRoomSlackAdapter(
  Base: typeof import('@chat-adapter/slack').SlackAdapter,
  config: SlackAdapterConfig,
  receive: (body: Record<string, unknown>) => Promise<void>,
  runtime?: SlackSocketRuntime,
) {
  return new (class extends Base {
    private roomSocket?: import('@slack/socket-mode').SocketModeClient;
    protected override async startSocketMode(): Promise<void> {
      if (!runtime) return super.startSocketMode();
      const logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        getLevel: () => runtime.LogLevel.ERROR,
        setLevel: () => undefined,
        setName: () => undefined,
      };
      const socket = (this.roomSocket = new runtime.SocketModeClient({
        appToken: config.appToken ?? '',
        autoReconnectEnabled: false,
        logger,
        clientOptions: {
          agent: config.webClientOptions?.agent,
          timeout: 15000,
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
        },
      }));
      socket.on(
        'slack_event',
        async ({ body, type, ack }: { body: Record<string, unknown>; type: string; ack: () => Promise<void> }) => {
          await this.routeSocketEvent(body, type, ack);
        },
      );
      socket.on('connected', () => runtime.state('connected'));
      socket.on('disconnected', () => runtime.state('disconnected'));
      socket.on('error', () => runtime.state('error'));
      await socket.start();
    }
    override async disconnect(): Promise<void> {
      const socket = this.roomSocket;
      this.roomSocket = undefined;
      await Promise.allSettled([socket?.disconnect(), super.disconnect()]);
    }
    protected override async routeSocketEvent(
      body: Record<string, unknown>,
      eventType: string,
      ack: () => Promise<void>,
    ): Promise<void> {
      if (eventType === 'events_api') {
        try {
          await receive(body);
        } catch {
          return;
        } // No ACK: durable admission may be retried.
      }
      try {
        await ack();
      } catch {
        /* Already saved; a late ACK failure is safe to retry. */
      }
    }
  })(config);
}

@Injectable()
export class RoomSlackTransport implements RoomMessagingTransport {
  phase: RoomPhoneStatus['connection'] = 'disconnected';
  qr: string | null = null;
  error: string | null = null;
  readonly commandPrefix = '!';
  readonly retryStableSends = false;
  readonly input = {
    lastGroupAt: null as number | null,
    lastOwnGroupAt: null as number | null,
    lastAcceptedAt: null as number | null,
    ignoredHistory: 0,
  };
  receive: (message: PhoneMessage) => Promise<void> = async () => undefined;
  receipt: (id: string, status: number, group: string) => Promise<void> = async () => undefined;
  private adapter?: SlackAdapter;
  private chat?: Chat;
  private identity?: { team: string; user: string };
  private botToken?: string;
  private generation = 0;
  private admissionEpoch = 0;
  private readonly roots = new Map<string, string>();
  private rootWrites: Promise<void> = Promise.resolve();
  private pendingConnect?: Promise<void>;
  private cancelConnect?: () => void;
  private connectionAgent?: RoomSlackConnectionAgent;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private hasConnected = false;
  private stopped = true;
  get account(): string | undefined {
    return this.identity ? `${this.identity.team}:${this.identity.user}` : undefined;
  }
  constructor(
    private readonly credentials: RoomSlackCredentials,
    private readonly meta: MetaRepository,
  ) {}
  details() {
    return { configured: this.credentials.configured };
  }
  createMessageId(): string {
    return randomUUID();
  }
  async configure(values: Record<string, string>): Promise<void> {
    const parsed = RoomSlackCredentialsSchema.safeParse(values);
    if (!parsed.success) throw new BadRequestException('Provide a valid xapp app token and xoxb bot token.');
    try {
      const sdk = await RoomSlackSdk.load();
      const adapter = new sdk.SlackAdapter({
        mode: 'socket',
        ...parsed.data,
        logger: this.logger(),
        webClientOptions: { timeout: 15000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
      });
      await this.authenticate(adapter);
      await this.credentials.save(parsed.data);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new BadRequestException('Slack could not verify the bot token. Check the app installation and scopes.');
    }
    await this.disconnect();
  }
  async connect(): Promise<void> {
    this.stopped = false;
    if (this.pendingConnect) return this.pendingConnect;
    if (this.adapter && this.phase === 'connected') return;
    const pending = this.beginConnection();
    this.pendingConnect = pending;
    try {
      await pending;
    } finally {
      if (this.pendingConnect === pending) this.pendingConnect = undefined;
    }
  }
  private async beginConnection(): Promise<void> {
    if (this.adapter) await this.close();
    const generation = ++this.generation;
    this.phase = 'connecting';
    this.error = null;
    const agent = (this.connectionAgent = new RoomSlackConnectionAgent({ keepAlive: true }));
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const cancel = () => rejectCancelled(new Error('Slack connection cancelled.'));
    this.cancelConnect = cancel;
    const timer = setTimeout(() => rejectCancelled(new Error('Slack connection timed out.')), 20000);
    timer.unref();
    try {
      await Promise.race([this.open(generation, agent), cancelled]);
      if (generation === this.generation) {
        this.hasConnected = true;
        this.reconnectAttempts = 0;
      }
    } catch {
      if (generation !== this.generation) return;
      await this.close();
      this.phase = 'error';
      this.error =
        'Slack could not connect within 20 seconds. Check the saved tokens, Socket Mode, app installation and credential store.';
      if (this.hasConnected && !this.stopped) this.scheduleReconnect();
      throw new ConflictException(this.error);
    } finally {
      clearTimeout(timer);
      if (this.cancelConnect === cancel) this.cancelConnect = undefined;
    }
  }
  private async open(generation: number, agent: RoomSlackConnectionAgent): Promise<void> {
    const [sdk, tokens] = await Promise.all([RoomSlackSdk.load(), this.credentials.read()]);
    if (generation !== this.generation) return;
    const adapter = createRoomSlackAdapter(
      sdk.SlackAdapter,
      {
        mode: 'socket',
        ...tokens,
        logger: this.logger(),
        webClientOptions: { agent, timeout: 15000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
      },
      async (body) => {
        const epoch = this.admissionEpoch,
          account = this.account;
        try {
          this.requireAdmission(generation, epoch, account);
          await this.admit(body, generation, epoch, account);
          this.requireAdmission(generation, epoch, account);
        } catch {
          if (this.currentAdmission(generation, epoch, account))
            this.error = 'Slack could not durably accept a channel message. Slack may retry it.';
          throw new Error('Slack input was not durably accepted. It may be retried.');
        }
      },
      {
        ...sdk,
        state: (state) => {
          if (generation !== this.generation) return;
          if (state === 'connected') {
            this.phase = 'connected';
            this.error = null;
          } else {
            this.admissionEpoch++;
            this.phase = 'connecting';
            this.error = 'Slack disconnected. Reconnecting.';
            if (this.hasConnected) this.scheduleReconnect();
          }
        },
      },
    );
    const identity = await this.authenticate(adapter);
    if (generation !== this.generation) return;
    const saved = z
      .array(z.tuple([z.string().regex(/^[CG][A-Z0-9]{1,40}:\d{1,20}\.\d{6}$/), z.string().regex(Timestamp)]))
      .max(512)
      .safeParse(await this.meta.getSetting(`rooms.slack.threads.${identity.team}:${identity.user}`));
    if (generation !== this.generation) return;
    this.identity = identity;
    this.roots.clear();
    if (saved.success) for (const [key, value] of saved.data) this.roots.set(key, value);
    this.botToken = tokens.botToken;
    this.adapter = adapter;
    const chat = new sdk.Chat({
      userName: 'pi-kit',
      adapters: { slack: adapter },
      state: sdk.createMemoryState(),
      concurrency: 'concurrent',
      logger: this.logger(),
    });
    this.chat = chat;
    await chat.initialize();
    if (generation !== this.generation) {
      await Promise.allSettled([adapter.disconnect(), chat.shutdown()]);
      return;
    }
    this.phase = 'connected';
    this.error = null;
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const generation = this.generation;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        void (async () => {
          if (generation !== this.generation || this.stopped) return;
          await this.close();
          if (!this.stopped) await this.connect();
        })().catch(() => undefined);
      },
      Math.min(60000, 5000 * 2 ** Math.min(this.reconnectAttempts++, 4)),
    );
    this.reconnectTimer.unref();
  }
  private async authenticate(adapter: SlackAdapter): Promise<{ team: string; user: string }> {
    const result = await adapter.webClient.auth.test();
    if (
      !result.ok ||
      !result.bot_id ||
      !result.team_id ||
      !SlackId.test(result.team_id) ||
      !result.user_id ||
      !SlackId.test(result.user_id)
    )
      throw new Error('Slack bot authentication failed.');
    return { team: result.team_id, user: result.user_id };
  }
  private currentAdmission(generation: number, epoch: number, account: string | undefined): boolean {
    return (
      generation === this.generation &&
      epoch === this.admissionEpoch &&
      this.phase === 'connected' &&
      account !== undefined &&
      account === this.account
    );
  }
  private requireAdmission(generation: number, epoch: number, account: string | undefined): void {
    if (!this.currentAdmission(generation, epoch, account))
      throw new Error('Slack connection changed before durable admission.');
  }
  private async admit(
    body: Record<string, unknown>,
    generation: number,
    epoch: number,
    account: string | undefined,
  ): Promise<void> {
    const parsed = Envelope.safeParse(body);
    if (!parsed.success || !this.identity) return;
    const { event, team_id: team, event_id: sourceId } = parsed.data;
    if (
      team !== this.identity.team ||
      (event.team && event.team !== team) ||
      event.user === this.identity.user ||
      event.bot_id ||
      event.bot_profile ||
      (event.subtype && event.subtype !== 'file_share') ||
      (event.channel_type && !['channel', 'group'].includes(event.channel_type))
    )
      return;
    this.input.lastGroupAt = Date.now();
    const acceptedFiles = (event.files ?? [])
      .slice(0, 10)
      .flatMap((value) => {
        const file = SlackFile.safeParse(value);
        return file.success ? [file.data] : [];
      })
      .slice(0, 1);
    const text = (
      event.text.trim() +
      ((event.files?.length ?? 0) > acceptedFiles.length
        ? '\n[Send one Slack attachment per message, up to 16 MiB. The message text was retained.]'
        : '')
    ).slice(0, 8000);
    const files = acceptedFiles.map((file) => ({
      name: file.name ?? file.id,
      mime: file.mimetype ?? 'application/octet-stream',
      size: file.size,
      type: file.mimetype?.startsWith('audio/') ? 'audio' : 'file',
    }));
    if (!text && !files.length) return;
    // Channel identity is stable across Slack subthreads; common authorization/deduplication owns all admission.
    this.roots.set(`${event.channel}:${event.ts}`, event.thread_ts ?? event.ts);
    while (this.roots.size > 512) this.roots.delete(this.roots.keys().next().value as string);
    // Persist quote roots before admitting work so recovered replies stay in their Slack thread.
    const snapshot = [...this.roots.entries()];
    const key = this.rootKey();
    const write = this.rootWrites.catch(() => undefined).then(() => this.meta.setSetting(key, snapshot));
    this.rootWrites = write;
    await write;
    const groupName = event.channel;
    this.requireAdmission(generation, epoch, account);
    await this.receive({
      id: event.ts,
      group: event.channel,
      sender: event.user,
      senderName: event.user,
      groupName,
      text,
      ...(event.thread_ts ? { quoteId: event.thread_ts } : {}),
      ...(files.length ? { files, raw: JSON.stringify({ team, sourceId, files: acceptedFiles }) } : {}),
    });
    this.requireAdmission(generation, epoch, account);
    this.input.lastAcceptedAt = Date.now();
  }
  async send(
    group: string,
    text: string,
    id = this.createMessageId(),
    quote?: { id: string; sender: string; text: string },
  ): Promise<string> {
    if (!this.adapter || this.phase !== 'connected') throw new ConflictException('Slack is disconnected.');
    if (!/^[CG][A-Z0-9]{1,40}$/.test(group) || !z.string().uuid().safeParse(id).success)
      throw new BadRequestException('Invalid Slack channel or delivery identity.');
    const root = quote ? this.roots.get(`${group}:${quote.id}`) : undefined;
    const message = {
      channel: group,
      text: text.slice(0, 12000),
      client_msg_id: id,
      ...(root ? { thread_ts: root } : {}),
      unfurl_links: false,
      unfurl_media: false,
    };
    const result = await this.adapter.webClient.chat.postMessage(message);
    if (!result.ok || !result.ts || !Timestamp.test(result.ts))
      throw new Error('Slack did not confirm message acceptance.');
    return result.ts;
  }
  private rootKey(): string {
    return `rooms.slack.threads.${this.account ?? 'disconnected'}`;
  }
  async media(raw: string): Promise<Uint8Array> {
    if (raw.length > 65536) throw new BadRequestException('Invalid Slack attachment metadata.');
    if (!this.adapter || !this.identity || !this.botToken)
      throw new ConflictException('Reconnect Slack to read attachments.');
    const value = JSON.parse(raw) as { team?: unknown; files?: unknown };
    const files = z
      .array(z.object({ url_private: z.string().url() }))
      .length(1)
      .parse(value.files);
    const media = Media.parse({ team: value.team, url: files[0].url_private });
    if (media.team !== this.identity.team || new URL(media.url).hostname !== 'files.slack.com')
      throw new BadRequestException('This attachment is not from the connected Slack workspace.');
    const { downloadAttachment } = await RoomSlackSdk.load();
    return downloadAttachment(media.url, {
      adapter: 'slack',
      hosts: ['files.slack.com'],
      headers: { authorization: `Bearer ${this.botToken}` },
      limit: 16 * 1024 * 1024,
      redirects: 0,
      timeoutMs: 30000,
    });
  }
  async disconnect(): Promise<void> {
    this.stopped = true;
    this.hasConnected = false;
    await this.close();
  }
  private async close(): Promise<void> {
    ++this.generation;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    this.pendingConnect = undefined;
    this.connectionAgent?.close();
    this.connectionAgent = undefined;
    const adapter = this.adapter,
      chat = this.chat;
    this.adapter = undefined;
    this.chat = undefined;
    this.identity = undefined;
    this.botToken = undefined;
    this.roots.clear();
    this.phase = 'disconnected';
    this.qr = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([adapter?.disconnect(), chat?.shutdown()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private logger(generation = this.generation): ChatLogger {
    const logger: ChatLogger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        if (generation !== this.generation || this.stopped) return;
        this.error = 'Slack encountered a connection error.';
      },
    };
    return logger;
  }
}
