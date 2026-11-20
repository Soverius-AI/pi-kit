import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  EntryApiClient,
  a2aCard,
  errorMessage,
  instanceSetLook,
  isDeviceConnection,
  roomsHosts,
  unwrap,
} from '@pi-kit/api';
import { ViewPrefs } from '@pi-kit/data-access';
import { PkEnvGlyph, PkEnvLookPicker, type PkEnvLook, type PkEnvLookOption } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import { defaultEnvironmentLook, type RoomWorkerCandidate } from '@pi-kit/protocol';
import { PkSetting } from '@pi-kit/settings/api';
import { A2aAgentsStore, SettingsStore } from '@pi-kit/settings/data';

/** The parts of an A2A agent card this page shows. */
interface CardView {
  version: string | null;
  interfaces: { url: string; binding: string; protocol: string }[];
  streaming: boolean;
  push: boolean;
  skills: string[];
  extensions: string[];
}

interface Machine extends RoomWorkerCandidate {
  look: PkEnvLook;
  card?: CardView;
  cardError?: string;
}

@Component({
  selector: 'pk-rooms-section',
  imports: [TranslocoPipe, PkSetting, PkEnvGlyph, PkEnvLookPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-rooms">
      @if (dialog.shows('rooms-preview', 'rooms-sandbox')) {
        <section
          class="pk-group"
          [attr.aria-label]="'settings.roomsSection.title' | transloco"
          data-testid="collaboration"
        >
          <header>
            <div>
              <h4>{{ 'settings.roomsSection.title' | transloco }}</h4>
              <p>{{ 'settings.roomsSection.intro' | transloco }}</p>
            </div>
          </header>
          <div pkSetting="rooms-preview">
            <input
              type="checkbox"
              class="toggle toggle-primary"
              aria-labelledby="lbl-rooms-preview"
              aria-describedby="hint-rooms-preview"
              data-testid="rooms-preview"
              [checked]="prefs.roomsPreview()"
              (change)="dialog.setPref('roomsPreview', $any($event.target).checked)"
            />
          </div>
          @if (prefs.roomsPreview()) {
            <div pkSetting="rooms-sandbox">
              <input
                type="checkbox"
                class="toggle toggle-primary"
                aria-labelledby="lbl-rooms-sandbox"
                aria-describedby="hint-rooms-sandbox"
                data-testid="rooms-sandbox"
                [checked]="prefs.roomsSandbox()"
                (change)="dialog.setPref('roomsSandbox', $any($event.target).checked)"
              />
            </div>
          }
        </section>
      }

      @if (prefs.roomsPreview() && dialog.shows('rooms-machines')) {
        <section
          class="pk-group"
          [attr.aria-label]="'settings.roomsSection.machines' | transloco"
          [attr.aria-busy]="loading()"
          data-testid="rooms-machines"
        >
          <header>
            <div>
              <h4>{{ 'settings.roomsSection.machines' | transloco }}</h4>
              <p>{{ 'settings.roomsSection.machinesIntro' | transloco }}</p>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" [disabled]="loading()" (click)="load()">
              {{ 'settings.roomsSection.refresh' | transloco }}
            </button>
          </header>
          @if (error(); as error) {
            <p class="row sub err" role="alert">{{ error }}</p>
          }
          @for (m of machines(); track m.environmentId) {
            <div class="row stacked" [attr.data-testid]="'rooms-machine-' + m.environmentId">
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  class="btn btn-sm btn-ghost btn-square"
                  [attr.data-testid]="'rooms-machine-look-' + m.environmentId"
                  [attr.aria-label]="'settings.roomsSection.changeLook' | transloco: { value1: m.name }"
                  [disabled]="readOnly || (!m.local && !m.ready)"
                  (click)="picking.set(m.environmentId)"
                >
                  <pk-env-glyph [look]="m.look" [size]="22" />
                </button>
                <div class="min-w-0 flex-1">
                  <div class="lbl">
                    <span>{{ m.name }}</span>
                    @if (m.local) {
                      <span class="chip">{{ 'settings.roomsSection.thisComputer' | transloco }}</span>
                    }
                    @if (m.ready) {
                      <span class="chip ok">{{ 'settings.roomsSection.ready' | transloco }}</span>
                    } @else {
                      <span class="chip warn">{{ 'settings.roomsSection.notReady' | transloco }}</span>
                    }
                  </div>
                  @if (m.reason) {
                    <div class="hint">{{ m.reason }}</div>
                  }
                </div>
              </div>
              @if (m.card; as card) {
                <dl class="pk-a2a-card t-sm" [attr.data-testid]="'rooms-card-' + m.environmentId">
                  @if (card.version) {
                    <dt>{{ 'settings.roomsSection.version' | transloco }}</dt>
                    <dd>{{ card.version }}</dd>
                  }
                  <dt>{{ 'settings.roomsSection.interfaces' | transloco }}</dt>
                  <dd>
                    @for (i of card.interfaces; track i.url) {
                      <div class="mono break-all">{{ i.url }} · {{ i.binding }} {{ i.protocol }}</div>
                    }
                  </dd>
                  <dt>{{ 'settings.roomsSection.capabilities' | transloco }}</dt>
                  <dd>
                    {{
                      (card.streaming ? 'settings.roomsSection.streaming' : 'settings.roomsSection.noStreaming')
                        | transloco
                    }}
                    ·
                    {{ (card.push ? 'settings.roomsSection.push' : 'settings.roomsSection.noPush') | transloco }}
                  </dd>
                  @if (card.skills.length) {
                    <dt>{{ 'settings.roomsSection.skills' | transloco }}</dt>
                    <dd>{{ card.skills.join(', ') }}</dd>
                  }
                  @if (card.extensions.length) {
                    <dt>{{ 'settings.roomsSection.extensions' | transloco }}</dt>
                    <dd>
                      @for (e of card.extensions; track e) {
                        <div class="mono break-all">{{ e }}</div>
                      }
                    </dd>
                  }
                </dl>
              } @else if (m.cardError) {
                <div class="hint">{{ 'settings.roomsSection.noCard' | transloco: { value1: m.cardError } }}</div>
              }
            </div>
          } @empty {
            @if (!loading()) {
              <div class="row">
                <div class="hint">{{ 'settings.roomsSection.noMachines' | transloco }}</div>
              </div>
            }
          }
        </section>
      }

      @if (prefs.roomsPreview() && dialog.shows('rooms-a2a-agents')) {
        <section
          class="pk-group"
          [attr.aria-label]="'settings.roomsSection.a2aAgents' | transloco"
          data-testid="a2a-agents"
        >
          <header>
            <div>
              <h4>{{ 'settings.roomsSection.a2aAgents' | transloco }}</h4>
              <p>{{ 'settings.roomsSection.a2aAgentsIntro' | transloco }}</p>
            </div>
          </header>
          @for (agent of agents.agents(); track agent.id) {
            <div class="row" [attr.data-testid]="'a2a-agent-' + agent.id">
              <div class="min-w-0">
                <div class="lbl">
                  <span>{{ agent.name }}</span>
                  @if (agent.tokenStorage !== 'none') {
                    <span class="chip" [class.warn]="agent.tokenStorage === 'database'">{{
                      (agent.tokenStorage === 'keychain'
                        ? 'settings.roomsSection.agentTokenKeychain'
                        : 'settings.roomsSection.agentTokenDatabase'
                      ) | transloco
                    }}</span>
                  }
                </div>
                <div class="hint mono break-all">{{ agent.url }}</div>
              </div>
              <div class="ctl ctl-w">
                <button
                  type="button"
                  class="btn btn-sm"
                  data-testid="remove-a2a-agent"
                  [disabled]="agents.busy()"
                  [attr.aria-label]="'settings.roomsSection.removeAgentN' | transloco: { value1: agent.name }"
                  (click)="agents.remove(agent.id)"
                >
                  {{ 'settings.roomsSection.removeAgent' | transloco }}
                </button>
              </div>
            </div>
          } @empty {
            <div class="row">
              <div class="hint">{{ 'settings.roomsSection.noAgents' | transloco }}</div>
            </div>
          }
          <form class="row" data-testid="add-a2a-agent" (submit)="addAgent($event)">
            <div class="min-w-0">
              <div class="lbl">{{ 'settings.roomsSection.addAgent' | transloco }}</div>
              <div class="hint">{{ 'settings.roomsSection.addAgentHint' | transloco }}</div>
              @if (agents.error(); as error) {
                <div class="hint text-error" role="alert" data-testid="a2a-agent-error">{{ error }}</div>
              }
            </div>
            <div class="ctl ctl-w flex-col items-stretch">
              <label class="sr-only" for="a2a-agent-url">{{ 'settings.roomsSection.agentUrl' | transloco }}</label>
              <input
                id="a2a-agent-url"
                name="url"
                type="url"
                class="input input-sm mono"
                [placeholder]="'settings.roomsSection.agentUrlPlaceholder' | transloco"
                autocomplete="off"
                spellcheck="false"
                [value]="agentUrl()"
                (input)="agentUrl.set($any($event.target).value)"
              />
              <label class="sr-only" for="a2a-agent-token">{{ 'settings.roomsSection.agentToken' | transloco }}</label>
              <input
                id="a2a-agent-token"
                name="token"
                type="password"
                class="input input-sm"
                autocomplete="off"
                [placeholder]="'settings.roomsSection.agentToken' | transloco"
                [value]="agentToken()"
                (input)="agentToken.set($any($event.target).value)"
              />
              <button
                type="submit"
                class="btn btn-sm self-end"
                data-testid="add-a2a-agent-button"
                [disabled]="!agentUrl().trim() || agents.busy()"
              >
                {{ 'settings.roomsSection.addAgentButton' | transloco }}
              </button>
            </div>
          </form>
        </section>
      }
    </div>
    @if (picking(); as selected) {
      <pk-env-look-picker
        [environments]="options()"
        [selected]="selected"
        (saved)="saveLook($event.id, $event.look)"
        (closed)="picking.set(undefined)"
      />
    }
  `,
})
export class RoomsSection {
  private readonly api = inject(EntryApiClient);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly dialog = inject(SettingsStore);
  protected readonly prefs = inject(ViewPrefs);
  protected readonly agents = inject(A2aAgentsStore);
  protected readonly readOnly = isDeviceConnection();
  protected readonly machines = signal<Machine[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly picking = signal<string | undefined>(undefined);
  protected readonly agentUrl = signal('');
  protected readonly agentToken = signal('');
  protected readonly options = computed<PkEnvLookOption[]>(() =>
    this.machines().map((m) => ({
      id: m.environmentId,
      name: m.name,
      look: m.look,
      editable: !this.readOnly && (m.local || m.ready),
      online: m.local || m.ready,
    })),
  );

  constructor() {
    effect(() => {
      if (!this.prefs.roomsPreview()) return;
      untracked(() => {
        void this.agents.load();
        void this.load();
      });
    });
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(undefined);
    try {
      const hosts = await unwrap(roomsHosts({ client: this.api.client }));
      const machines = hosts.map((host) => ({
        ...host,
        look: host.look ?? defaultEnvironmentLook(host.environmentId),
      }));
      if (this.destroyRef.destroyed) return;
      this.machines.set(machines);
      const cards = await Promise.all(machines.map((m) => this.card(m)));
      if (!this.destroyRef.destroyed) this.machines.set(cards);
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroyRef.destroyed) this.loading.set(false);
    }
  }

  protected async saveLook(id: string, look: PkEnvLook): Promise<void> {
    const machine = this.machines().find((m) => m.environmentId === id);
    if (!machine) return;
    this.error.set(undefined);
    try {
      const saved = await unwrap(instanceSetLook({ client: this.clientOf(machine), body: look }));
      if (this.destroyRef.destroyed) return;
      this.machines.update((list) => list.map((m) => (m.environmentId === id ? { ...m, look: saved } : m)));
      this.picking.set(undefined);
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    }
  }

  protected async addAgent(event: Event): Promise<void> {
    event.preventDefault();
    if (await this.agents.add(this.agentUrl(), this.agentToken())) {
      this.agentUrl.set('');
      this.agentToken.set('');
    }
  }

  private clientOf(machine: Machine) {
    return machine.local ? this.api.client : this.api.forOwner(machine.environmentId);
  }

  private async card(machine: Machine): Promise<Machine> {
    if (!machine.local && !machine.ready) return machine;
    try {
      return { ...machine, card: RoomsSection.view(await unwrap(a2aCard({ client: this.clientOf(machine) }))) };
    } catch (error) {
      return { ...machine, cardError: errorMessage(error) };
    }
  }

  static view(card: Record<string, unknown>): CardView {
    const list = (value: unknown): Record<string, unknown>[] =>
      Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        : [];
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const capabilities = (card['capabilities'] ?? {}) as Record<string, unknown>;
    return {
      version: text(card['version']) || null,
      interfaces: list(card['supportedInterfaces']).map((i) => ({
        url: text(i['url']),
        binding: text(i['protocolBinding']),
        protocol: text(i['protocolVersion']),
      })),
      streaming: capabilities['streaming'] === true,
      push: capabilities['pushNotifications'] === true,
      skills: list(card['skills']).map((skill) => text(skill['name']) || text(skill['id'])),
      extensions: list(capabilities['extensions']).map((extension) => text(extension['uri'])),
    };
  }
}
