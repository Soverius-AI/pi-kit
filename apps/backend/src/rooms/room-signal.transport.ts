import { Inject, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Chat, Logger as ChatLogger, Message } from 'chat';
import type { SignalAdapter, SignalEnvelope } from '@stibbons/chat-adapter-signal';
import type { RoomChannelStatus, RoomPhoneStatus } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import type { RoomMessagingTransport } from './room-messaging.transport';
import type { PhoneMessage } from './room-phone.types';
import { SignalCliClient } from './room-signal-client';

const run = promisify(execFile);
const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALL = 'Install signal-cli 0.14.10 or newer (macOS: brew install signal-cli), or choose its executable path.';
type Dependency = NonNullable<RoomChannelStatus['dependency']>;

export function supportedSignalVersion(version: string): boolean {
  const found = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version);
  if (!found) return false;
  const [major, minor, patch] = found.slice(1).map(Number);
  return major > 0 || minor > 14 || (minor === 14 && patch >= 10);
}

@Injectable()
export class RoomSignalTransport implements RoomMessagingTransport {
  readonly retryStableSends = true;
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
  private linkedAccount: string | undefined;
  private adapter: SignalAdapter | undefined;
  private chat: Chat | undefined;
  private provisioning: SignalCliClient | undefined;
  private generation = 0;
  private lastTimestamp = 0;
  private connectedAfter = 0;
  private dependency: Dependency = { available: false, version: null, path: null, error: INSTALL };
  private abort: AbortController | undefined;

