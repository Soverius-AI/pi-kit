import { NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  type Type,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { PkAvatar, PkEnvGlyph, PkIcon, PkNotice, PkProtectionBadge, PkTip } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { PlaybookProposalSchema, type RoomAction, type RoomImage } from '@pi-kit/protocol';
import { OpenRoomStore, ROOM_LEAD_CONTROLS, ROOM_MCP_APP, ROOM_PROSE, type RoomRoute } from '@pi-kit/rooms/data';
import { RoomAsk } from './room-ask';
import { RoomPlaybook, RoomProposal } from './room-playbook';

@Component({
  selector: 'pk-room-view',
  imports: [
    NgComponentOutlet,
    NgTemplateOutlet,
    PkAvatar,
    PkEnvGlyph,
    PkIcon,
    PkNotice,
    PkProtectionBadge,
    PkTip,
    RoomAsk,
    RoomPlaybook,
    RoomProposal,
    TranslocoPipe,
  ],
  host: { class: 'pk-room-view row-start-3 row-span-2 min-h-0', 'data-testid': 'room-view' },
  template: `
    @if (store.room(); as room) {
      <div class="pk-room-scroll" #scroller>
        <div class="pk-room-column">
          <header class="pk-room-head">
            <span class="pk-room-tag"><pk-icon name="room" size="14" />{{ 'rooms.view.tag' | transloco }}</span>
            <h1>{{ room.title }}</h1>
            <p class="meta">
              <span class="font-mono">{{ room.repository }}</span> · {{ room.baseCommit.slice(0, 7) }} ·
              {{ 'rooms.view.hostHere' | transloco }}
            </p>
            <div class="pk-room-autonomy" data-testid="room-autonomy">
              <div
                class="pk-seg"
                role="radiogroup"
                [attr.aria-label]="'rooms.view.autonomy' | transloco"
                data-testid="room-mode"
              >
                @for (mode of modes; track mode) {
                  <button
                    type="button"
                    role="radio"
                    [attr.data-testid]="'room-mode-' + mode"
                    [attr.aria-checked]="store.mode() === mode"
                    [pkTip]="'rooms.view.modeTip.' + mode | transloco"
                    (click)="store.mode() !== mode && store.update({ mode })"
                  >
                    {{ 'rooms.view.mode.' + mode | transloco }}
                  </button>
                }
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                data-testid="room-pause"
                [attr.aria-pressed]="store.paused()"
                (click)="store.update({ paused: !store.paused() })"
              >
                {{ (store.paused() ? 'rooms.view.resume' : 'rooms.view.pause') | transloco }}
              </button>
              @if (store.paused()) {
                <span class="pk-room-paused" data-testid="room-paused">{{ 'rooms.view.pausedHint' | transloco }}</span>
              }
            </div>
            <div class="pk-room-pbar" data-testid="room-playbook" [class.open]="panel() && !!store.playbook()">
              <label class="pick">
                <pk-icon name="skill" size="14" />
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
                    <option
                      [value]="option.name"
                      [disabled]="!!option.error"
                      [selected]="option.name === store.playbook()"
                    >
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
                <span class="hint" data-testid="room-playbook-hint">{{ 'rooms.view.playbookHint' | transloco }}</span>
              }
              @if (store.playbook()) {
                @if (store.stages().length) {
                  <ol class="stepper" [attr.aria-label]="'rooms.view.stages' | transloco">
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
                @if (store.rehearsal()) {
                  <span class="pk-room-rehearsal" data-testid="room-rehearsal-badge"
                    ><pk-icon name="flask" size="12" />{{ 'rooms.playbook.rehearsal' | transloco }}</span
                  >
                }
                <button
                  type="button"
                  class="details"
                  data-testid="room-playbook-open"
                  [attr.aria-expanded]="panel()"
                  (click)="panel.set(!panel())"
                >
                  {{ 'rooms.playbook.open' | transloco }}
                  <pk-icon name="chevron-down" size="12" />
                </button>
              }
            </div>
            @if (panel() && store.playbook()) {
              <pk-room-playbook (askChange)="askToChange()" (closed)="panel.set(false)" />
            }
            @if (store.memory().length) {
              <details class="pk-room-notebook" data-testid="room-notebook">
                <summary>{{ 'rooms.view.notebookN' | transloco: { value1: store.memory().length } }}</summary>
                <dl>
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
            @if (store.projectFolder(); as folder) {
              <p class="meta" data-testid="room-folder">
                {{ 'rooms.view.integratesInto' | transloco }} <span class="font-mono">{{ folder }}</span>
              </p>
            }
          </header>

          @if (store.summary()) {
            <div class="pk-room-summary" data-testid="room-summary">
              <span class="label">{{ 'rooms.view.sharedSummary' | transloco }}</span>
              <p>{{ store.summary() }}</p>
            </div>
          }

          @if (store.loading()) {
            <p class="pk-room-hint">{{ 'rooms.view.loading' | transloco }}</p>
          } @else if (!store.events().length) {
            <p class="pk-room-hint" data-testid="room-empty">{{ 'rooms.view.empty' | transloco }}</p>
          }

          <ol class="pk-room-events" [attr.aria-label]="'rooms.view.conversation' | transloco">
            @for (event of store.events(); track event.seq) {
              @switch (event.kind === 'task' ? 'task' : event.actor) {
                @case ('owner') {
                  <li class="pk-room-msg me" data-testid="room-message" data-actor="owner">
                    <span class="by">
                      {{ 'rooms.view.you' | transloco }}
                      <pk-avatar [name]="'rooms.view.you' | transloco" kind="person" />
                    </span>
                    <div class="bubble">{{ event.text }}</div>
                    @if (event.images) {
                      <span class="images" data-testid="room-message-images">
                        <pk-icon name="camera" size="12" />{{
                          'rooms.view.imagesN' | transloco: { value1: event.images }
                        }}
                      </span>
                    }
                  </li>
                }
                @case ('lead') {
                  @if (event.kind === 'note') {
                    <li class="pk-room-note lead" data-testid="room-lead-note">
                      <pk-icon name="agents" size="14" />
                      @if (event.text.length > 160) {
                        <details>
                          <summary>{{ event.text.slice(0, 160) }}…</summary>
                          <span class="full">{{ event.text }}</span>
                        </details>
                      } @else {
                        <span>{{ event.text }}</span>
                      }
                    </li>
                  } @else if (event.kind === 'app') {
                    @if (event.app && mcpApp() && store.leadThreadId()) {
                      <li data-testid="room-app">
                        <ng-container
                          *ngComponentOutlet="
                            mcpApp();
                            inputs: {
                              threadId: store.leadThreadId(),
                              ownerId: room.hostInstanceId,
                              app: event.app,
                              id: 'room-app:' + event.seq,
                              send: sendToLead,
                            }
                          "
                        />
                      </li>
                    }
                  } @else {
                    @let host = hostName() ?? ('rooms.view.hostHere' | transloco);
                    <li class="pk-room-msg" data-testid="room-message" data-actor="lead">
                      <span class="by">
                        <pk-avatar
                          [name]="host"
                          participant="lead"
                          [look]="hostLook()"
                          [label]="('rooms.view.lead' | transloco) + ' · ' + host"
                        />
                        <b>{{ 'rooms.view.lead' | transloco }}</b>
                        <span class="kind"
                          ><pk-icon name="agents" size="12" />{{ 'rooms.view.agent' | transloco }}</span
                        >
                        <span class="env">
                          @if (hostLook(); as look) {
                            <pk-env-glyph [look]="look" />
                          }
                          {{ host }}</span
                        >
                      </span>
                      @if (prose(); as markdown) {
                        <div class="text md" data-testid="room-message-markdown">
                          <ng-container *ngComponentOutlet="markdown; inputs: { text: event.text }" />
                        </div>
                      } @else {
                        <div class="text">{{ event.text }}</div>
                      }
                    </li>
                  }
                }
                @case ('worker') {
                  <ng-container *ngTemplateOutlet="workerSays; context: { $implicit: event }" />
                }
                @case ('consultant') {
                  <li class="pk-room-msg worker" data-testid="room-message" data-actor="consultant">
                    <span class="by">
                      @let consultantLook = store.machineLook(event.environmentId ?? room.hostInstanceId);
                      <pk-avatar
                        [name]="consultantMachine(event.environmentId)"
                        participant="consultant"
                        [look]="consultantLook"
                        [label]="(event.role ?? '') + ' · ' + consultantMachine(event.environmentId)"
                      />
                      <b data-testid="room-message-role">{{ event.role }}</b>
                      <span class="kind"
                        ><pk-icon name="agents" size="12" />{{ 'rooms.view.consultant' | transloco }}</span
                      >
                      <span class="env" data-testid="room-message-machine">
                        @if (consultantLook; as look) {
                          <pk-env-glyph [look]="look" />
                        }
                        {{ consultantMachine(event.environmentId) }}</span
                      >
                    </span>
                    @if (prose(); as markdown) {
                      <div class="text md">
                        <ng-container *ngComponentOutlet="markdown; inputs: { text: event.text }" />
                      </div>
                    } @else {
                      <div class="text">{{ event.text }}</div>
                    }
                  </li>
                }
                @default {
                  @if (event.kind === 'task' && event.taskId && firstTaskEvents().has(event.seq)) {
                    @if (taskById().get(event.taskId); as task) {
                      <li class="pk-room-task" data-testid="room-task" [attr.data-state]="task.state">
                        <div class="head">
                          <pk-icon name="agents" size="14" />
                          <span class="label">{{ 'rooms.task.label' | transloco }}</span>
                          <b class="title">{{ task.title }}</b>
                          <span class="state" [attr.data-state]="task.state">{{
                            'rooms.task.state.' + task.state | transloco
                          }}</span>
                          @if (task.review === 'pending') {
                            <span class="review" data-testid="room-task-review" data-review="pending">{{
                              'rooms.task.reviewing' | transloco
                            }}</span>
                          } @else if (task.review === 'accepted') {
                            <span class="review" data-testid="room-task-review" data-review="accepted">{{
                              'rooms.task.reviewedN' | transloco: { value1: task.reviewRounds + 1 }
                            }}</span>
                          }
                        </div>
                        <p class="brief">{{ task.brief }}</p>
                        @if (task.acceptance) {
                          <p class="acceptance">
                            <span>{{ 'rooms.task.doneWhen' | transloco }}</span> {{ task.acceptance }}
                          </p>
                        }
                        <p class="where">
                          {{ 'rooms.task.runsOn' | transloco }}
                          {{ store.environmentName(task.environmentId) ?? ('rooms.view.hostHere' | transloco) }} ·
                          <span class="font-mono">{{ task.base.slice(0, 7) }}</span>
                          @if (task.branch) {
                            · <span class="font-mono">{{ task.branch }}</span>
                          }
                        </p>
                        @if (task.state === 'running' && task.questions.length) {
                          <pk-room-ask
                            data-testid="room-task-question"
                            [questions]="task.questions"
                            [busy]="store.acting() === task.id"
                            [label]="'rooms.task.needsYou' | transloco"
                            (answered)="store.answer(task.id, $event)"
                          />
                        }
                        @if (task.report) {
                          @if (prose(); as markdown) {
                            <div class="report md" data-testid="room-task-report">
                              <ng-container *ngComponentOutlet="markdown; inputs: { text: task.report }" />
                            </div>
                          } @else {
                            <div class="report" data-testid="room-task-report">{{ task.report }}</div>
                          }
                        }
                        @if (task.files.length) {
                          <ul class="files" data-testid="room-task-files">
                            @for (file of task.files; track file.path) {
                              <li>
                                <span class="font-mono path">{{ file.path }}</span>
                                <span class="add">+{{ file.added }}</span>
                                <span class="del">−{{ file.removed }}</span>
                              </li>
                            }
                          </ul>
                        }
                        <div class="actions">
                          @switch (task.state) {
                            @case ('proposed') {
                              @if (choosing() === task.id) {
                                <div class="run-on" role="group" [attr.aria-label]="'rooms.task.runOn' | transloco">
                                  <span class="label">{{ 'rooms.task.runOn' | transloco }}</span>
                                  @for (worker of store.workers(); track worker.environmentId) {
                                    <button
                                      type="button"
                                      class="btn btn-sm"
                                      data-testid="room-task-run-on"
                                      [attr.data-environment]="worker.environmentId"
                                      [class.btn-primary]="worker.local"
                                      [disabled]="!worker.ready || store.acting() === task.id"
                                      [title]="worker.reason ?? ''"
                                      (click)="runOn(task.id, worker.environmentId)"
                                    >
                                      {{ worker.local ? ('rooms.view.hostHere' | transloco) : worker.name }}
                                    </button>
                                  }
                                </div>
                              } @else {
                                <button
                                  type="button"
                                  class="btn btn-primary btn-sm"
                                  data-testid="room-task-approve"
                                  [disabled]="store.acting() === task.id"
                                  (click)="approve(task.id)"
                                >
                                  {{ 'rooms.task.approve' | transloco }}
                                </button>
                              }
                              <button
                                type="button"
                                class="btn btn-ghost btn-sm"
                                data-testid="room-task-decline"
                                [disabled]="store.acting() === task.id"
                                (click)="store.act(task.id, 'decline')"
                              >
                                {{ 'rooms.task.decline' | transloco }}
                              </button>
                            }
                            @case ('running') {
                              <span class="working">{{ 'rooms.task.working' | transloco }}</span>
                              <button
                                type="button"
                                class="btn btn-ghost btn-sm"
                                data-testid="room-task-stop"
                                [disabled]="store.acting() === task.id"
                                (click)="store.act(task.id, 'stop')"
                              >
                                <pk-icon name="stop" />{{ 'rooms.task.stop' | transloco }}
                              </button>
                            }
                            @case ('submitted') {
                              @if (task.files.length) {
                                <button
                                  type="button"
                                  class="btn btn-primary btn-sm"
                                  data-testid="room-task-integrate"
                                  [disabled]="store.acting() === task.id"
                                  (click)="store.act(task.id, 'integrate')"
                                >
                                  <pk-icon name="git-merge" />{{ 'rooms.task.integrate' | transloco }}
                                </button>
                              }
                            }
                          }
                        </div>
                      </li>
                    }
                  } @else if (event.actor === 'worker') {
                    <ng-container *ngTemplateOutlet="workerSays; context: { $implicit: event }" />
                  } @else {
                    <li class="pk-room-note" data-testid="room-note">
                      <pk-icon name="alert-circle" size="14" />
                      <span>{{ event.text }}</span>
                    </li>
                  }
                }
              }
            }
            @for (action of store.pendingActions(); track action.id) {
              @let playbook = action.kind === 'playbook';
              <li class="pk-room-task pk-room-action" data-testid="room-action" [attr.data-kind]="action.kind">
                <div class="head">
                  <pk-icon [name]="playbook ? 'skill' : 'lock'" size="14" />
                  <span class="label">{{
                    (playbook && action.payload['create'] === true
                      ? 'rooms.action.newPlaybook'
                      : 'rooms.action.' + action.kind
                    ) | transloco
                  }}</span>
                  <b class="title">{{ action.name }}</b>
                </div>
                <p class="brief">{{ action.summary }}</p>
                @if (playbook) {
                  <pk-room-proposal [action]="action" />
                } @else if (argvOf(action.payload); as argv) {
                  <pre class="argv" data-testid="room-action-argv">{{ argv }}</pre>
                }
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    data-testid="room-action-approve"
                    [disabled]="store.acting() === action.id || (playbook && !readable(action))"
                    (click)="store.decide(action.id, 'approve')"
                  >
                    {{
                      (playbook
                        ? 'rooms.action.apply'
                        : action.kind === 'call'
                          ? 'rooms.action.run'
                          : 'rooms.action.move'
                      ) | transloco
                    }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    data-testid="room-action-discard"
                    [disabled]="store.acting() === action.id"
                    (click)="store.decide(action.id, 'discard')"
                  >
                    {{ 'rooms.action.discard' | transloco }}
                  </button>
                </div>
              </li>
            }
            @if (store.lead() === 'working') {
              <li class="pk-room-msg" data-testid="room-lead-working">
                <span class="by">
                  <pk-avatar
                    [name]="hostName() ?? ('rooms.view.hostHere' | transloco)"
                    participant="lead"
                    [look]="hostLook()"
                  />
                  <b>{{ 'rooms.view.lead' | transloco }}</b>
                  <span class="kind"><pk-icon name="agents" size="12" />{{ 'rooms.view.agent' | transloco }}</span>
                </span>
                @if (store.leadQuestions().length) {
                  <pk-room-ask
                    data-testid="room-lead-question"
                    [questions]="store.leadQuestions()"
                    [busy]="store.acting() === 'lead'"
                    [label]="'rooms.view.leadNeedsYou' | transloco"
                    (answered)="store.answerLead($event)"
                  />
                } @else {
                  <div class="text thinking">{{ 'rooms.view.thinking' | transloco }}</div>
                }
              </li>
            }
          </ol>
          <ng-template #workerSays let-event>
            <li class="pk-room-msg worker" data-testid="room-message" data-actor="worker">
              <span class="by">
                @let workerLook = store.machineLook(event.environmentId);
                <pk-avatar
                  [name]="workerName(event.environmentId)"
                  participant="worker"
                  [look]="workerLook"
                  [label]="('rooms.view.worker' | transloco) + ' · ' + workerName(event.environmentId)"
                />
                <b>{{ 'rooms.view.worker' | transloco }}</b>
                <span class="kind"><pk-icon name="agents" size="12" />{{ 'rooms.view.agent' | transloco }}</span>
                <span class="env" data-testid="room-message-machine">
                  @if (workerLook; as look) {
                    <pk-env-glyph [look]="look" />
                  }
                  {{ workerName(event.environmentId) }}</span
                >
                @if (event.taskId && taskById().get(event.taskId); as task) {
                  <span class="task-ref">{{ task.title }}</span>
                }
              </span>
              <div class="text">{{ event.text }}</div>
            </li>
          </ng-template>
        </div>
      </div>

      <div class="pk-room-composer">
        <div class="pk-room-column">
          @if (store.error(); as message) {
            <pk-notice class="mt-0 mb-2" tone="error" [text]="message" />
          }
          <div class="pk-room-well">
            <div class="row">
              <div
                class="pk-seg pk-seg-xs"
                role="radiogroup"
                [attr.aria-label]="'rooms.view.route' | transloco"
                data-testid="room-route"
              >
                <button
                  type="button"
                  role="radio"
                  data-testid="route-lead"
                  [attr.aria-checked]="route() === 'lead'"
                  (click)="route.set('lead')"
                >
                  <pk-icon name="agents" />{{ 'rooms.view.lead' | transloco }}
                </button>
                <button
                  type="button"
                  role="radio"
                  data-testid="route-none"
                  [attr.aria-checked]="route() === 'none'"
                  (click)="route.set('none')"
                >
                  {{ 'rooms.view.justPost' | transloco }}
                </button>
              </div>
              @if (controls(); as picker) {
                @if (store.leadThreadId(); as leadThreadId) {
                  <ng-container
                    *ngComponentOutlet="picker; inputs: { threadId: leadThreadId, ownerId: room.hostInstanceId }"
                  />
                }
              }
              <button
                type="button"
                class="pk-room-lock"
                data-testid="room-lead-lock"
                [pkTip]="
                  ('rooms.view.readOnlyTip' | transloco) +
                  ' ' +
                  ((sandboxed() ? 'rooms.view.sandboxOffTip' : 'rooms.view.sandboxOnTip') | transloco)
                "
                [attr.data-mode]="sandboxed() ? 'sandboxed' : 'bypass'"
                [attr.aria-pressed]="sandboxed()"
                [disabled]="!store.leadThreadId() || store.lead() === 'working'"
                (click)="store.setSandboxed(!sandboxed())"
              >
                <pk-protection-badge [mode]="sandboxed() ? 'sandboxed' : 'bypass'" [active]="sandboxed()" />
                {{ (sandboxed() ? 'rooms.view.readOnlySandboxed' : 'rooms.view.readOnlyHost') | transloco }}
              </button>
            </div>
            @if (images().length) {
              <ul class="pk-room-attachments" data-testid="room-attachments">
                @for (image of images(); track $index) {
                  <li>
                    <img [src]="'data:' + image.mimeType + ';base64,' + image.data" alt="" />
                    <button
                      type="button"
                      class="remove"
                      [attr.aria-label]="'rooms.view.removeImage' | transloco"
                      (click)="removeImage($index)"
                    >
                      <pk-icon name="close" size="12" />
                    </button>
                  </li>
                }
              </ul>
            }
            <textarea
              #field
              rows="2"
              data-testid="room-draft"
              [attr.aria-label]="'rooms.view.message' | transloco"
              [placeholder]="'rooms.view.messagePlaceholder' | transloco"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="enter($any($event))"
              (paste)="paste($event)"
            ></textarea>
            <div class="row">
              <input
                #picker
                type="file"
                hidden
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp"
                data-testid="room-image-input"
                (change)="pick(picker)"
              />
              <button
                type="button"
                class="btn btn-ghost btn-sm btn-square"
                data-testid="room-attach"
                [pkTip]="(route() === 'lead' ? 'rooms.view.attachImages' : 'rooms.view.attachOnlyLead') | transloco"
                [attr.aria-label]="'rooms.view.attachImages' | transloco"
                [disabled]="route() !== 'lead' || images().length >= maxImages"
                (click)="picker.click()"
              >
                <pk-icon name="plus" />
              </button>
              <span class="hint" aria-live="polite">
                {{
                  (route() === 'lead'
                    ? store.leadQuestions().length
                      ? 'rooms.view.hintWaits'
                      : store.lead() === 'working'
                        ? 'rooms.view.hintBusy'
                        : 'rooms.view.hintLead'
                    : 'rooms.view.hintNone'
                  ) | transloco
                }}
              </span>
              <button
                type="button"
                class="btn btn-primary btn-sm btn-circle"
                data-testid="room-send"
                [attr.aria-label]="'rooms.view.send' | transloco"
                [disabled]="!canSend()"
                (click)="send()"
              >
                <pk-icon name="arrow-up" />
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class RoomView {
  protected readonly store = inject(OpenRoomStore);
  protected readonly route = signal<RoomRoute>('lead');
  protected readonly draft = signal('');
  protected readonly images = signal<RoomImage[]>([]);
  protected readonly choosing = signal<string | undefined>(undefined);
  protected readonly taskById = computed(() => new Map(this.store.tasks().map((task) => [task.id, task] as const)));
  protected readonly firstTaskEvents = computed(() => {
    const seen = new Set<string>();
    const first = new Set<number>();
    for (const event of this.store.events())
      if (event.kind === 'task' && event.taskId && !seen.has(event.taskId)) {
        seen.add(event.taskId);
        first.add(event.seq);
      }
    return first;
  });
  protected readonly maxImages = 6;
  protected readonly hostName = computed(() => this.store.machineName(this.store.room()?.hostInstanceId));
  protected readonly hostLook = computed(() => this.store.machineLook(this.store.room()?.hostInstanceId));
  protected workerName(environmentId: string | null | undefined): string {
    return this.store.machineName(environmentId) ?? environmentId?.slice(0, 8) ?? '?';
  }
  protected consultantMachine(environmentId: string | null | undefined): string {
    return environmentId
      ? this.workerName(environmentId)
      : (this.hostName() ?? this.workerName(this.store.room()?.hostInstanceId));
  }
  protected argvOf(payload: Record<string, unknown>): string | undefined {
    const mcp = payload['mcp'] as { server?: unknown; tool?: unknown; args?: unknown } | undefined;
    if (mcp && typeof mcp.server === 'string' && typeof mcp.tool === 'string')
      return `${mcp.server} · ${mcp.tool} ${JSON.stringify(mcp.args ?? {}, null, 2)}`;
    const argv = payload['argv'];
    return Array.isArray(argv)
      ? argv
          .map(String)
          .map((part) => (/^[\w./:=@,+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
          .join(' ')
      : undefined;
  }
  protected readonly panel = signal(false);
  private readonly field = viewChild<ElementRef<HTMLTextAreaElement>>('field');
  protected readable(action: RoomAction): boolean {
    return PlaybookProposalSchema.safeParse(action.payload).success;
  }
  protected askToChange(): void {
    this.route.set('lead');
    this.draft.set(this.translate('rooms.playbook.changeMessage'));
    queueMicrotask(() => {
      const field = this.field()?.nativeElement;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    });
  }
  protected readonly modes = ['supervised', 'assisted'] as const;
  protected readonly askLead = 'ask-lead';
  protected readonly stageIndex = computed(() => this.store.stages().indexOf(this.store.stage() ?? ''));
  protected readonly playbookNames = computed(
    () => new Set((this.store.playbookChoices() ?? []).map((option) => option.name)),
  );
  private readonly translate = inject(Language).t;
  protected choosePlaybook(select: HTMLSelectElement): void {
    const value = select.value;
    if (value === this.askLead) {
      select.value = this.store.playbook() ?? '';
      void this.store.post(this.translate('rooms.view.askLeadForPlaybookMessage'), 'lead');
      return;
    }
    // A refused change (the lead started, the playbook broke) puts the select back on what the room has.
    if (value !== (this.store.playbook() ?? ''))
      void this.store.update({ playbook: value || null }).then(() => (select.value = this.store.playbook() ?? ''));
  }
  private static readonly TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  private readonly controlsLoader = inject(ROOM_LEAD_CONTROLS, { optional: true });
  private readonly proseLoader = inject(ROOM_PROSE, { optional: true });
  private readonly mcpAppLoader = inject(ROOM_MCP_APP, { optional: true });
  protected readonly prose = signal<Type<unknown> | null>(null);
  protected readonly mcpApp = signal<Type<unknown> | null>(null);
  protected readonly sendToLead = (text: string): void => void this.store.post(text, 'lead');
  protected readonly controls = signal<Type<unknown> | null>(null);
  protected readonly sandboxed = computed(() => {
    const protection = this.store.protection();
    return (
      protection?.mode === 'sandboxed' && protection.state !== 'unavailable' && protection.state !== 'setup-required'
    );
  });
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    void this.proseLoader?.().then((type) => this.prose.set(type));
    effect(() => {
      if (this.store.leadThreadId() && !this.controls() && this.controlsLoader)
        untracked(() => void this.controlsLoader?.().then((type) => this.controls.set(type)));
    });
    effect(() => {
      if (this.store.events().some((event) => event.kind === 'app') && !this.mcpApp() && this.mcpAppLoader)
        untracked(() => void this.mcpAppLoader?.().then((type) => this.mcpApp.set(type)));
    });
    effect(() => {
      this.store.events();
      this.store.lead();
      untracked(() =>
        queueMicrotask(() => {
          const el = this.scroller()?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        }),
      );
    });
  }

  protected canSend(): boolean {
    if (!this.draft().trim() || this.store.sending()) return false;
    return !(this.route() === 'lead' && this.store.lead() === 'working');
  }

  protected enter(event: KeyboardEvent): void {
    if (event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  protected async send(): Promise<void> {
    if (!this.canSend()) return;
    if (await this.store.post(this.draft(), this.route(), this.route() === 'lead' ? this.images() : [])) {
      this.draft.set('');
      this.images.set([]);
      this.route.set('lead');
    }
  }

  protected async pick(input: HTMLInputElement): Promise<void> {
    await this.addImages(Array.from(input.files ?? []));
    input.value = '';
  }

  protected async paste(event: ClipboardEvent): Promise<void> {
    if (this.route() !== 'lead') return;
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => RoomView.TYPES.has(file.type));
    if (!files.length) return;
    event.preventDefault();
    await this.addImages(files);
  }

  protected removeImage(index: number): void {
    this.images.update((images) => images.filter((_, i) => i !== index));
  }

  private async addImages(files: readonly File[]): Promise<void> {
    const room = this.maxImages - this.images().length;
    const accepted = files.filter((file) => RoomView.TYPES.has(file.type)).slice(0, Math.max(room, 0));
    const read = await Promise.all(accepted.map((file) => this.read(file)));
    this.images.update((images) => [...images, ...read.filter((image): image is RoomImage => !!image)]);
  }

  private read(file: File): Promise<RoomImage | undefined> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const data = result.slice(result.indexOf(',') + 1);
        resolve(data && data.length <= 10_000_000 ? { mimeType: file.type as RoomImage['mimeType'], data } : undefined);
      };
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(file);
    });
  }

  protected async approve(taskId: string): Promise<void> {
    await this.store.loadWorkers();
    const ready = this.store.workers().filter((worker) => worker.ready);
    if (this.store.workers().length <= 1 || (ready.length <= 1 && ready[0]?.local)) {
      await this.store.act(taskId, 'approve', ready[0]?.environmentId);
      return;
    }
    this.choosing.set(taskId);
  }

  protected async runOn(taskId: string, environmentId: string): Promise<void> {
    this.choosing.set(undefined);
    await this.store.act(taskId, 'approve', environmentId);
  }
}
