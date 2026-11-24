import { Component, computed, inject, output } from '@angular/core';
import { PkIcon, PkRunStatus } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { PlaybookSummary, PlaybookTriggerState, RoomTask } from '@pi-kit/protocol';
import { OpenRoomStore } from '@pi-kit/rooms/data';
import { RoomFormat } from './room-format';
import { RoomChannels } from './room-channels';
import { RoomAssistant } from './room-assistant';

type TaskGroup = { key: 'needsYou' | 'running' | 'done'; tasks: RoomTask[] };

@Component({
  selector: 'pk-room-side',
  imports: [PkIcon, PkRunStatus, TranslocoPipe, RoomChannels, RoomAssistant],
  styleUrl: './room-side.css',
  host: { class: 'pk-room-side', 'data-testid': 'room-side' },
  template: `
    <header class="panel-head">
      <h2>{{ 'rooms.view.sideToggle' | transloco }}</h2>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        data-testid="room-side-close"
        [attr.aria-label]="'rooms.side.close' | transloco"
        (click)="closed.emit()"
      >
        <pk-icon name="close" size="16" />
      </button>
    </header>
    <pk-room-channels />
    <pk-room-assistant />
    <details class="section" open data-testid="room-playbook">
      <summary><pk-icon name="skill" size="14" />{{ 'rooms.view.playbookPick' | transloco }}</summary>
      <div class="body">
        <label class="pick">
          <select
            data-testid="room-playbook-select"
            [attr.aria-label]="'rooms.view.playbookPick' | transloco"
            [disabled]="store.lead() === 'working'"
            (change)="choosePlaybook($any($event.target))"
          >
            <option value="" [selected]="!store.playbook()">{{ 'rooms.view.noPlaybook' | transloco }}</option>
            @if (store.playbook(); as current) {
              @if (!playbookNames().has(current)) {
                <option [value]="current" selected>{{ current }}</option>
              }
            }
            @for (option of store.playbookChoices() ?? []; track option.path) {
              <option [value]="option.name" [disabled]="!!option.error" [selected]="option.name === store.playbook()">
                {{ option.name }}
                @if (option.error) {
                  · {{ option.error }}
                }
              </option>
            }
            @if (store.playbookChoices()?.length === 0) {
              <option [value]="askLead">{{ 'rooms.view.askLeadForPlaybook' | transloco }}</option>
            }
          </select>
          <pk-icon class="caret" name="chevron-down" size="12" />
        </label>
        @if (store.playbookChoices()?.length === 0 && !store.playbook()) {
          <p class="hint" data-testid="room-playbook-hint">{{ 'rooms.view.playbookHint' | transloco }}</p>
        }
        @if (store.playbook()) {
          @if (store.stages().length) {
            <ol class="stages" [attr.aria-label]="'rooms.view.stages' | transloco">
              @for (stage of store.stages(); track stage; let i = $index) {
                <li
                  [attr.aria-current]="stage === store.stage() ? 'step' : null"
                  [class.done]="i < stageIndex()"
                  data-testid="room-stage"
                >
                  <span class="dot" aria-hidden="true"></span>{{ stage }}
                </li>
              }
            </ol>
          }
          <div class="row">
            @if (store.rehearsal()) {
              <span class="pk-room-rehearsal" data-testid="room-rehearsal-badge"
                ><pk-icon name="flask" size="12" />{{ 'rooms.playbook.rehearsal' | transloco }}</span
              >
            }
            <button type="button" class="btn btn-xs" data-testid="room-playbook-open" (click)="openPlaybook.emit()">
              {{ 'rooms.playbook.open' | transloco }}
            </button>
          </div>
        }
      </div>
    </details>

    <details class="section" open data-testid="room-side-tasks">
      <summary>
        <pk-icon name="agents" size="14" />{{ 'rooms.side.tasks' | transloco }}
        @if (store.tasks().length) {
          <span class="count">{{ store.tasks().length }}</span>
        }
      </summary>
      <div class="body">
        @for (group of taskGroups(); track group.key) {
          <h4>{{ 'rooms.side.group.' + group.key | transloco }}</h4>
          <ul class="tasks">
            @for (task of group.tasks; track task.id) {
              <li>
                <button
                  type="button"
                  data-testid="room-side-task"
                  [attr.data-state]="task.state"
                  (click)="focusTask.emit(task.id)"
                >
                  <span class="dot" aria-hidden="true"></span>
                  <span class="title">{{ task.title }}</span>
                  <span class="state">{{ 'rooms.task.state.' + task.state | transloco }}</span>
                </button>
              </li>
            }
          </ul>
        } @empty {
          <p class="hint" data-testid="room-side-no-tasks">{{ 'rooms.side.noTasks' | transloco }}</p>
        }
      </div>
    </details>

    <details class="section" open data-testid="room-side-runs">
      <summary>
        <pk-icon name="reload" size="14" />{{ 'rooms.runs.title' | transloco }}
        @if (store.runs().length) {
          <span class="count">{{ store.runs().length }}</span>
        }
      </summary>
      <div class="body">
        <ul class="tasks">
          @for (run of recentRuns(); track run.id) {
            <li>
              <button
                type="button"
                data-testid="room-side-run"
                [attr.data-state]="run.state"
                (click)="openRun.emit(run.id)"
              >
                <pk-run-status [state]="run.state" [label]="'rooms.runs.state.' + run.state | transloco" [size]="14" />
                <span class="title">{{ run.title }}</span>
                <span class="state font-mono">#{{ run.number }}</span>
              </button>
            </li>
          } @empty {
            <li class="hint" data-testid="room-side-no-runs">{{ 'rooms.side.noRuns' | transloco }}</li>
          }
        </ul>
        @if (store.runs().length) {
          <div class="row">
            <button type="button" class="btn btn-xs" data-testid="room-side-all-runs" (click)="openRun.emit(undefined)">
              {{ 'rooms.runs.all' | transloco }}
            </button>
          </div>
        }
      </div>
    </details>

    <details class="section" open data-testid="room-side-triggers">
      <summary>
        <pk-icon name="refresh" size="14" />{{ 'rooms.side.scheduled' | transloco }}
        @if (triggers().length) {
          <span class="count">{{ triggers().length }}</span>
        }
      </summary>
      <div class="body">
        @if (triggers().length && store.paused()) {
          <p class="hint warn">{{ 'rooms.view.pausedHint' | transloco }}</p>
        }
        <ul class="triggers">
          @for (trigger of triggers(); track trigger.id) {
            <li data-testid="room-side-trigger" [attr.data-kind]="trigger.kind">
              <pk-icon [name]="trigger.kind === 'poll' ? 'refresh' : 'sparkle'" size="13" />
              <span class="main">
                <b>{{ trigger.id }}</b>
                <span class="when font-mono">{{ format.when(trigger) }}</span>
                @if (trigger.nextRun !== null) {
                  <span class="next">{{
                    'rooms.playbook.next' | transloco: { value1: format.time(trigger.nextRun) }
                  }}</span>
                }
              </span>
            </li>
          } @empty {
            <li class="hint" data-testid="room-side-no-triggers">{{ 'rooms.side.nothingScheduled' | transloco }}</li>
          }
        </ul>
      </div>
    </details>

    <details class="section" open data-testid="room-side-files">
      <summary><pk-icon name="folder" size="14" />{{ 'rooms.side.files' | transloco }}</summary>
      <div class="body">
        <ul class="tree">
          @if (store.folder(); as folder) {
            <li>
              <span class="node"><pk-icon name="folder" size="13" />{{ 'rooms.side.roomFolder' | transloco }}</span>
              <span class="path font-mono" data-testid="room-own-folder" [title]="folder">{{
                leftToRight + folder
              }}</span>
              <ul>
                <li>
                  <span class="node"><pk-icon name="folder" size="13" />playbooks</span>
                  <ul>
                    @for (playbook of roomPlaybooks(); track playbook.path) {
                      <li>
                        <span
                          class="node leaf"
                          data-testid="room-side-playbook"
                          data-origin="room"
                          [class.current]="playbook.name === store.playbook()"
                          ><pk-icon name="skill" size="13" />{{ playbook.name }}</span
                        >
                      </li>
                    } @empty {
                      <li class="hint">{{ 'rooms.side.noRoomPlaybooks' | transloco }}</li>
                    }
                  </ul>
                </li>
              </ul>
            </li>
          }
          @if (store.projectFolder(); as project) {
            <li data-testid="room-folder">
              <span class="node"><pk-icon name="folder" size="13" />{{ 'rooms.side.project' | transloco }}</span>
              <span class="path font-mono" [title]="project">{{ leftToRight + project }}</span>
              @if (projectPlaybooks().length) {
                <ul>
                  @for (playbook of projectPlaybooks(); track playbook.path) {
                    <li>
                      <span
                        class="node leaf"
                        data-testid="room-side-playbook"
                        data-origin="repository"
                        [class.current]="playbook.name === store.playbook()"
                        ><pk-icon name="skill" size="13" />{{ playbook.name }}</span
                      >
                    </li>
                  }
                </ul>
              }
            </li>
          }
        </ul>
      </div>
    </details>

    @if (store.memory().length) {
      <details class="section" open data-testid="room-notebook">
        <summary>
          <pk-icon name="pencil" size="14" />{{ 'rooms.side.notebook' | transloco }}
          <span class="count">{{ store.memory().length }}</span>
        </summary>
        <dl class="body notebook">
          @for (entry of store.memory(); track entry.scope + entry.key) {
            <dt>
              {{ entry.key }}
              @if (entry.scope === 'playbook') {
                <span class="scope">{{ 'rooms.view.playbookNote' | transloco }}</span>
              }
            </dt>
            <dd>{{ entry.text }}</dd>
          }
        </dl>
      </details>
    }
  `,
})
export class RoomSide {
  readonly closed = output<void>();
  readonly openPlaybook = output<void>();
  readonly focusTask = output<string>();
  readonly openRun = output<string | undefined>();
  protected readonly store = inject(OpenRoomStore);
  private readonly language = inject(Language);
  protected readonly format = inject(RoomFormat);
  protected readonly askLead = 'ask-lead';
  protected readonly leftToRight = '\u200e';
  protected readonly stageIndex = computed(() => this.store.stages().indexOf(this.store.stage() ?? ''));
  protected readonly playbookNames = computed(
    () => new Set((this.store.playbookChoices() ?? []).map((option) => option.name)),
  );
  protected readonly triggers = computed<PlaybookTriggerState[]>(() =>
    this.store.playbook() ? (this.store.playbookDetail()?.triggers ?? []) : [],
  );
  protected readonly roomPlaybooks = computed<PlaybookSummary[]>(() =>
    (this.store.playbookChoices() ?? []).filter((playbook) => playbook.origin === 'room'),
  );
  protected readonly projectPlaybooks = computed<PlaybookSummary[]>(() =>
    (this.store.playbookChoices() ?? []).filter((playbook) => playbook.origin !== 'room'),
  );
  protected readonly recentRuns = computed(() => this.store.runs().slice(0, 5));
  protected readonly taskGroups = computed<TaskGroup[]>(() => {
    const tasks = this.store.tasks();
    const needsYou = tasks.filter(
      (task) =>
        task.state === 'proposed' ||
        task.state === 'submitted' ||
        (task.state === 'running' && task.questions.length > 0),
    );
    const running = tasks.filter((task) => task.state === 'running' && task.questions.length === 0);
    const done = tasks.filter((task) => !needsYou.includes(task) && !running.includes(task));
    const groups: TaskGroup[] = [
      { key: 'needsYou', tasks: needsYou },
      { key: 'running', tasks: running },
      { key: 'done', tasks: done },
    ];
    return groups.filter((group) => group.tasks.length > 0);
  });

  protected choosePlaybook(select: HTMLSelectElement): void {
    const value = select.value;
    if (value === this.askLead) {
      select.value = this.store.playbook() ?? '';
      void this.store.post(this.language.t('rooms.view.askLeadForPlaybookMessage'), 'lead');
      return;
    }
    if (value !== (this.store.playbook() ?? ''))
      void this.store.update({ playbook: value || null }).then(() => (select.value = this.store.playbook() ?? ''));
  }
}