  constructor(@Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir'>) {}
  get account(): string | undefined {
    return this.linkedAccount;
  }
  private get folder(): string {
    return join(this.config.dataDir, 'room-signal-auth');
  }

  details(): Pick<RoomChannelStatus, 'configured' | 'dependency'> {
    return { configured: this.linkedAccount !== undefined, dependency: this.dependency };
  }
  createMessageId(): string {
    if (!this.account) throw new Error('Connect Signal before sending.');
    this.lastTimestamp = Math.max(Date.now() - 1000, this.lastTimestamp + 1);
    return `${this.account}:${this.lastTimestamp}`;
  }
  async configure(values: Record<string, string>): Promise<void> {
    if (Object.keys(values).some((key) => key !== 'binaryPath'))
      throw new Error('Signal only accepts an executable path. No account keys are needed.');
    const binaryPath = values['binaryPath']?.trim() ?? '';
    if (binaryPath && (!isAbsolute(binaryPath) || binaryPath.includes('\0')))
      throw new Error('Choose an absolute path to the signal-cli executable.');
    await this.disconnect();
    await this.ensureFolder();
    await writeFile(join(this.folder, 'pi-kit-settings.json'), JSON.stringify({ binaryPath }), { mode: 0o600 });
    await chmod(join(this.folder, 'pi-kit-settings.json'), 0o600);
    this.dependency = { available: false, version: null, path: binaryPath || null, error: INSTALL };
  }

  async connect(): Promise<void> {
    if (this.phase === 'connecting' || this.phase === 'qr' || this.phase === 'connected') return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.phase = 'connecting';
    this.qr = null;
    this.error = null;
    try {
      await this.ensureFolder();
      const binary = await this.findBinary(abort.signal);
      if (generation !== this.generation) return;
      const client = new SignalCliClient();
      this.provisioning = client;
      await client.start(binary, this.folder);
      if (generation !== this.generation) {
        await client.close();
        return;
      }
      const accounts = await client.request<{ aci?: string; number?: string | null }[]>('listAccounts');
      const known = accounts.filter((account) => typeof account.aci === 'string' && ACI.test(account.aci));
      if (known.length > 1)
        throw new Error(
          'Several Signal accounts exist in the room profile. Choose a dedicated profile before reconnecting.',
        );
      if (known[0]?.aci) {
        this.linkedAccount = known[0].aci.toLowerCase();
        await client.close();
        if (this.provisioning === client) this.provisioning = undefined;
        await this.startAdapter(binary, generation);
        return;
      }
      const link = await client.request<{ deviceLinkUri?: string }>('startLink');
      if (generation !== this.generation) return;
      if (
        typeof link.deviceLinkUri !== 'string' ||
        !link.deviceLinkUri.startsWith('sgnl://linkdevice?') ||
        link.deviceLinkUri.length > 4096
      )
        throw new Error('Signal did not return a valid device-link QR code.');
      this.qr = link.deviceLinkUri;
      this.phase = 'qr';
      // finishLink waits for the primary device. Returning now makes its QR available immediately.
      void client
        .request<{ aci?: string; number?: string | null }>(
          'finishLink',
          { deviceLinkUri: link.deviceLinkUri, deviceName: 'pi-kit Rooms' },
          180000,
        )
        .then(async (linked) => {
          if (generation !== this.generation) return;
          if (!linked.aci || !ACI.test(linked.aci))
            throw new Error('Signal did not return the linked account identifier.');
          this.linkedAccount = linked.aci.toLowerCase();
          await client.close();
          if (this.provisioning === client) this.provisioning = undefined;
          await this.startAdapter(binary, generation);
        })
        .catch(async () => {
          if (!(await this.closeRuntime(generation))) return;
          this.phase = 'error';
          this.qr = null;
          this.error = 'Signal device linking failed or expired. Reconnect to scan a new QR code.';
        });
    } catch {
      if (!(await this.closeRuntime(generation))) return;
      this.phase = 'error';
      this.qr = null;
      this.error = this.dependency.available
        ? 'Signal could not connect. Check its local executable and reconnect.'
        : (this.dependency.error ?? INSTALL);
      // Do not expose signal-cli's raw errors, which may include account details.
      throw new Error(this.error);
    }
  }

  private async closeRuntime(generation: number): Promise<boolean> {
    if (generation !== this.generation) return false;
    const client = this.provisioning;
    this.provisioning = undefined;
    const chat = this.chat;
    this.chat = undefined;
    this.adapter = undefined;
    await client?.close();
    await chat?.shutdown().catch(() => undefined);
    return generation === this.generation;
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    const client = this.provisioning;
    this.provisioning = undefined;
    const chat = this.chat;
    this.chat = undefined;
    this.adapter = undefined;
    this.phase = 'disconnected';
    this.qr = null;
    await client?.close();
    await chat?.shutdown().catch(() => undefined);
  }

  async send(
    group: string,
    text: string,
    id = this.createMessageId(),
    quote?: { id: string; sender: string; text: string },
  ): Promise<string> {
    const adapter = this.adapter;
    const account = this.account;
    if (!adapter || !account || this.phase !== 'connected') throw new Error('Signal is disconnected.');
    if (!/^signal:group:[A-Za-z0-9_-]{43}$/.test(group))
      throw new Error('Signal room messages require a Groups v2 conversation.');
    const match = /^(.*):(\d+)$/.exec(id);
    if (!match || match[1] !== account || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0)
      throw new Error('Signal delivery identity is invalid.');
    const generation = this.generation;
    // One bounded message, avoiding partial multi-message effects during retry.
    const body =
      Buffer.byteLength(text, 'utf8') <= 12000
        ? text
        : Buffer.from(text).subarray(0, 11800).toString('utf8') + '\n\n[Open the room for the full reply.]';
    try {
      const sent = await this.bounded(
        adapter.postMessageWithTimestamp(
          group,
          body,
          Number(match[2]),
          quote ? { id: quote.id, text: quote.text } : undefined,
        ),
        generation,
      );
      if (generation !== this.generation) throw new Error('Signal connection changed while sending.');
      if (sent.id !== id) throw new Error('Signal did not preserve the reserved delivery identity.');
      const result = sent.raw as { results?: { type?: string }[] };
      if (!Array.isArray(result.results) || result.results.some((item) => item.type !== 'SUCCESS'))
        throw new Error('Signal did not confirm every group recipient.');
      // A successful send is truthful; the SDK currently exposes no per-recipient delivery/read callback.
      return sent.id;
    } catch {
      throw new Error('Signal could not confirm this send. Review or retry the same reserved message.');
    }
  }

  async media(raw: string): Promise<Uint8Array> {
    if (!this.adapter || this.phase !== 'connected') throw new Error('Reconnect Signal to download this attachment.');
    if (raw.length > 65536) throw new Error('Signal attachment metadata exceeds the limit.');
    let envelope: SignalEnvelope;
    try {
      envelope = JSON.parse(raw) as SignalEnvelope;
    } catch {
      throw new Error('Signal attachment metadata is invalid.');
    }
    let message: Message;
    try {
      message = this.adapter.parseMessage(envelope);
    } catch {
      throw new Error('Signal attachment metadata is invalid.');
    }
    if (!message.threadId.startsWith('signal:group:') || message.attachments.length !== 1)
      throw new Error('Send one attachment per Signal message.');
    const attachment = message.attachments[0];
    if (!attachment.size || attachment.size > 16 * 1024 * 1024 || !attachment.fetchData)
      throw new Error('This Signal attachment exceeds 16 MiB or its size is unavailable.');
    const generation = this.generation;
    const data = await this.bounded(attachment.fetchData(), generation).catch(() => {
      throw new Error('Signal attachment could not be downloaded. Reconnect and send it again.');
    });
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (generation !== this.generation || bytes.length > 16 * 1024 * 1024)
      throw new Error('Signal attachment download was cancelled or exceeded 16 MiB.');
    return bytes;
  }

  private async startAdapter(binary: string, generation: number): Promise<void> {
    if (generation !== this.generation || !this.account) return;
    const [{ Chat }, { createMemoryState }, { createSignalAdapter }] = await Promise.all([
      import('chat'),
      import('@chat-adapter/state-memory'),
      import('@stibbons/chat-adapter-signal'),
    ]);
    if (generation !== this.generation) return;
    const logger = this.logger(generation);
    const adapter = createSignalAdapter({
      account: this.account,
      transport: { type: 'spawn', command: binary, args: ['--data-dir', this.folder] },
      logger,
      requestTimeoutMs: 30000,
      drainTimeoutMs: 1000,
    });
    const chat = new Chat({
      userName: 'pi-kit Rooms',
      adapters: { signal: adapter },
      state: createMemoryState(),
      concurrency: 'concurrent',
      logger,
    });
    this.adapter = adapter;
    this.chat = chat;
    this.connectedAfter = Date.now();
    const receive = async (_thread: unknown, message: Message): Promise<void> => {
      if (generation !== this.generation || !message.threadId.startsWith('signal:group:') || message.author.isMe)
        return;
      const raw = message.raw as SignalEnvelope & { syncMessage?: unknown };
      if (raw.syncMessage || !raw.dataMessage) return;
      this.input.lastGroupAt = Date.now();
      if (raw.timestamp < this.connectedAfter) {
        this.input.ignoredHistory++;
        return;
      }
      const text = message.text.trim();
      if (text.length > 8000 || (!text && !message.attachments.length) || message.attachments.length > 1) return;
      const files = message.attachments.map((file) => ({
        name: file.name ?? `attachment-${message.id}`,
        mime: file.mimeType ?? 'application/octet-stream',
        size: file.size ?? 0,
        type: file.type,
      }));
      if (files.some((file) => !file.size || file.size > 16 * 1024 * 1024)) return;
      const quote = raw.dataMessage.quote as { id?: unknown; authorUuid?: unknown } | undefined;
      const quoteId =
        quote && typeof quote.authorUuid === 'string' && ACI.test(quote.authorUuid) && Number.isSafeInteger(quote.id)
          ? `${quote.authorUuid}:${quote.id}`
          : undefined;
      const groupName = text.startsWith('/room-link ') ? (await adapter.fetchThread(message.threadId)).channelName : '';
      if (generation !== this.generation) return;
      this.input.lastAcceptedAt = Date.now();
      await this.receive({
        id: message.id,
        group: message.threadId,
        sender: message.author.userId,
        senderName: message.author.fullName || message.author.userName,
        groupName: groupName ?? '',
        text,
        ...(quoteId ? { quoteId } : {}),
        ...(files.length ? { files, raw: JSON.stringify(raw) } : {}),
      });
    };
    chat.onNewMessage(/[\s\S]*/, receive);
    chat.onNewMention(receive);
    chat.onSubscribedMessage(receive);
    await chat.initialize();
    if (generation !== this.generation) {
      await chat.shutdown();
      return;
    }
    this.phase = 'connected';
    this.qr = null;
    this.error = null;
  }

  private async bounded<T>(operation: Promise<T>, generation: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (generation === this.generation) void this.disconnect();
        reject(new Error('Signal operation timed out. Reconnect Signal.'));
      }, 45000);
      timer.unref();
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureFolder(): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const info = await lstat(this.folder);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('The Signal profile must be a local application-owned directory.');
    await chmod(this.folder, 0o700);
  }
  private async findBinary(signal: AbortSignal): Promise<string> {
    let configured = '';
    try {
      const settings = JSON.parse(await readFile(join(this.folder, 'pi-kit-settings.json'), 'utf8')) as {
        binaryPath?: string;
      };
      configured = settings.binaryPath ?? '';
    } catch {
      /* Fresh profile. */
    }
    this.dependency = { available: false, version: null, path: configured || null, error: INSTALL };
    const candidates = configured
      ? [configured]
      : ['signal-cli', '/opt/homebrew/bin/signal-cli', '/usr/local/bin/signal-cli'];
    for (const binary of candidates) {
      if (signal.aborted) throw new Error('Signal connection was cancelled.');
      try {
        const result = await run(binary, ['--version'], {
          timeout: 15000,
          maxBuffer: 65536,
          signal,
          windowsHide: true,
        });
        const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? null;
        if (!supportedSignalVersion(result.stdout)) {
          this.dependency = {
            available: false,
            version,
            path: binary,
            error:
              'Signal requires signal-cli 0.14.10 or newer for numberless linking fixes and stable message identities.',
          };
          continue;
        }
        this.dependency = { available: true, version, path: binary, error: null };
        return binary;
      } catch {
        if (signal.aborted) throw new Error('Signal connection was cancelled.');
      }
    }
    if (!this.dependency.version)
      this.dependency = { available: false, version: null, path: configured || null, error: INSTALL };
    throw new Error(this.dependency.error ?? INSTALL);
  }
  private logger(generation: number): ChatLogger {
    const logger: ChatLogger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        if (generation === this.generation)
          this.error = 'Signal encountered a connection error. Reconnect if updates stop.';
      },
    };
    return logger;
  }
}
