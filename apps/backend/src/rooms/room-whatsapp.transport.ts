import { Inject, Injectable } from '@nestjs/common';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Chat, Logger as ChatLogger, Message } from 'chat';
import type { BaileysAdapter } from 'chat-adapter-baileys';
import type { WAMessage } from 'baileys';
import type { RoomPhoneStatus } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';

export interface PhoneMessage {
  id: string;
  group: string;
  sender: string;
  senderName: string;
  groupName: string;
  text: string;
  quoteId?: string;
  raw?: string;
  files?: { name: string; mime: string; size: number; type: string }[];
}

/** One host-owned WhatsApp account, either the owner or a separate assistant. Durable routing lives outside the SDK's transient state. */
@Injectable()
export class RoomWhatsAppTransport {
  phase: RoomPhoneStatus['connection'] = 'disconnected';
  qr: string | null = null;
  error: string | null = null;
  readonly input = {
    lastGroupAt: null as number | null,
    lastOwnGroupAt: null as number | null,
    lastAcceptedAt: null as number | null,
    ignoredHistory: 0,
  };
  receive: (message: PhoneMessage) => Promise<void> = async () => undefined;
  receipt: (id: string, status: number, group: string) => Promise<void> = async () => undefined;
  private revive: ((key: string, value: unknown) => unknown) | undefined;
  private adapter: BaileysAdapter | undefined;
  private chat: Chat | undefined;
  private generation = 0;

  get account(): string | undefined {
    return this.adapter?.botUserId?.replace(/:\d+@/, '@');
  }

