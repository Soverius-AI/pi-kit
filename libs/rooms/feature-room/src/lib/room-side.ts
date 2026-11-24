import { Component, computed, effect, inject, linkedSignal, output } from '@angular/core';
import { PkIcon, PkRunStatus } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { PlaybookTriggerState, RoomTask } from '@pi-kit/protocol';
import { OpenRoomStore, RoomAssistantStore } from '@pi-kit/rooms/data';
import { RoomFormat } from './room-format';
import { RoomChannels } from './room-channels';
import { RoomAssistant } from './room-assistant';
import { RoomDialog } from './room-dialog';
import { RoomAgents } from './room-agents';

type TaskGroup = { key: 'running' | 'done'; tasks: RoomTask[] };

@Component({
  selector: 'pk-room-side',
  imports: [PkIcon, PkRunStatus, TranslocoPipe, RoomChannels, RoomAssistant, RoomDialog, RoomAgents],
  providers: [RoomAssistantStore],
  styleUrl: './room-side.css',
  host: { class: 'pk-room-side', 'data-testid': 'room-side' },
  template: `
    <header class="panel-head">
      <h2>{{ 'rooms.side.room' | transloco }}</h2>
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
    @if (attentionCount()) {
      <section class="section attention" data-testid="room-side-attention">
        <header>
          <h3>{{ 'rooms.side.needsYou' | transloco }}</h3>
          <span class="count">{{ attentionCount() }}</span>
        </header>
        <ul class="tasks">
          @for (action of store.pendingActions(); track action.id) {
            <li>
              <button type="button" data-testid="room-side-action" (click)="focusAction.emit(action.id)">
                <pk-icon name="lock" size="13" /><span class="title">{{ action.summary }}</span>
              </button>
            </li>
          }
          @for (task of attentionTasks(); track task.id) {
            <li>
              <button
                type="button"
                data-testid="room-side-task"
                [attr.data-state]="task.state"
                (click)="focusTask.emit(task.id)"
              >
                <span class="dot" aria-hidden="true"></span><span class="title">{{ task.title }}</span>
                <span class="state">{{ 'rooms.task.state.' + task.state | transloco }}</span>
              </button>
            </li>
          }
          @for (work of reviewWork(); track work.id) {
            <li>
              <button type="button" data-testid="room-side-work" (click)="assistant.openWork()">
                <pk-icon name="warning" size="13" /><span class="title">{{ work.title }}</span>
              </button>
            </li>
          }
        </ul>
      </section>
    }
    @if (taskGroups().length) {
      <section class="section" data-testid="room-side-tasks">
        <header>
          <h3>{{ 'rooms.side.tasks' | transloco }}</h3>
          <span class="count">{{ store.tasks().length }}</span>
        </header>
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
                  <span class="dot" aria-hidden="true"></span><span class="title">{{ task.title }}</span>
                  <span class="state">{{ 'rooms.task.state.' + task.state | transloco }}</span>
                </button>
              </li>
            }
          </ul>
        }
      </section>
    }
    @if (store.runs().length) {
      <section class="section" data-testid="room-side-runs">
        <header>
          <h3>{{ 'rooms.runs.title' | transloco }}</h3>
          <span class="count">{{ store.runs().length }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-testid="room-side-all-runs"
            (click)="openRun.emit(undefined)"
          >
            {{ 'rooms.runs.all' | transloco }}
          </button>
        </header>
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
                <span class="title">{{ run.title }}</span
                ><span class="state font-mono">#{{ run.number }}</span>
              </button>
            </li>
          }
        </ul>
      </section>
    }
    <section class="section" data-testid="room-playbook">
      <header>
        <h3>{{ 'rooms.view.playbookPick' | transloco }}</h3>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          data-testid="room-playbook-change"
          (click)="dialog.set('playbook')"
        >
          {{ (store.playbook() ? 'rooms.side.change' : 'rooms.side.choosePlaybook') | transloco }}
        </button>
      </header>
      @if (store.playbook(); as playbook) {
        <div class="summary-row">
          <span class="title">{{ playbook }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-testid="room-playbook-open"
            (click)="openPlaybook.emit()"
          >
            {{ 'rooms.side.details' | transloco }}
          </button>
        </div>
        @if (store.stage()) {
          <p class="room-meta">{{ store.stage() }}</p>
        }
        @if (store.rehearsal()) {
          <p class="room-meta" data-testid="room-rehearsal-badge">{{ 'rooms.playbook.rehearsal' | transloco }}</p>
        }
        @if (triggers().length && store.paused()) {
          <p class="room-meta warn">{{ 'rooms.view.pausedHint' | transloco }}</p>
        }
      }
    </section>
    <pk-room-agents />
    <pk-room-channels />
    <pk-room-assistant #assistant />
    <section class="section" data-testid="room-side-files">
      <header>
        <h3>{{ 'rooms.side.files' | transloco }}</h3>
        <span class="count">{{ assistantStore.status()?.files?.length ?? 0 }}</span>
        <button type="button" class="btn btn-ghost btn-xs" data-testid="room-files-open" (click)="dialog.set('files')">
          {{ 'rooms.side.details' | transloco }}
        </button>
      </header>
    </section>

    @if (dialog() === 'playbook') {
      <pk-room-dialog
        [title]="'rooms.side.choosePlaybook' | transloco"
        [closeLabel]="'rooms.assistant.close' | transloco"
        (closed)="dialog.set(undefined)"
      >
        <label class="dialog-label"
          >{{ 'rooms.view.playbookPick' | transloco }}
          <select
            class="select select-bordered w-full"
            data-testid="room-playbook-select"
            [attr.aria-label]="'rooms.view.playbookPick' | transloco"
            [disabled]="store.lead() === 'working'"
            (change)="choosePlaybook($any($event.target))"
          >
            <option value="" [selected]="!store.playbook()">{{ 'rooms.side.none' | transloco }}</option>
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
          </select>
        </label>
        @if (store.playbookChoices()?.length === 0) {
          <button
            type="button"
            class="btn btn-sm"
            data-testid="room-playbook-create"
            [disabled]="store.lead() === 'working'"
            (click)="askForPlaybook()"
          >
            {{ 'rooms.view.askLeadForPlaybook' | transloco }}
          </button>
        }
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
        @if (triggers().length) {
          <section data-testid="room-side-triggers">
            <h3>{{ 'rooms.side.scheduled' | transloco }}</h3>
            <ul class="triggers">
              @for (trigger of triggers(); track trigger.id) {
                <li data-testid="room-side-trigger" [attr.data-kind]="trigger.kind">
                  <b>{{ trigger.id }}</b
                  ><span>{{ format.when(trigger) }}</span>
                  @if (trigger.nextRun !== null) {
                    <span>{{ 'rooms.playbook.next' | transloco: { value1: format.time(trigger.nextRun) } }}</span>
                  }
                </li>
              }
            </ul>
          </section>
        }
      </pk-room-dialog>
    }
    @if (dialog() === 'files') {
      <pk-room-dialog
        [title]="'rooms.side.roomFiles' | transloco"
        [closeLabel]="'rooms.assistant.close' | transloco"
        [busy]="assistantStore.busy()"
        [error]="assistantStore.error()"
        (closed)="dialog.set(undefined)"
      >
        @if (store.folder(); as folder) {
          <section>
            <h3>{{ 'rooms.side.roomFolder' | transloco }}</h3>
            <code data-testid="room-own-folder">{{ folder }}</code>
          </section>
        }
        @if (store.projectFolder(); as project) {
          <section data-testid="room-folder">
            <h3>{{ 'rooms.side.project' | transloco }}</h3>
            <code>{{ project }}</code>
          </section>
        }
        @if (store.playbookChoices()?.length) {
          <ul class="file-list">
            @for (playbook of store.playbookChoices(); track playbook.path) {
              <li
                data-testid="room-side-playbook"
                [attr.data-origin]="playbook.origin === 'room' ? 'room' : 'repository'"
              >
                <pk-icon name="skill" size="14" /><span>{{ playbook.name }}</span>
              </li>
            }
          </ul>
        }
        @for (file of assistantStore.status()?.files ?? []; track file.path) {
          <button
            type="button"
            class="file-download btn btn-sm btn-ghost"
            [disabled]="assistantStore.busy()"
            (click)="assistantStore.download(file.path)"
          >
            {{ file.path }} <span class="room-meta">{{ file.size }} B</span>
          </button>
        }
      </pk-room-dialog>
    }
  `,
})
export class RoomSide {
  readonly closed = output<void>();
  readonly openPlaybook = output<void>();
  readonly focusTask = output<string>();
  readonly focusAction = output<string>();
  readonly openRun = output<string | undefined>();
  protected readonly store = inject(OpenRoomStore);
  protected readonly assistantStore = inject(RoomAssistantStore);
  private readonly language = inject(Language);
  protected readonly format = inject(RoomFormat);
  protected readonly dialog = linkedSignal({
    source: () => {
      const room = this.store.room();
      return room ? JSON.stringify([room.hostInstanceId, room.id]) : '';
    },
    computation: () => undefined as 'playbook' | 'files' | undefined,
  });
  protected readonly stageIndex = computed(() => this.store.stages().indexOf(this.store.stage() ?? ''));
  protected readonly playbookNames = computed(
    () => new Set((this.store.playbookChoices() ?? []).map((option) => option.name)),
  );
  protected readonly triggers = computed<PlaybookTriggerState[]>(() =>
    this.store.playbook() ? (this.store.playbookDetail()?.triggers ?? []) : [],
  );
  protected readonly recentRuns = computed(() => this.store.runs().slice(0, 5));
  protected readonly attentionTasks = computed(() =>
    this.store
      .tasks()
      .filter(
        (task) =>
          task.state === 'proposed' ||
          task.state === 'submitted' ||
          task.state === 'failed' ||
          (task.state === 'running' && task.questions.length > 0),
      ),
  );
  protected readonly reviewWork = computed(
    () => this.assistantStore.status()?.work.filter((work) => work.state === 'review' || work.state === 'failed') ?? [],
  );
  protected readonly attentionCount = computed(
    () => this.attentionTasks().length + this.store.pendingActions().length + this.reviewWork().length,
  );
  protected readonly taskGroups = computed<TaskGroup[]>(() => {
    const rest = this.store.tasks().filter((task) => !this.attentionTasks().includes(task));
    return [
      { key: 'running', tasks: rest.filter((task) => task.state === 'running') },
      { key: 'done', tasks: rest.filter((task) => task.state !== 'running') },
    ].filter((group) => group.tasks.length) as TaskGroup[];
  });
  constructor() {
    effect((cleanup) => {
      this.assistantStore.visible.set(true);
      cleanup(() => this.assistantStore.visible.set(false));
    });
  }
  protected choosePlaybook(select: HTMLSelectElement): void {
    const value = select.value;
    if (value !== (this.store.playbook() ?? ''))
      void this.store.update({ playbook: value || null }).then(() => {
        select.value = this.store.playbook() ?? '';
      });
  }
  protected askForPlaybook(): void {
    this.dialog.set(undefined);
    void this.store.post(this.language.t('rooms.view.askLeadForPlaybookMessage'), 'lead');
  }
}
