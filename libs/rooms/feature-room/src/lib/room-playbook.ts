import { Component, computed, inject, input, model, output, signal } from '@angular/core';
import {
  PkIcon,
  type PkIconName,
  PkNotice,
  type PkRunState,
  PkRunStatus,
  PkTabPanel,
  PkTabs,
  PkTip,
} from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import {
  PlaybookProposalSchema,
  type PlaybookAgentSettings,
  type PlaybookConfig,
  type PlaybookFireResult,
  type PlaybookTool,
  type PlaybookTriggerState,
  type PlaybookTryResult,
  type RoomAction,
} from '@pi-kit/protocol';
import { OpenRoomStore } from '@pi-kit/rooms/data';
import { RoomFormat } from './room-format';
import { PkDiffViewer, modelFromActivity } from '@pi-kit/ui';
import { RoomRuns } from './room-runs';

type Connector = { name: string; tool: PlaybookTool; output?: { mode: 'draft' | 'auto'; max?: number } };

@Component({
  selector: 'pk-room-playbook',
  imports: [PkIcon, PkNotice, PkRunStatus, PkTabPanel, PkTabs, PkTip, RoomRuns, TranslocoPipe],
  styleUrl: './room-playbook.css',
  host: { class: 'pk-room-playbook-panel', 'data-testid': 'room-playbook-panel' },
  template: `
    @if (store.playbookDetail(); as detail) {
      <header class="top">
        <span class="mark" aria-hidden="true"><pk-icon name="skill" size="18" /></span>
        <div class="about">
          <div class="name">
            <h2>{{ detail.name }}</h2>
            <span class="pill" data-testid="room-playbook-status" [attr.data-status]="status()">{{
              'rooms.playbook.status.' + status() | transloco
            }}</span>
            <span class="chip" data-testid="room-playbook-origin">{{
              'rooms.playbook.origin.' + detail.origin | transloco
            }}</span>
          </div>
          @if (detail.description) {
            <p class="description">{{ detail.description }}</p>
          }
          <span class="font-mono path">{{ detail.folder }}</span>
        </div>
        <div class="actions">
          <label class="rehearse" [class.on]="store.rehearsal()" [pkTip]="'rooms.playbook.rehearsalTip' | transloco">
            <input
              type="checkbox"
              class="toggle toggle-xs toggle-warning"
              data-testid="room-rehearsal"
              [checked]="store.rehearsal()"
              (change)="store.update({ rehearsal: $any($event.target).checked })"
            />
            <pk-icon name="flask" size="13" />{{ 'rooms.playbook.rehearsal' | transloco }}
          </label>
          <button type="button" class="btn btn-xs" data-testid="room-playbook-change" (click)="askChange.emit()">
            <pk-icon name="pencil" size="12" />{{ 'rooms.playbook.change' | transloco }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square"
            [attr.aria-label]="'rooms.playbook.close' | transloco"
            (click)="closed.emit()"
          >
            <pk-icon name="close" size="12" />
          </button>
        </div>
      </header>
      @if (store.rehearsal()) {
        <p class="rehearsing" data-testid="room-rehearsing">
          <pk-icon name="flask" size="13" />{{ 'rooms.playbook.rehearsing' | transloco }}
        </p>
      }
      @if (detail.error) {
        <pk-notice tone="error" [text]="detail.error" />
      }

      <pk-tabs [label]="detail.name" [(value)]="tab">
        <pk-tab-panel value="overview" [label]="'rooms.playbook.overview' | transloco">
          @if (detail.config; as config) {
            <div class="graph" data-testid="room-playbook-flow">
              <section class="lane">
                <h4>{{ 'rooms.playbook.wakes' | transloco }}</h4>
                @for (trigger of detail.triggers; track trigger.id) {
                  <div class="node" data-testid="room-playbook-trigger" [attr.data-kind]="trigger.kind">
                    <div class="title">
                      <pk-icon [name]="trigger.kind === 'poll' ? 'refresh' : 'sparkle'" size="13" />
                      <b>{{ trigger.id }}</b>
                    </div>
                    <span class="muted font-mono">{{ format.when(trigger) }}</span>
                    @if (trigger.nextRun !== null) {
                      <span class="muted">{{
                        'rooms.playbook.next' | transloco: { value1: format.time(trigger.nextRun) }
                      }}</span>
                    }
                    <div class="buttons">
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        data-testid="room-trigger-dry"
                        [disabled]="busy() === trigger.id"
                        (click)="fire(trigger, true)"
                      >
                        <pk-icon name="eye" size="12" />{{
                          (trigger.kind === 'poll' ? 'rooms.playbook.dryRun' : 'rooms.playbook.preview') | transloco
                        }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-xs"
                        data-testid="room-trigger-run"
                        [disabled]="busy() === trigger.id || store.paused()"
                        (click)="fire(trigger, false)"
                      >
                        <pk-icon name="arrow-right" size="12" />{{ 'rooms.playbook.runNow' | transloco }}
                      </button>
                    </div>
                    @if (fired()[trigger.id]; as result) {
                      <div class="result" data-testid="room-trigger-result">
                        @if (typeof result === 'string') {
                          <span class="error">{{ result }}</span>
                        } @else {
                          <span>{{ result.text }}</span>
                          @if (result.items.length) {
                            <ul class="items">
                              @for (item of result.items; track item.key) {
                                <li [class.fresh]="item.fresh">{{ item.key }}</li>
                              }
                            </ul>
                          }
                        }
                      </div>
                    }
                  </div>
                } @empty {
                  <p class="node muted">{{ 'rooms.playbook.onlyMessages' | transloco }}</p>
                }
              </section>
              <span class="wire" aria-hidden="true"></span>
              <section class="lane">
                <h4>{{ 'rooms.view.lead' | transloco }}</h4>
                <div class="node lead" [attr.data-state]="leadState()">
                  <div class="title">
                    <pk-run-status [state]="leadState()" [label]="'rooms.playbook.lead.' + leadState() | transloco" />
                    <b>{{ 'rooms.view.lead' | transloco }}</b>
                    <span class="muted">{{ 'rooms.playbook.lead.' + leadState() | transloco }}</span>
                  </div>
                  @if (settingsOf(config.lead); as lead) {
                    <span class="muted font-mono" data-testid="room-playbook-lead-model">{{ lead }}</span>
                  }
                  @if (settingsOf(config.workers); as workers) {
                    <span class="muted" data-testid="room-playbook-workers-model"
                      >{{ 'rooms.playbook.workersRun' | transloco }} <span class="font-mono">{{ workers }}</span></span
                    >
                  }
                  <div class="stats">
                    <button type="button" (click)="tab.set('tools')">
                      <b>{{ tools().length }}</b
                      >{{ 'rooms.playbook.statTools' | transloco }}
                    </button>
                    <button type="button" (click)="tab.set('tools')">
                      <b>{{ outputs().length }}</b
                      >{{ 'rooms.playbook.statOutputs' | transloco }}
                    </button>
                    <button type="button" (click)="tab.set('participants')">
                      <b>{{ config.participants.length }}</b
                      >{{ 'rooms.playbook.statParticipants' | transloco }}
                    </button>
                  </div>
                </div>
              </section>
              <span class="wire" aria-hidden="true"></span>
              <section class="lane">
                <h4>{{ 'rooms.view.stages' | transloco }}</h4>
                <ol class="chain">
                  @for (stage of config.stages; track stage; let i = $index) {
                    <li
                      class="node stage"
                      data-testid="room-playbook-stage"
                      [attr.data-state]="stageState(i)"
                      [attr.aria-current]="stage === detail.stage ? 'step' : null"
                    >
                      <pk-run-status
                        [state]="stageState(i)"
                        [label]="'rooms.playbook.stageState.' + stageState(i) | transloco"
                      />
                      <span class="label">{{ stage }}</span>
                      @if (config.gates[stage] === 'owner') {
                        <span class="gate" [pkTip]="'rooms.playbook.ownerGate' | transloco"
                          ><pk-icon name="lock" size="11" />{{ 'rooms.playbook.gate' | transloco }}</span
                        >
                      }
                    </li>
                  } @empty {
                    <li class="node muted">{{ 'rooms.playbook.noStages' | transloco }}</li>
                  }
                </ol>
              </section>
            </div>
          }
        </pk-tab-panel>

        <pk-tab-panel value="runs" [label]="'rooms.runs.title' | transloco" [count]="store.runs().length">
          <pk-room-runs [(selected)]="run" />
        </pk-tab-panel>

        @if (detail.config; as config) {
          <pk-tab-panel value="tools" [label]="'rooms.playbook.toolsTab' | transloco" [count]="connectors().length">
            <ul class="list">
              @for (connector of connectors(); track connector.name) {
                <li class="tool" data-testid="room-playbook-tool" [attr.data-name]="connector.name">
                  <span class="kind" [attr.data-kind]="kindOf(connector.tool)">
                    <pk-icon [name]="kindIcon(connector.tool)" size="14" />
                  </span>
                  <div class="main">
                    <div class="title">
                      <b class="font-mono">{{ connector.name }}</b>
                      <span class="tag">{{ 'rooms.playbook.kind.' + kindOf(connector.tool) | transloco }}</span>
                      @if (connector.output; as output) {
                        <span class="tag" [attr.data-mode]="output.mode">{{
                          'rooms.playbook.mode.' + output.mode | transloco
                        }}</span>
                        <span class="muted">{{
                          (output.max ? 'rooms.playbook.usedOf' : 'rooms.playbook.used')
                            | transloco: { value1: detail.usage[connector.name] ?? 0, value2: output.max }
                        }}</span>
                      }
                    </div>
                    @if (connector.tool.description) {
                      <p class="muted">{{ connector.tool.description }}</p>
                    }
                    @if (needs(config, connector.tool); as needed) {
                      @if (needed.length) {
                        <div class="params">
                          @for (param of needed; track param) {
                            <input
                              class="input input-xs font-mono"
                              [placeholder]="param"
                              [attr.aria-label]="param"
                              [value]="params()[connector.name]?.[param] ?? ''"
                              (input)="setParam(connector.name, param, $any($event.target).value)"
                            />
                          }
                        </div>
                      }
                    }
                    @if (tried()[connector.name]; as result) {
                      @if (typeof result === 'string') {
                        <pre class="out error" data-testid="room-playbook-try-result">{{ result }}</pre>
                      } @else {
                        <pre class="out" data-testid="room-playbook-try-result" [class.error]="!result.ok">{{
                          shown(result)
                        }}</pre>
                      }
                    }
                  </div>
                  <button
                    type="button"
                    class="btn btn-xs"
                    data-testid="room-playbook-try"
                    [disabled]="busy() === connector.name"
                    (click)="tryIt(connector.name)"
                  >
                    @if (busy() === connector.name) {
                      <span class="loading loading-spinner loading-xs"></span>
                    } @else {
                      <pk-icon [name]="connector.output ? 'eye' : 'arrow-right'" size="12" />
                    }
                    {{ (connector.output ? 'rooms.playbook.preview' : 'rooms.playbook.try') | transloco }}
                  </button>
                </li>
              } @empty {
                <li class="muted">{{ 'rooms.playbook.noTools' | transloco }}</li>
              }
            </ul>
          </pk-tab-panel>

          @if (config.participants.length) {
            <pk-tab-panel
              value="participants"
              [label]="'rooms.playbook.participants' | transloco"
              [count]="config.participants.length"
            >
              <ul class="list">
                @for (participant of config.participants; track participant.role) {
                  @let check = checkOf('participant ' + participant.role);
                  <li class="participant" data-testid="room-playbook-participant">
                    <span class="kind"><pk-icon name="agents" size="14" /></span>
                    <div class="main">
                      <div class="title">
                        <b>{{ participant.role }}</b>
                        <span class="muted">{{
                          participant.agent.machine ?? participant.agent.agent ?? ('rooms.view.hostHere' | transloco)
                        }}</span>
                        @if (settingsOf(participant); as settings) {
                          <span class="tag font-mono" data-testid="room-playbook-participant-model">{{
                            settings
                          }}</span>
                        }
                        @if (check) {
                          <span class="check" [attr.data-level]="check.level">{{ check.message }}</span>
                        }
                      </div>
                      @if (participant.instructions) {
                        <p class="muted">{{ firstLine(participant.instructions) }}</p>
                      }
                    </div>
                  </li>
                }
              </ul>
            </pk-tab-panel>
          }
        }

        <pk-tab-panel value="checks" [label]="'rooms.playbook.checks' | transloco" [count]="problems()">
          <ul class="list checks" data-testid="room-playbook-checks">
            @for (check of detail.checks; track check.subject) {
              <li class="check-row" [attr.data-level]="check.level">
                <pk-icon
                  [name]="check.level === 'ok' ? 'check' : check.level === 'warn' ? 'warning' : 'alert-circle'"
                  size="13"
                />
                <span class="font-mono subject">{{ check.subject }}</span>
                <span>{{ check.message }}</span>
              </li>
            } @empty {
              <li class="muted">{{ 'rooms.playbook.nothingToCheck' | transloco }}</li>
            }
          </ul>
        </pk-tab-panel>

        <pk-tab-panel value="files" [label]="'rooms.playbook.files' | transloco">
          @for (file of files(); track file.name) {
            <details class="file">
              <summary>
                <pk-icon name="file-code" size="13" /><span class="font-mono">{{ detail.folder }}/{{ file.name }}</span>
              </summary>
              <pre>{{ file.text }}</pre>
            </details>
          }
        </pk-tab-panel>
      </pk-tabs>
    } @else if (store.playbookDetailError(); as message) {
      <pk-notice tone="error" [text]="message" />
    } @else {
      <p class="muted">{{ 'rooms.view.loading' | transloco }}</p>
    }
  `,
})
export class RoomPlaybook {
  protected readonly store = inject(OpenRoomStore);
  private readonly language = inject(Language);
  protected readonly format = inject(RoomFormat);
  readonly askChange = output<void>();
  readonly closed = output<void>();
  protected readonly busy = signal<string | undefined>(undefined);
  protected readonly params = signal<Record<string, Record<string, string>>>({});
  protected readonly tried = signal<Record<string, PlaybookTryResult | string>>({});
  protected readonly fired = signal<Record<string, PlaybookFireResult | string>>({});
  protected readonly tools = computed<Connector[]>(() =>
    Object.entries(this.store.playbookDetail()?.config?.tools ?? {}).map(([name, tool]) => ({ name, tool })),
  );
  protected readonly outputs = computed<Connector[]>(() =>
    Object.entries(this.store.playbookDetail()?.config?.['safe-outputs'] ?? {}).map(([name, output]) => ({
      name,
      tool: output,
      output: { mode: output.mode, max: output.max },
    })),
  );

