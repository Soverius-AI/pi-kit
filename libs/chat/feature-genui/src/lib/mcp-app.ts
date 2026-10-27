import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { AbstractAgent } from '@ag-ui/client';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { CopilotKit, type ActivityRenderer } from '@copilotkit/angular';
import {
  MCP_APPS_CONFIG,
  mcpAppsSnapshotContentSchema,
  type MCPAppsSnapshotContent,
} from '@copilotkit/angular/mcp-apps';
import { BackendService } from '@pi-kit/api';
import { mcpToolLabel } from '@pi-kit/chat/util';
import { ThemeStore } from '@pi-kit/data-access';
import { PkGenUiFrame, PkTurn, type PkGenUiTone } from '@pi-kit/design-system';
import { PROXIED_MCP_REQUEST_KEY } from '@pi-kit/protocol';
import { PkGenUiTurn } from './genui-turn';

/** The path of the backend's sandbox proxy document; served without the bearer token. */
export const SANDBOX_PROXY_PATH = '/api/mcp-sandbox/proxy.html';
const PROTOCOL_VERSION = '2025-06-18';
type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Json;
}

class Cancelled extends Error {}

/** Requests of all apps of one agent run one after the other, each when the agent is idle (as CopilotKit's host does). */
const queues = new WeakMap<AbstractAgent, Promise<unknown>>();
function enqueue<T>(
  translate: Translate,
  agent: AbstractAgent,
  signal: AbortSignal,
  timeoutMs: number,
  pollMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const turn = (queues.get(agent) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const deadline = Date.now() + timeoutMs;
      while (agent.isRunning) {
        if (signal.aborted) throw new Cancelled();
        if (Date.now() > deadline) throw new Error(translate('chat.mcpApp.timedOutWaitingForTheAgentTo'));
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      if (signal.aborted) throw new Cancelled();
      return run();
    });
  queues.set(agent, turn);
  return turn;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An MCP App in the transcript: the host side of the MCP Apps protocol for `mcp-apps` activities.
 *
 * It does what `CopilotMCPAppsWidget` of `@copilotkit/angular/mcp-apps` 0.3.1 does, with the same contract, but
 * puts the app behind the backend's sandbox proxy (`/api/mcp-sandbox/proxy.html`, another origin than the page; the
 * proxy then runs the app in a second frame without `allow-same-origin`, so the app has an opaque origin).
 * CopilotKit's frame is an `srcdoc` frame with `allow-scripts allow-same-origin`, which gives the app the renderer's
 * own origin (its DOM, storage and backend token), and Electron's strict CSP (`script-src 'self'`) would not run its
 * inline proxy script at all. The configuration (`provideMCPApps`: host
 * info, capabilities, idle timeout), the content schema and the wire contract are CopilotKit's:
 *
 * - the app's HTML is loaded with a run whose `forwardedProps.__proxiedMCPRequest` is `resources/read`;
 * - the app's `tools/call` is a run with the same prop; the answer is the run's `result`;
 * - `ui/message` adds a message to the agent and, as a follow-up, runs it, so pi answers;
 * - `ui/open-link` opens an http(s) URL in a new tab; `ui/notifications/size-changed` sizes the frame.
 *
 * The run for a request is not a conversation turn: the backend relays it to the MCP server pi holds and writes
 * nothing to the thread's log.
 *
 * Tried again against the stock renderer of `@copilotkit/angular` 0.6.0 and kept: the stock widget builds its
 * sandbox as an `srcdoc` frame (`allow-scripts allow-same-origin`) whose inline proxy script is blocked by the desktop app's
 * `script-src 'self'` ("Timed out after 30000ms waiting for the MCP App sandbox to initialize"), and where it does run (dev:web) the app
 * shares the renderer's origin and reaches its DOM and storage. `provideMCPApps` has no option for a sandbox URL.
 */
