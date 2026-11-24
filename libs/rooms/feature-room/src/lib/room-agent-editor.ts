import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { disabled, form, FormField, maxLength, pattern, required } from '@angular/forms/signals';
import { EntryApiClient, errorMessage, roomsAddAgent, unwrap } from '@pi-kit/api';
import { PkAvatar, PkChoice, PkEnvGlyph, PkIcon } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { A2aAgent, RoomParticipant, RoomParticipantInput } from '@pi-kit/protocol';
import { RoomAgentsStore } from '@pi-kit/rooms/data';
import { RoomDialog } from './room-dialog';

export interface RoomAgentSelection {
  kind: 'choose' | 'collaborator' | 'external' | 'manage';
  member?: RoomParticipant;
}

@Component({
  selector: 'pk-room-agent-editor',
  imports: [FormField, PkAvatar, PkChoice, PkEnvGlyph, PkIcon, RoomDialog, TranslocoPipe],
  template: `
    <pk-room-dialog
      [title]="title() | transloco"
      [closeLabel]="'rooms.assistant.close' | transloco"
      [busy]="busy()"
      [error]="error() || store.error()"
      (closed)="closed.emit()"
    >
      @switch (screen()) {
        @case ('choose') {
          <div class="choices" data-testid="room-agent-choices">
            <button
              type="button"
              class="choice"
              data-testid="room-agent-choose-collaborator"
              (click)="screen.set('collaborator')"
            >
              <pk-icon name="agents" size="20" /><strong>{{ 'rooms.agents.collaborator' | transloco }}</strong
              ><span>{{ 'rooms.agents.collaboratorHint' | transloco }}</span>
            </button>
            <button
              type="button"
              class="choice"
              data-testid="room-agent-choose-external"
              (click)="screen.set('external')"
            >
              <pk-icon name="extension" size="20" /><strong>{{ 'rooms.agents.external' | transloco }}</strong
              ><span>{{ 'rooms.agents.externalHint' | transloco }}</span>
            </button>
          </div>
        }
        @case ('manage') {
          @if (selection().member; as member) {
            <h3>{{ member.role }}</h3>
            @if (member.instructions) {
              <p class="pre">{{ member.instructions }}</p>
            }
            @if (member.model && !member.agent.agent) {
              <p>{{ member.model }}</p>
            }
            @if (member.source === 'playbook') {
              <p class="muted">{{ 'rooms.agents.fromPlaybook' | transloco }}</p>
            }
            @if (confirmRemove()) {
              <p>{{ 'rooms.agents.removeHint' | transloco }}</p>
              <button
                type="button"
                class="btn btn-error btn-sm"
                data-testid="room-agent-remove-confirm"
                [disabled]="busy()"
                (click)="remove()"
              >
                {{ 'rooms.agents.remove' | transloco }}
              </button>
            } @else {
              <div class="actions">
                <button
                  type="button"
                  class="btn btn-sm"
                  data-testid="room-agent-edit"
                  (click)="screen.set(member.agent.agent ? 'external' : 'collaborator')"
                >
                  {{ 'rooms.assistant.edit' | transloco }}</button
                ><button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="room-agent-remove"
                  [disabled]="busy()"
                  (click)="confirmRemove.set(true)"
                >
                  {{ 'rooms.agents.remove' | transloco }}
                </button>
              </div>
            }
          }
        }
        @default {
          @if (store.targetsError(); as message) {
            <p class="text-error" role="alert">{{ message }}</p>
            <button type="button" class="btn btn-ghost btn-sm" (click)="store.refreshTargets()">
              {{ 'rooms.agents.retry' | transloco }}
            </button>
          }
          <form id="room-agent-form" (submit)="save($event)">
            <label
              >{{ 'rooms.agents.role' | transloco
              }}<input [formField]="fields.role" data-testid="room-agent-role" autocomplete="off"
            /></label>
            <p class="muted">{{ 'rooms.agents.roleHint' | transloco }}</p>
            @if (screen() === 'collaborator') {
              <fieldset class="host-options" data-testid="room-agent-host">
                <legend>{{ 'rooms.agents.host' | transloco }}</legend>
                <div class="pk-choices host-choices">
                  @for (machine of store.targets()?.machines ?? []; track machine.environmentId) {
                    <button
                      pkChoice
                      type="button"
                      [pressed]="selectedMachine()?.environmentId === machine.environmentId"
                      [attr.data-host-id]="machine.environmentId"
                      [disabled]="busy() || !machine.ready"
                      (click)="chooseHost(machine.environmentId)"
                    >
                      <ng-container tile>
                        @if (machine.look; as look) {
                          <pk-env-glyph [look]="look" [size]="22" />
                        } @else {
                          <pk-icon name="agents" size="20" />
                        }
                      </ng-container>
                      <span t>{{ machine.name }}</span
                      ><span d>{{
                        machine.ready
                          ? ('rooms.agents.available' | transloco)
                          : machine.reason || ('rooms.agents.offline' | transloco)
                      }}</span>
                    </button>
                  }
                </div>
              </fieldset>
              @if (selectedMachine(); as machine) {
                <div class="selected-host" data-testid="room-agent-selected-host">
                  <pk-avatar [name]="draft().role || machine.name" participant="worker" [look]="machine.look" /><span>{{
                    machine.name
                  }}</span>
                </div>
                @if (!machine.ready) {
                  <p class="text-warning">{{ machine.reason || ('rooms.agents.offline' | transloco) }}</p>
                }
              }
              <label
                >{{ 'rooms.agents.model' | transloco
                }}<select [formField]="fields.model" data-testid="room-agent-model">
                  <option value="">{{ 'rooms.agents.defaultModel' | transloco }}</option>
                  @if (retainedModel(); as model) {
                    <option [value]="model">{{ model }} · {{ 'rooms.agents.configuredModel' | transloco }}</option>
                  }
                  @for (model of availableModels(); track model.provider + '/' + model.id) {
                    <option [value]="model.provider + '/' + model.id">{{ model.name }} · {{ model.provider }}</option>
                  }
                </select></label
              >
              @if (store.modelsLoading()) {
                <p class="muted" role="status">{{ 'rooms.agents.loadingModels' | transloco }}</p>
              }
              @if (store.modelsError(); as message) {
                <p class="text-error" role="alert">{{ message }}</p>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="room-agent-model-retry"
                  (click)="store.retryModels()"
                >
                  {{ 'rooms.agents.retry' | transloco }}
                </button>
              }
            } @else {
              @if (registered(); as agent) {
                <p role="status" data-testid="room-agent-registered">
                  {{ 'rooms.agents.registeredNotAdded' | transloco: { name: agent.name } }}
                </p>
              } @else {
                <label
                  >{{ 'rooms.agents.external' | transloco
                  }}<select [formField]="fields.agent" data-testid="room-agent-external">
                    <option value="">{{ 'rooms.agents.chooseExternal' | transloco }}</option>
                    @for (agent of store.targets()?.agents ?? []; track agent.id) {
                      <option [value]="agent.id">{{ agent.name }}</option>
                    }
                    <option value="__new__">{{ 'rooms.agents.registerNew' | transloco }}</option>
                  </select></label
                >
                @if (draft().agent === '__new__') {
                  <label
                    >{{ 'rooms.agents.url' | transloco
                    }}<input type="url" [formField]="secretFields.url" data-testid="room-agent-url" autocomplete="off"
                  /></label>
                  <label
                    >{{ 'rooms.agents.token' | transloco
                    }}<input
                      type="password"
                      [formField]="secretFields.token"
                      data-testid="room-agent-token"
                      autocomplete="off"
                  /></label>
                }
              }
            }
            <label
              >{{ 'rooms.agents.instructions' | transloco
              }}<textarea [formField]="fields.instructions" data-testid="room-agent-instructions" rows="4"></textarea>
            </label>
          </form>
        }
      }
      <div roomDialogActions class="actions">
        @if (screen() === 'collaborator' || screen() === 'external') {
          @if (!selection().member && !registered()) {
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              [disabled]="busy()"
              data-testid="room-agent-back"
              (click)="back()"
            >
              {{ 'rooms.agents.back' | transloco }}
            </button>
          }
          <button
            type="submit"
            form="room-agent-form"
            class="btn btn-primary btn-sm"
            data-testid="room-agent-save"
            [disabled]="busy() || fields().invalid() || (registeringNew() && secretFields().invalid())"
          >
            {{ (selection().member ? 'rooms.agents.save' : 'rooms.agents.addToRoom') | transloco }}
          </button>
        }
      </div>
    </pk-room-dialog>
  `,
  styles: `
    form,
    label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    form {
      gap: 14px;
    }
    input,
    textarea,
    select {
      width: 100%;
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      background: var(--color-base-100);
    }
    .host-options {
      border: 0;
      padding: 0;
      margin: 0;
      min-width: 0;
    }
    .host-options legend {
      margin-bottom: 6px;
    }
    .host-choices {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
    }
    .selected-host {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .choices {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .choice {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
      padding: 16px;
      border: 1px solid var(--color-base-300);
      border-radius: 8px;
      background: transparent;
      text-align: start;
      cursor: pointer;
    }
    .choice:hover {
      background: var(--color-base-200);
    }
    .choice span,
    .muted {
      color: var(--pk-muted);
      font-size: 12px;
      line-height: 1.5;
    }
    h3 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    p {
      margin: 0 0 12px;
      overflow-wrap: anywhere;
    }
    .pre {
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      min-height: 36px;
    }
    @media (max-width: 767px) {
      .choices {
        grid-template-columns: minmax(0, 1fr);
      }
      button {
        min-height: 44px;
      }
    }
  `,
})
export class RoomAgentEditor {
  readonly selection = input<RoomAgentSelection>({ kind: 'choose' });
  readonly closed = output<void>();
  protected readonly store = inject(RoomAgentsStore);
  private readonly api = inject(EntryApiClient);
  private readonly destroy = inject(DestroyRef);
  private readonly language = inject(Language);
  private readonly abort = new AbortController();
  protected readonly screen = linkedSignal(() => this.selection().kind);
  protected readonly confirmRemove = linkedSignal(() => {
    this.selection();
    return false;
  });
  protected readonly error = signal('');
  protected readonly registering = signal(false);
  protected readonly registered = signal<A2aAgent | undefined>(undefined);
  protected readonly busy = computed(() => this.registering() || this.store.busy());
  protected readonly title = computed(() =>
    this.screen() === 'manage'
      ? 'rooms.agents.details'
      : this.selection().member
        ? 'rooms.agents.edit'
        : this.screen() === 'collaborator'
          ? 'rooms.agents.collaborator'
          : this.screen() === 'external'
            ? 'rooms.agents.external'
            : 'rooms.agents.add',
  );
  private readonly localMachine = computed(
    () => this.store.targets()?.machines.find((machine) => machine.local)?.environmentId ?? '',
  );
  protected readonly draft = linkedSignal({
    source: () => ({ selection: this.selection(), localMachine: this.localMachine() }),
    computation: (
      source,
      previous,
    ): { role: string; instructions: string; model: string; agent: string; machine: string } => {
      if (previous?.source.selection === source.selection)
        return { ...previous.value, machine: previous.value.machine || source.localMachine };
      const member = source.selection.member;
      const target = member?.agent.machine;
      const machine = target
        ? (this.store.targets()?.machines.find((machine) => machine.environmentId === target || machine.name === target)
            ?.environmentId ?? target)
        : source.localMachine;
      return {
        role: member?.role ?? '',
        instructions: member?.instructions ?? '',
        model: member?.model ?? '',
        agent: member?.agent.agent
          ? (this.store
              .targets()
              ?.agents.find((agent) => agent.id === member.agent.agent || agent.name === member.agent.agent)?.id ??
            member.agent.agent)
          : '',
        machine,
      };
    },
  });
  protected readonly selectedMachine = computed(() =>
    this.store
      .targets()
      ?.machines.find(
        (machine) => machine.environmentId === this.draft().machine || machine.name === this.draft().machine,
      ),
  );
  private readonly modelOwner = computed(() => {
    if (this.screen() !== 'collaborator') return undefined;
    const machine = this.selectedMachine();
    return machine ? (machine.local ? this.store.context()?.host : machine.environmentId) : undefined;
  });
  protected readonly availableModels = computed(() =>
    (this.store.models() ?? [])
      .filter((model) => model.available)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
  );
  protected readonly retainedModel = computed(() => {
    const value = this.draft().model;
    return value && !this.availableModels().some((model) => model.provider + '/' + model.id === value)
      ? value
      : undefined;
  });
  protected chooseHost(id: string): void {
    if (this.busy()) return;
    if (!this.store.targets()?.machines.some((machine) => machine.environmentId === id && machine.ready)) return;
    if (this.selectedMachine()?.environmentId !== id) this.fields.model().value.set('');
    this.fields.machine().value.set(id);
  }
  protected readonly registeringNew = computed(
    () => this.screen() === 'external' && this.draft().agent === '__new__' && !this.registered(),
  );
  protected readonly fields = form(this.draft, (path) => {
    disabled(path, () => this.busy());
    disabled(path.model, () => this.busy() || this.screen() === 'external');
    required(path.role);
    pattern(path.role, /^[a-z][a-z0-9-]{0,39}$/);
    maxLength(path.instructions, 4000);
    maxLength(path.model, 200);
    pattern(path.model, /^(?:[^\s/]+\/\S+)?$/);
    required(path.machine, { when: () => this.screen() === 'collaborator' });
    required(path.agent, { when: () => this.screen() === 'external' && !this.registered() });
  });
  protected readonly secret = signal({ url: '', token: '' });
  protected readonly secretFields = form(this.secret, (path) => {
    disabled(path, () => this.busy());
    required(path.url, { when: () => this.registeringNew() });
    pattern(path.url, /^(?:https?:\/\/\S+)?$/);
    maxLength(path.url, 2000);
    maxLength(path.token, 4000);
  });
  constructor() {
    effect((cleanup) => {
      const owner = this.modelOwner();
      untracked(() => this.store.showModels(owner));
      cleanup(() => this.store.showModels(undefined));
    });
    this.destroy.onDestroy(() => {
      this.abort.abort();
      this.secret.set({ url: '', token: '' });
    });
  }
  private current(selection: RoomAgentSelection, context: ReturnType<RoomAgentsStore['context']>): boolean {
    return !this.destroy.destroyed && this.selection() === selection && this.store.context() === context;
  }
  protected back(): void {
    this.secret.set({ url: '', token: '' });
    this.error.set('');
    this.screen.set('choose');
  }
  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.fields().invalid() || (this.registeringNew() && this.secretFields().invalid())) return;
    const selection = this.selection();
    const context = this.store.context();
    if (!context) return;
    this.error.set('');
    this.store.error.set(undefined);
    const draft = this.draft();
    let agentId = this.registered()?.id ?? draft.agent;
    if (this.registeringNew()) {
      const credentials = this.secret();
      this.registering.set(true);
      try {
        const agent = await unwrap(
          roomsAddAgent({
            client: this.api.forOwner(context.host),
            signal: this.abort.signal,
            body: {
              url: credentials.url.trim(),
              ...(credentials.token.trim() ? { token: credentials.token.trim() } : {}),
            },
          }),
        );
        if (!this.current(selection, context)) return;
        this.registered.set(agent);
        agentId = agent.id;
        this.secret.set({ url: '', token: '' });
        void this.store.refreshTargets();
      } catch (error) {
        if (this.current(selection, context)) this.error.set(errorMessage(error));
        return;
      } finally {
        if (!this.destroy.destroyed) this.registering.set(false);
      }
    }
    if (!this.current(selection, context)) return;
    const external = this.screen() === 'external';
    const machine = this.selectedMachine();
    if (!external && !machine?.ready) {
      this.error.set(machine?.reason ?? this.language.t('rooms.agents.unavailableHost'));
      return;
    }
    if (external && (!agentId || agentId === '__new__')) return;
    const body: RoomParticipantInput = {
      role: draft.role.trim(),
      instructions: draft.instructions,
      agent: external ? { agent: agentId } : machine?.local ? { local: true } : { machine: machine?.environmentId },
      ...(!external && draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(!external && selection.member?.thinking ? { thinking: selection.member.thinking } : {}),
    };
    const saved = selection.member ? await this.store.update(selection.member.role, body) : await this.store.add(body);
    if (saved && this.current(selection, context)) this.closed.emit();
  }
  protected async remove(): Promise<void> {
    const selection = this.selection();
    const context = this.store.context();
    if (!selection.member || this.busy()) return;
    if (await this.store.remove(selection.member.role)) {
      if (this.current(selection, context)) this.closed.emit();
    }
  }
}