  protected readonly connectors = computed(() => [...this.tools(), ...this.outputs()]);
  readonly tab = model('overview');
  readonly run = model<string | undefined>(undefined);
  protected readonly status = computed(() =>
    this.store.paused() ? 'paused' : this.store.rehearsal() ? 'rehearsal' : 'active',
  );
  protected readonly leadState = computed<PkRunState>(() =>
    this.store.lead() === 'working' ? 'running' : this.store.lead() === 'error' ? 'failed' : 'pending',
  );
  protected readonly stageAt = computed(() => {
    const detail = this.store.playbookDetail();
    return detail?.config?.stages.indexOf(detail.stage ?? '') ?? -1;
  });
  protected settingsOf(settings: PlaybookAgentSettings | undefined): string {
    return [
      settings?.model,
      settings?.thinking &&
        this.language.t('rooms.playbook.thinking', {
          value1: this.language.t(`common.effortValue.${settings.thinking}`),
        }),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  protected stageState(index: number): PkRunState {
    const at = this.stageAt();
    if (index < at) return 'done';
    if (index > at) return 'pending';
    return this.store.lead() === 'working' ? 'running' : 'current';
  }
  protected readonly files = computed(() => {
    const detail = this.store.playbookDetail();
    return detail
      ? [
          { name: 'SKILL.md', text: detail.skill },
          { name: 'room.yaml', text: detail.yaml },
        ]
      : [];
  });
  protected readonly problems = computed(
    () => this.store.playbookDetail()?.checks.filter((check) => check.level !== 'ok').length ?? 0,
  );

  constructor() {
    void this.store.loadPlaybookDetail();
  }

  protected kindIcon(tool: PlaybookTool): PkIconName {
    return tool.mcp ? 'settings-mcp' : tool.mail ? 'comment' : tool.calendar ? 'pin' : 'terminal';
  }

  protected kindOf(tool: PlaybookTool): 'command' | 'mcp' | 'mail' | 'calendar' {
    return tool.mcp ? 'mcp' : tool.mail ? 'mail' : tool.calendar ? 'calendar' : 'command';
  }

  /** The parameters the lead fills in; the playbook's vars and the room's own values are filled already. */
  protected needs(config: PlaybookConfig, tool: PlaybookTool): string[] {
    const source = tool.run ? tool.run.join(' ') : JSON.stringify(tool.mcp?.args ?? tool.calendar ?? {});
    return [
      ...new Set([...source.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((match) => match[1] as string)),
    ].filter((key) => !(key in config.vars) && key !== 'repository' && key !== 'room');
  }

  protected checkOf(subject: string) {
    return this.store.playbookDetail()?.checks.find((check) => check.subject === subject);
  }

  protected firstLine(text: string): string {
    return text.split('\n')[0] ?? '';
  }

  protected shown(result: PlaybookTryResult): string {
    if (!result.ran) return `${this.language.t('rooms.playbook.wouldRun')} ${result.call}`;
    return `$ ${result.call}\n\n${result.output || this.language.t('rooms.playbook.noOutput')}`;
  }

  protected setParam(tool: string, param: string, value: string): void {
    this.params.update((all) => ({ ...all, [tool]: { ...all[tool], [param]: value } }));
  }

  protected async tryIt(tool: string): Promise<void> {
    this.busy.set(tool);
    const result = await this.store.tryTool(tool, this.params()[tool] ?? {});
    this.tried.update((all) => ({ ...all, [tool]: result }));
    this.busy.set(undefined);
  }

  protected async fire(trigger: PlaybookTriggerState, dry: boolean): Promise<void> {
    this.busy.set(trigger.id);
    const result = await this.store.fireTrigger(trigger.id, dry);
    this.fired.update((all) => ({ ...all, [trigger.id]: result }));
    this.busy.set(undefined);
  }
}

/** A proposed playbook's checks that did not pass and its diff per file. */
@Component({
  selector: 'pk-room-proposal',
  imports: [PkDiffViewer, PkIcon, TranslocoPipe],
  template: `
    @if (proposal(); as proposal) {
      @for (check of proposal.problems; track check.subject) {
        <p class="check-row" [attr.data-level]="check.level" data-testid="room-proposal-check">
          <pk-icon [name]="check.level === 'warn' ? 'warning' : 'alert-circle'" size="12" />
          <span class="font-mono">{{ check.subject }}</span> {{ check.message }}
        </p>
      }
      @for (file of proposal.files; track file.path) {
        <div class="pk-room-proposal-file" data-testid="room-proposal-file">
          <span class="font-mono path">{{ file.path }}</span>
          <span class="add">+{{ file.added }}</span
          ><span class="del">−{{ file.removed }}</span>
          <pk-diff [model]="file" [compact]="true" />
        </div>
      }
    }
    <p class="where">{{ 'rooms.action.playbookWhere' | transloco }}</p>
  `,
})
export class RoomProposal {
  readonly action = input.required<RoomAction>();
  protected readonly proposal = computed(() => {
    const parsed = PlaybookProposalSchema.safeParse(this.action().payload);
    if (!parsed.success) return undefined;
    return {
      files: parsed.data.files.map((file) => modelFromActivity(file)),
      problems: parsed.data.checks.filter((check) => check.level !== 'ok'),
    };
  });
}