@Component({
  selector: 'pk-mcp-app',
  imports: [PkTurn, PkGenUiTurn, PkGenUiFrame, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-turn role="pi" [pkGenUiTurn]="message().id">
      <pk-genui-frame [title]="title()" [sub]="sub()" [dot]="dot()" [label]="'chat.mcpApp.mCPAppSandboxed' | transloco">
        @if (state() === 'loading') {
          <div class="note" role="status">{{ 'chat.mcpApp.loadingTheApp' | transloco }}</div>
        }
        @if (error(); as message) {
          <div class="note error" role="alert">{{ message }}</div>
        }
        <div class="app" [hidden]="state() !== 'ready'">
          @if (src(); as url) {
            <iframe
              #frame
              sandbox="allow-scripts allow-same-origin allow-forms"
              [title]="'chat.mcpApp.interactiveMCPApplication' | transloco"
              [src]="url"
            ></iframe>
          }
        </div>
      </pk-genui-frame>
    </pk-turn>
  `,
})
export class PkMcpApp implements ActivityRenderer<MCPAppsSnapshotContent> {
  protected readonly i18n = inject(Language);
  readonly activityType = input.required<string>();
  readonly maxHeight = input(5000);
  readonly idlePollMs = input(100);
  readonly content = input.required<MCPAppsSnapshotContent>();
  readonly message = input.required<{
    role: 'activity';
    content: Record<string, unknown>;
    id: string;
    activityType: string;
  }>();
  readonly agent = input<AbstractAgent | undefined>(undefined);

  private readonly config = inject(MCP_APPS_CONFIG);
  private readonly copilotKit = inject(CopilotKit);
  private readonly backend = inject(BackendService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly theme = inject(ThemeStore);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  protected readonly src = signal<SafeResourceUrl | undefined>(undefined);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly title = computed(() => this.content().serverId ?? this.i18n.t('chat.mcpApp.mCPApp'));
  protected readonly sub = computed(() => mcpToolLabel((this.content() as { tool?: string }).tool));
  protected readonly dot = computed<PkGenUiTone>(() =>
    this.state() === 'ready' ? 'success' : this.state() === 'error' ? 'error' : 'warning',
  );

  /** True once the app said `ui/notifications/initialized`; host-context changes are only sent after that. */
  private initialized = false;

  constructor() {
    const abort = new AbortController();
    inject(DestroyRef).onDestroy(() => abort.abort());

    void this.backend.url().then((url) => {
      const proxy = new URL(`${url}${SANDBOX_PROXY_PATH}`);
      // `allow-same-origin` below is only safe because the proxy is not the page's origin.
      if (proxy.origin === window.location.origin)
        return this.fail(new Error(this.i18n.t('chat.mcpApp.theSandboxProxyMustBeServedFrom')));
      this.src.set(this.sanitizer.bypassSecurityTrustResourceUrl(proxy.href));
    });

    const onMessage = (event: MessageEvent): void => {
      const frame = this.frame()?.nativeElement;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parse(event.data);
      if (message) void this.handle(frame, message, abort.signal);
    };
    window.addEventListener('message', onMessage);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('message', onMessage));

    // The theme follows the app's: a changed theme is announced to an app that has started.
    effect(() => {
      this.theme.theme();
      const frame = untracked(() => this.frame()?.nativeElement);
      if (frame && this.initialized) this.notify(frame, 'ui/notifications/host-context-changed', this.hostContext());
    });
  }

  /** The proxy says it is ready: fetch the app's HTML through the agent and hand it over. */
  private async load(frame: HTMLIFrameElement, signal: AbortSignal): Promise<void> {
    const agent = this.agent();
    const data = this.content();
    try {
      if (!agent) throw new Error(this.i18n.t('chat.mcpApp.noAgentIsAvailableToLoadThis'));
      const result = await this.relay(agent, signal, data, 'resources/read', { uri: data.resourceUri });
      const resource = (result['contents'] as Json[] | undefined)?.find(
        (candidate) => candidate['uri'] === data.resourceUri,
      );
      if (!resource)
        throw new Error(this.i18n.t('chat.mcpApp.noMatchingMCPAppResourceWasReturned', { value1: data.resourceUri }));
      const html =
        typeof resource['text'] === 'string'
          ? resource['text']
          : typeof resource['blob'] === 'string'
            ? decodeBase64(this.i18n.t, resource['blob'])
            : undefined;
      if (!html) throw new Error(this.i18n.t('chat.mcpApp.theMCPAppResourceHasNoText'));
      const ui = (resource['_meta'] as { ui?: { csp?: unknown } } | undefined)?.ui;
      this.notify(frame, 'ui/notifications/sandbox-resource-ready', { html, ...(ui?.csp ? { csp: ui.csp } : {}) });
      this.state.set('ready');
    } catch (error) {
      if (!(error instanceof Cancelled)) this.fail(error);
    }
  }

  private async handle(frame: HTMLIFrameElement, message: RpcMessage, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (message.method === 'ui/notifications/sandbox-proxy-ready') return void this.load(frame, signal);
    if (message.id !== undefined && message.method)
      return this.handleRequest(frame, message as RpcMessage & { id: string | number; method: string }, signal);
    const data = this.content();
    switch (message.method) {
      case 'ui/notifications/initialized':
        this.initialized = true;
        if (data.toolInput) this.notify(frame, 'ui/notifications/tool-input', { arguments: data.toolInput });
        this.notify(frame, 'ui/notifications/tool-result', data.result);
        break;
      case 'ui/notifications/size-changed': {
        const height = message.params?.['height'];
        if (typeof height === 'number' && Number.isFinite(height) && height > 0)
          frame.style.height = `${Math.ceil(Math.min(height, this.maxHeight()))}px`;
        break;
      }
      case 'notifications/message':
        console.info('[MCP App]', message.params ?? {});
        break;
    }
  }

  private async handleRequest(
    frame: HTMLIFrameElement,
    message: RpcMessage & { id: string | number; method: string },
    signal: AbortSignal,
  ): Promise<void> {
    const agent = this.agent();
    switch (message.method) {
      case 'ui/initialize':
        return this.respond(frame, message.id, {
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: this.config.hostInfo,
          hostCapabilities: this.config.hostCapabilities,
          hostContext: this.hostContext(),
        });
      case 'ui/open-link': {
        const url = safeExternalUrl(message.params?.['url']);
        if (!url) return this.respondError(frame, message.id, -32602, 'A valid HTTP(S) URL is required.');
        window.open(url, '_blank', 'noopener,noreferrer');
        return this.respond(frame, message.id, { isError: false });
      }
      case 'ui/message': {
        if (!agent) return this.respondError(frame, message.id, -32603, 'No agent is available.');
        const role = message.params?.['role'] === 'assistant' ? 'assistant' : 'user';
        const content = Array.isArray(message.params?.['content'])
          ? (message.params['content'] as unknown[])
              .filter(
                (part): part is { type: 'text'; text: string } =>
                  isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string',
              )
              .map((part) => part.text)
              .join('\n')
          : '';
        if (content) agent.addMessage({ id: crypto.randomUUID(), role, content });
        this.respond(frame, message.id, { isError: false });
        const followUp =
          typeof message.params?.['followUp'] === 'boolean' ? message.params['followUp'] : role === 'user';
        if (!followUp || !content) return;
        // The follow-up is a turn like any other: pi answers, and it belongs to the thread the app was opened in.
        const thread = agent.threadId;
        try {
          await enqueue(this.i18n.t, agent, signal, this.config.idleTimeoutMs, this.idlePollMs(), async () => {
            if (agent.threadId !== thread) throw new Cancelled();
            await this.copilotKit.core.runAgent({ agent });
          });
        } catch (error) {
          if (!(error instanceof Cancelled)) this.fail(error, this.i18n.t('chat.mcpApp.theFollowUpFailed'));
        }
        return;
      }
      case 'tools/call': {
        if (!agent) return this.respondError(frame, message.id, -32603, 'No agent is available.');
        try {
          this.respond(
            frame,
            message.id,
            await this.relay(agent, signal, this.content(), 'tools/call', message.params ?? {}),
          );
        } catch (error) {
          if (!(error instanceof Cancelled))
            this.respondError(frame, message.id, -32603, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      default:
        return this.respondError(frame, message.id, -32601, `Method not found: ${message.method}`);
    }
  }

  /** One request to the MCP server through the agent (`__proxiedMCPRequest`); the backend answers it in `RUN_FINISHED.result`. */
  private async relay(
    agent: AbstractAgent,
    signal: AbortSignal,
    data: MCPAppsSnapshotContent,
    method: string,
    params: Json,
  ): Promise<Json> {
    const run = await enqueue(this.i18n.t, agent, signal, this.config.idleTimeoutMs, this.idlePollMs(), () =>
      agent.runAgent({
        forwardedProps: {
          [PROXIED_MCP_REQUEST_KEY]: { serverHash: data.serverHash, serverId: data.serverId, method, params },
        },
      }),
    );
    const result = run.result as Json | undefined;
    if (typeof result?.['error'] === 'string') throw new Error(result['error']);
    return result ?? {};
  }

  /** The theme as the MCP Apps style variables, from the tokens in effect now. */
  private hostContext(): Json {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string): string => style.getPropertyValue(name).trim();
    return {
      ...this.config.hostContext,
      theme: this.theme.isDark() ? 'dark' : 'light',
      platform: 'web',
      styles: {
        variables: {
          '--color-background-primary': token('--color-base-100'),
          '--color-background-secondary': token('--color-base-200'),
          '--color-text-primary': token('--color-base-content'),
          '--color-text-secondary': token('--pk-muted'),
          '--color-border-primary': token('--color-base-300'),
          '--color-ring-primary': token('--color-primary'),
          '--font-sans': token('--pk-font-sans'),
          '--font-mono': token('--pk-font-mono'),
          '--border-radius-md': '8px',
        },
      },
    };
  }

  private respond(frame: HTMLIFrameElement, id: string | number, result: unknown): void {
    frame.contentWindow?.postMessage({ jsonrpc: '2.0', id, result }, '*');
  }

  private respondError(frame: HTMLIFrameElement, id: string | number, code: number, message: string): void {
    frame.contentWindow?.postMessage({ jsonrpc: '2.0', id, error: { code, message } }, '*');
  }

  private notify(frame: HTMLIFrameElement, method: string, params: unknown): void {
    frame.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  private fail(error: unknown, prefix = ''): void {
    this.state.set('error');
    this.error.set(`${prefix}${error instanceof Error ? error.message : String(error)}`);
  }
}

function parse(value: unknown): RpcMessage | undefined {
  if (!isRecord(value) || value['jsonrpc'] !== '2.0' || typeof value['method'] !== 'string') return undefined;
  const id = value['id'];
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return undefined;
  if (value['params'] !== undefined && !isRecord(value['params'])) return undefined;
  return value as unknown as RpcMessage;
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value, window.location.href);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function decodeBase64(translate: Translate, value: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
  } catch {
    throw new Error(translate('chat.mcpApp.theMCPAppResourceContainsInvalidBase64'));
  }
}

export { mcpAppsSnapshotContentSchema };