  constructor(@Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir'>) {}

  async connect(): Promise<void> {
    if (this.adapter) return;
    const generation = ++this.generation;
    this.phase = 'connecting';
    this.error = null;
    try {
      const [{ Chat }, { createBaileysAdapter }, { createMemoryState }, baileys] = await Promise.all([
        import('chat'),
        import('chat-adapter-baileys'),
        import('@chat-adapter/state-memory'),
        import('baileys'),
      ]);
      const folder = join(this.config.dataDir, 'room-whatsapp-auth');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const auth = await baileys.useMultiFileAuthState(folder);
      this.revive = baileys.BufferJSON.reviver;
      const protectFiles = async () => {
        for (const name of await readdir(folder))
          await chmod(join(folder, name), 0o600).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
      };
      await protectFiles();
      if (generation !== this.generation) return;
      const setKeys = auth.state.keys.set.bind(auth.state.keys);
      auth.state.keys.set = async (data) => {
        if (generation !== this.generation) return;
        await setKeys(data);
        await protectFiles();
      };
      const ownMessage = (message: Message) => receive(undefined, message, true);
      this.adapter = createBaileysAdapter({
        auth: {
          state: auth.state,
          saveCreds: async () => {
            if (generation !== this.generation) return;
            await auth.saveCreds();
            await protectFiles();
          },
        },
        userName: 'pi-kit',
        onMessageBatch: (batch) => {
          if (generation !== this.generation) return;
          const now = Date.now();
          if (batch.groups) this.input.lastGroupAt = now;
          if (batch.ownGroups) this.input.lastOwnGroupAt = now;
          if (batch.type !== 'notify') this.input.ignoredHistory += batch.groups;
        },
        onOwnMessage: async (message) => {
          if (generation !== this.generation) return;
          try {
            await ownMessage(message);
          } catch {
            this.error = 'WhatsApp could not process a group message. Try again or reconnect.';
          }
        },
        onConnectionUpdate: (update) => {
          if (generation !== this.generation) return;
          if (update.connection === 'open') {
            this.phase = 'connected';
            this.qr = null;
            this.error = null;
          } else if (update.connection === 'close') {
            this.phase = update.loggedOut ? 'disconnected' : 'connecting';
            this.qr = null;
            if (update.loggedOut) this.error = 'Link WhatsApp again from Linked devices.';
          }
        },
        onDelivery: async (update) => {
          if (generation === this.generation) await this.receipt(update.id, update.status, update.threadId);
        },
        onQR: (qr) => {
          if (generation !== this.generation) return;
          this.qr = qr;
          this.phase = 'qr';
        },
        // Suppress protocol logs, which may contain account details or message content.
        socketOptions: {
          syncFullHistory: false,
          shouldSyncHistoryMessage: () => false,
          logger: Object.assign(baileys.DEFAULT_CONNECTION_CONFIG.logger.child({}), { level: 'silent' }),
        },
      });
      this.chat = new Chat({
        userName: 'pi-kit',
        adapters: { whatsapp: this.adapter },
        state: createMemoryState(),
        // Each handler only enqueues durably. Do not drop/coalesce overlapping owner messages.
        concurrency: 'concurrent',
        logger: this.lifecycleLogger(generation),
      });
      const receive = async (_thread: unknown, message: Message, own = false) => {
        if (generation !== this.generation) return;
        const raw = message.raw as { key?: { fromMe?: boolean; remoteJid?: string } };
        if (!raw.key?.remoteJid?.endsWith('@g.us')) return;
        // Only the adapter's live own-group callback may admit fromMe. Chat intentionally skips isMe messages.
        if (own ? !raw.key.fromMe || !this.account : message.author.isMe || raw.key.fromMe) return;
        const sender = own ? this.account : message.author.userId.replace(/:\d+@/, '@');
        if (!sender) return;
        const text = message.text.trim();
        const files = (message.attachments ?? []).map((file) => ({
          name: file.name ?? `${file.type}-${message.id}`,
          mime: file.mimeType ?? 'application/octet-stream',
          size: file.size ?? 0,
          type: file.type,
        }));
        if ((!text && !files.length) || text.length > 8000) return;
        const content = baileys.extractMessageContent((message.raw as WAMessage).message);
        const context = Object.values(content ?? {}).find(
          (value) => value && typeof value === 'object' && 'contextInfo' in value,
        ) as { contextInfo?: { stanzaId?: string } } | undefined;
        const groupName = text.startsWith('/room-link ') ? await this.groupName(message.threadId) : '';
        if (generation !== this.generation) return;
        this.input.lastAcceptedAt = Date.now();
        await this.receive({
          id: message.id,
          group: message.threadId,
          sender,
          senderName: message.author.fullName || message.author.userName,
          groupName,
          text,
          ...(context?.contextInfo?.stanzaId ? { quoteId: context.contextInfo.stanzaId } : {}),
          ...(files.length ? { files, raw: JSON.stringify(message.raw, baileys.BufferJSON.replacer) } : {}),
        });
      };
      const handler = async (thread: unknown, message: Message) => receive(thread, message);
      this.chat.onNewMessage(/[\s\S]*/, handler);
      this.chat.onNewMention(handler);
      this.chat.onSubscribedMessage(handler);
      await this.chat.initialize();
      await this.adapter.connect();
    } catch (error) {
      if (generation !== this.generation) return;
      await this.disconnect();
      this.phase = 'error';
      this.error = 'WhatsApp could not connect. Try reconnecting.';
      throw error;
    }
  }

  async send(
    group: string,
    text: string,
    id?: string,
    quote?: { id: string; sender: string; text: string },
  ): Promise<string> {
    if (!this.adapter || this.phase !== 'connected') throw new Error('WhatsApp is disconnected.');
    // Bound output size avoids implicit multi-message sends with ambiguous partial delivery.
    const body = text.length > 12000 ? `${text.slice(0, 11900)}\n\n[Open the room for the full reply.]` : text;
    const sent = await this.deadline(
      id ? this.adapter.sendText(group, body, id, quote) : this.adapter.postMessage(group, body),
    );
    return sent.id;
  }

  async media(raw: string): Promise<Uint8Array> {
    if (!this.adapter || !this.revive) throw new Error('Reconnect WhatsApp to download this attachment.');
    return this.deadline(this.adapter.fetchMedia(JSON.parse(raw, this.revive), 16 * 1024 * 1024));
  }

  private async groupName(thread: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.adapter
          ?.fetchThread(thread)
          .then((value) => value.channelName ?? '')
          .catch(() => '') ?? Promise.resolve(''),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(''), 2000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private deadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('WhatsApp operation timed out.')), 45000);
      timer.unref();
    });
    return Promise.race([operation, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async disconnect(): Promise<void> {
    this.generation++;
    await this.adapter?.disconnect();
    await this.chat?.shutdown();
    this.adapter = undefined;
    this.chat = undefined;
    this.phase = 'disconnected';
    this.qr = null;
  }

  private lifecycleLogger(generation: number): ChatLogger {
    // Protocol content and credentials must never enter application logs. Connection status uses the patched lifecycle callback.
    const logger: ChatLogger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        if (generation === this.generation) this.error = 'WhatsApp encountered a connection or message error.';
      },
    };
    return logger;
  }
}
