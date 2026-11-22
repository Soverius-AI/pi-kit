import { Component, computed, inject, model } from '@angular/core';
import { PkIcon, type PkIconName, PkRunStatus, type PkStep, PkStepLog } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { RoomRun, RoomRunStep } from '@pi-kit/protocol';
import { OpenRoomStore } from '@pi-kit/rooms/data';
import { RoomFormat } from './room-format';

@Component({
  selector: 'pk-room-runs',
  imports: [PkIcon, PkRunStatus, PkStepLog, TranslocoPipe],
  styleUrl: './room-runs.css',
  host: { 'data-testid': 'room-runs' },
  template: `
    @if (store.runs().length) {
      <ul class="runs" [attr.aria-label]="'rooms.runs.title' | transloco">
        @for (run of store.runs(); track run.id) {
          <li>
            <button
              type="button"
              data-testid="room-run"
              [attr.data-state]="run.state"
              [attr.aria-current]="run.id === shown()?.id ? 'true' : null"
              (click)="selected.set(run.id)"
            >
              <pk-run-status [state]="run.state" [label]="'rooms.runs.state.' + run.state | transloco" [size]="18" />
              <span class="main">
                <span class="title">{{ run.title }}</span>
                <span class="meta">
                  <span class="font-mono">#{{ run.number }}</span>
                  <span>{{ causeOf(run) }}</span>
                  <span>{{ format.time(run.startedAt) }}</span>
                </span>
              </span>
              <span class="duration">{{ format.duration(run.startedAt, run.endedAt) }}</span>
            </button>
          </li>
        }
      </ul>
      @if (shown(); as run) {
        <section class="run" data-testid="room-run-detail">
          <header>
            <pk-run-status [state]="run.state" [label]="'rooms.runs.state.' + run.state | transloco" [size]="24" />
            <div class="heading">
              <h3>{{ run.title }}</h3>
              <p class="meta">
                <span class="font-mono">#{{ run.number }}</span>
                <span [attr.data-state]="run.state" class="state">{{
                  'rooms.runs.state.' + run.state | transloco
                }}</span>
              </p>
            </div>
          </header>
          <dl class="facts">
            <div>
              <dt>{{ 'rooms.runs.triggeredBy' | transloco }}</dt>
              <dd><pk-icon [name]="causeIcon(run)" size="13" />{{ causeOf(run) }}</dd>
            </div>
            @if (run.stage) {
              <div>
                <dt>{{ 'rooms.runs.stage' | transloco }}</dt>
                <dd>{{ run.stage }}</dd>
              </div>
            }
            <div>
              <dt>{{ 'rooms.runs.started' | transloco }}</dt>
              <dd>{{ format.time(run.startedAt) }}</dd>
            </div>
            <div>
              <dt>{{ 'rooms.runs.took' | transloco }}</dt>
              <dd>{{ format.duration(run.startedAt, run.endedAt) }}</dd>
            </div>
          </dl>
          <h4>{{ 'rooms.runs.stepsN' | transloco: { value1: run.steps.length } }}</h4>
          @if (run.steps.length) {
            <pk-step-log [steps]="steps()" [emptyOutput]="'rooms.playbook.noOutput' | transloco" />
          } @else {
            <p class="muted" data-testid="room-run-no-steps">{{ 'rooms.runs.noSteps' | transloco }}</p>
          }
          @if (run.summary) {
            <h4>{{ 'rooms.runs.result' | transloco }}</h4>
            <p class="summary" data-testid="room-run-summary" [class.failed]="run.state === 'failed'">
              {{ run.summary }}
            </p>
          }
        </section>
      }
    } @else {
      <p class="empty" data-testid="room-runs-empty">{{ 'rooms.runs.empty' | transloco }}</p>
    }
  `,
})
export class RoomRuns {
  readonly selected = model<string | undefined>(undefined);
  protected readonly store = inject(OpenRoomStore);
  private readonly language = inject(Language);
  protected readonly format = inject(RoomFormat);
  protected readonly shown = computed<RoomRun | undefined>(() => {
    const runs = this.store.runs();
    return runs.find((run) => run.id === this.selected()) ?? runs[0];
  });
  protected readonly steps = computed<PkStep[]>(() =>
    (this.shown()?.steps ?? []).map((step) => ({
      id: String(step.seq),
      name: step.name,
      icon: this.stepIcon(step),
      tag: this.language.t(`rooms.runs.kind.${step.kind}`),
      detail: step.detail,
      state: step.state,
      stateLabel: this.language.t(`rooms.runs.state.${step.state}`),
      output: step.output,
      duration: step.state === 'waiting' ? '' : this.format.duration(step.startedAt, step.endedAt),
    })),
  );

  protected causeOf(run: RoomRun): string {
    const cause = this.language.t(`rooms.runs.cause.${run.cause}`);
    return run.trigger ? `${cause} · ${run.trigger}` : cause;
  }

  protected causeIcon(run: RoomRun): PkIconName {
    switch (run.cause) {
      case 'schedule':
        return 'sparkle';
      case 'poll':
        return 'refresh';
      case 'approval':
        return 'check';
      case 'stage':
        return 'arrow-right';
      case 'agent':
        return 'agents';
      default:
        return 'comment';
    }
  }

  private stepIcon(step: RoomRunStep): PkIconName {
    switch (step.kind) {
      case 'consult':
        return 'agents';
      case 'output':
        return 'arrow-up';
      case 'advance':
        return 'arrow-right';
      default:
        return 'terminal';
    }
  }
}
