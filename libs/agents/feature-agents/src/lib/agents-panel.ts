import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentsStore } from '@pi-kit/agents/data';
import {
  agentAllowedTools,
  agentBadge,
  agentContextPercent,
  agentDurationMs,
  agentStateKey,
  agentTokens,
  splitAgents,
} from '@pi-kit/agents/util';
import { ClockStore, UiStore } from '@pi-kit/data-access';
import { PkIcon, PkRunRing, PkTip } from '@pi-kit/design-system';
import { ThreadsStore } from '@pi-kit/threads/api';
import { compactNumber, formatCost, formatDuration } from '@pi-kit/ui';
import type { AgentAnswer, AgentQuestion, BgAgent } from '@pi-kit/protocol';
import { AgentTranscript } from './agent-transcript';

/**
 * The Agents panel, a right-side panel per thread next to Artifacts: the agents at work with what they do right now, History
 * with how each ended, its duration, spend and report; open a transcript, message an agent (steer or follow-up), stop it, delete it.
 * An agent's open question is answered here too, whether it asked the user or the main agent (then the user overrides), and its last
 * answer shows who gave it, with Override sending the user's own answer as a steer. The list comes from the store, which the status channel
 * keeps current. Every agent is a card (doc/docs/design-system.md, "Agent card"): who it is and what it does, then the running time, turns,
 * tokens and spend, with icon actions (open, stop, delete). The open view is the agent's transcript under its context (brief, model,
 * permission, the tools that permission allows) with the message box below.
 */
@Component({
  selector: 'pk-agents-panel',
  providers: [AgentsStore],
  imports: [AgentTranscript, NgTemplateOutlet, PkIcon, PkRunRing, PkTip, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-panel', '[attr.aria-label]': "i18n.t('agents.agentsPanel.agents')" },
  template: `
    <div class="pk-bar gap-2">
      @if (opened(); as agent) {
        <button type="button" class="btn btn-ghost btn-sm" (click)="store.openTranscript(undefined)">
          ‹ {{ 'agents.agentsPanel.back' | transloco }}
        </button>
        <span class="font-medium truncate">{{ agent.name }}</span>
        <span
          class="badge badge-xs badge-outline"
          [class.badge-info]="agent.permission === 'edit'"
          [class.badge-warning]="agent.permission === 'isolated'"
          data-testid="agent-permission"
          [pkTip]="'agents.agentsPanel.permission' | transloco"
          >{{ agent.permission }}</span
        >
        <span class="badge badge-sm" [class]="badge(agent)">{{ state(agent) }}</span>
        @if (agent.status === 'active' || agent.status === 'blocked') {
          <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            data-testid="agent-stop"
            [pkTip]="'agents.agentsPanel.stopAgent' | transloco: { value1: agent.name }"
            [attr.aria-label]="'agents.agentsPanel.stopAgent' | transloco: { value1: agent.name }"
            (click)="store.stop(agent.id)"
          >
            <ng-container *ngTemplateOutlet="stopIcon" />
          </button>
        }
      } @else {
        <span class="font-medium">{{ 'agents.agentsPanel.agents' | transloco }}</span>
        <span class="chip">{{ active().length }}</span>
      }
      <button
        type="button"
        class="btn btn-ghost btn-sm ml-auto"
        [attr.aria-label]="'agents.agentsPanel.closeAgents' | transloco"
        (click)="bus.closePanel()"
      >
        ✕
      </button>
    </div>
    @if (store.error(); as error) {
      <div class="alert alert-error t-sm mx-3 my-2" role="alert">{{ error }}</div>
    }
    @if (opened(); as agent) {
      <section
        class="pk-agent-context"
        data-testid="agent-context"
        [attr.aria-label]="'agents.agentsPanel.context' | transloco"
      >
        <details>
          <summary class="t-xs muted cursor-pointer">
            {{ 'agents.agentsPanel.brief' | transloco }} · {{ agent.role }}
          </summary>
          <p class="t-sm m-0 mt-1 whitespace-pre-wrap break-words" data-testid="agent-brief">{{ agent.brief }}</p>
        </details>
        <ng-container *ngTemplateOutlet="meta; context: { $implicit: agent }" />
        @if (agent.status === 'blocked') {
          <ng-container *ngTemplateOutlet="held; context: { $implicit: agent }" />
        }
        <div class="flex flex-wrap items-center gap-1 t-xs" data-testid="agent-allowed">
          <span class="muted">{{ 'agents.agentsPanel.allowed' | transloco }}</span>
          @for (tool of allowed(agent); track tool) {
            <span class="badge badge-xs badge-ghost mono">{{ tool }}</span>
          }
        </div>
      </section>
      <pk-agent-transcript [agent]="agent" />
    } @else {
      <div class="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-4">
        <section>
          <h3 class="t-xs muted uppercase mb-2">{{ 'agents.agentsPanel.active' | transloco }}</h3>
          @if (active().length === 0) {
            <p class="t-sm muted">{{ 'agents.agentsPanel.noAgentsYet' | transloco }}</p>
          }
          <ul class="flex flex-col gap-2 list-none p-0 m-0" data-testid="agents-active">
            @for (agent of active(); track agent.id) {
              <li class="pk-agent-card" [attr.data-agent]="agent.id">
                <div class="head">
                  <pk-icon name="agents" class="glyph" />
                  <div class="who">
                    <span class="name">{{ agent.name }}</span>
                    <span class="role">{{ agent.role }}</span>
                  </div>
                  <span
                    class="badge badge-xs badge-outline"
                    [class.badge-info]="agent.permission === 'edit'"
                    [class.badge-warning]="agent.permission === 'isolated'"
                    data-testid="agent-permission"
                    [pkTip]="'agents.agentsPanel.permission' | transloco"
                    >{{ agent.permission }}</span
                  >
                  <span
                    class="badge badge-xs badge-outline muted"
                    [pkTip]="'agents.agentsPanel.piDurableTip' | transloco"
                    data-testid="agent-runtime"
                    >pi-durable</span
                  >
                  <ng-container *ngTemplateOutlet="stateOf; context: { $implicit: agent }" />
                  <div class="actions">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-square"
                      data-testid="agent-open"
                      [pkTip]="'agents.agentsPanel.openAgent' | transloco: { value1: agent.name }"
                      [attr.aria-label]="'agents.agentsPanel.openAgent' | transloco: { value1: agent.name }"
                      (click)="store.openTranscript(agent.id)"
                    >
                      <ng-container *ngTemplateOutlet="eyeIcon" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-square"
                      data-testid="agent-stop"
                      [pkTip]="'agents.agentsPanel.stopAgent' | transloco: { value1: agent.name }"
                      [attr.aria-label]="'agents.agentsPanel.stopAgent' | transloco: { value1: agent.name }"
                      (click)="store.stop(agent.id)"
                    >
                      <ng-container *ngTemplateOutlet="stopIcon" />
                    </button>
                  </div>
                </div>
                <ng-container *ngTemplateOutlet="meta; context: { $implicit: agent }" />
                @if (agent.status === 'blocked') {
                  <ng-container *ngTemplateOutlet="held; context: { $implicit: agent }" />
                }
                @if (agent.question; as q) {
                  <div class="rounded-box bg-base-200 p-2 flex flex-col gap-1" data-testid="agent-question">
                    <div class="t-xs muted">
                      {{
                        (q.kind === 'user' ? 'agents.agentsPanel.toYou' : 'agents.agentsPanel.toMainAgent') | transloco
                      }}
                    </div>
                    <p class="t-sm m-0 whitespace-pre-wrap break-words">{{ q.text }}</p>
                    @if (q.note) {
                      <p class="t-xs muted m-0">
                        {{ 'agents.agentsPanel.forwardedNote' | transloco: { value1: q.note } }}
                      </p>
                    }
                    @if (q.choices) {
                      <div class="flex flex-wrap gap-1">
                        @for (choice of q.choices; track choice) {
                          <button type="button" class="btn btn-xs" (click)="store.answer(agent.id, q.id, choice)">
                            {{ choice }}
                          </button>
                        }
                      </div>
                    } @else {
                      <form class="flex gap-1" (submit)="answerQuestion($event, agent, q)">
                        <input
                          class="input input-xs input-bordered flex-1"
                          name="text"
                          [attr.aria-label]="'agents.agentsPanel.answerPlaceholder' | transloco"
                          [placeholder]="'agents.agentsPanel.answerPlaceholder' | transloco"
                        />
                        <button type="submit" class="btn btn-xs btn-primary">
                          {{
                            (q.kind === 'user' ? 'agents.agentsPanel.answer' : 'agents.agentsPanel.override')
                              | transloco
                          }}
                        </button>
                      </form>
                    }
                    <button
                      type="button"
                      class="btn btn-xs btn-ghost self-start"
                      (click)="store.answer(agent.id, q.id, 'cancelled')"
                    >
                      {{ 'agents.agentsPanel.dismiss' | transloco }}
                    </button>
                  </div>
                }
                @if (agent.answered; as answered) {
                  <div class="t-xs muted" data-testid="agent-answered">{{ answeredLine(answered) }}</div>
                  @if (answered.by === 'main') {
                    <form class="flex gap-1" (submit)="override($event, agent, answered)" data-testid="agent-override">
                      <input
                        class="input input-xs input-bordered flex-1"
                        name="text"
                        [attr.aria-label]="'agents.agentsPanel.overridePlaceholder' | transloco"
                        [placeholder]="'agents.agentsPanel.overridePlaceholder' | transloco"
                      />
                      <button type="submit" class="btn btn-xs">{{ 'agents.agentsPanel.override' | transloco }}</button>
                    </form>
                  }
                }
              </li>
            }
          </ul>
        </section>
        <section>
          <h3 class="t-xs muted uppercase mb-2">{{ 'agents.agentsPanel.history' | transloco }}</h3>
          <ul class="flex flex-col gap-2 list-none p-0 m-0" data-testid="agents-history">
            @for (agent of history(); track agent.id) {
              <li class="pk-agent-card folded" [class.open]="expanded().has(agent.id)" [attr.data-agent]="agent.id">
                <div class="head">
                  <button
                    type="button"
                    class="fold"
                    [attr.aria-expanded]="expanded().has(agent.id)"
                    [attr.aria-label]="'agents.agentsPanel.openAgent' | transloco: { value1: agent.name }"
                    (click)="toggle(agent.id)"
                  >
                    <span class="chev" aria-hidden="true">›</span>
                    <pk-icon name="agents" class="glyph" />
                    <span class="who">
                      <span class="name">{{ agent.name }}</span>
                      <span class="role">{{ agent.role }}</span>
                    </span>
                  </button>
                  <span
                    class="badge badge-xs badge-outline"
                    [class.badge-info]="agent.permission === 'edit'"
                    [class.badge-warning]="agent.permission === 'isolated'"
                    data-testid="agent-permission"
                    [pkTip]="'agents.agentsPanel.permission' | transloco"
                    >{{ agent.permission }}</span
                  >
                  <span
                    class="badge badge-xs badge-outline muted"
                    [pkTip]="'agents.agentsPanel.piDurableTip' | transloco"
                    data-testid="agent-runtime"
                    >pi-durable</span
                  >
                  <ng-container *ngTemplateOutlet="stateOf; context: { $implicit: agent }" />
                  <div class="actions">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-square"
                      data-testid="agent-open"
                      [pkTip]="'agents.agentsPanel.openAgent' | transloco: { value1: agent.name }"
                      [attr.aria-label]="'agents.agentsPanel.openAgent' | transloco: { value1: agent.name }"
                      (click)="store.openTranscript(agent.id)"
                    >
                      <ng-container *ngTemplateOutlet="eyeIcon" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-square"
                      data-testid="agent-delete"
                      [pkTip]="'agents.agentsPanel.deleteAgent' | transloco: { value1: agent.name }"
                      [attr.aria-label]="'agents.agentsPanel.deleteAgent' | transloco: { value1: agent.name }"
                      (click)="store.remove(agent.id)"
                    >
                      <ng-container *ngTemplateOutlet="trashIcon" />
                    </button>
                  </div>
                </div>
                @if (expanded().has(agent.id)) {
                  <ng-container *ngTemplateOutlet="meta; context: { $implicit: agent }" />
                  @if (agent.report) {
                    <p class="t-sm whitespace-pre-wrap break-words m-0" data-testid="agent-report">
                      {{ agent.report }}
                    </p>
                  }
                } @else if (agent.report) {
                  <p class="t-xs muted truncate m-0" data-testid="agent-report">{{ agent.report }}</p>
                }
              </li>
            }
          </ul>
        </section>
      </div>
    }

    <!-- The numbers of an agent: permission, model, running time (live while it runs), turns, tokens, spend. -->
    <ng-template #meta let-agent>
      <dl class="meta" data-testid="agent-meta">
        @if (agent.model) {
          <!-- A long model name (a local GGUF's) takes the line; the numbers go on the next one. -->
          <div class="model" [class.long]="agent.model.length > 28">
            <dt class="sr-only">{{ 'agents.agentsPanel.model' | transloco }}</dt>
            <dd class="mono truncate" [title]="agent.model">{{ agent.model }}</dd>
          </div>
        }
        <div [pkTip]="'agents.agentsPanel.runningTime' | transloco">
          <dt class="sr-only">{{ 'agents.agentsPanel.runningTime' | transloco }}</dt>
          <dd data-testid="agent-took">⏱ {{ took(agent) }}</dd>
        </div>
        <div>
          <dt class="sr-only">{{ 'agents.agentsPanel.turns' | transloco }}</dt>
          <dd data-testid="agent-turns">{{ 'agents.agentsPanel.turnsCount' | transloco: { value1: agent.turns } }}</dd>
        </div>
        <div [pkTip]="tokensTip(agent)">
          <dt class="sr-only">{{ 'agents.agentsPanel.tokens' | transloco }}</dt>
          <dd data-testid="agent-tokens">{{ tokensLine(agent) }}</dd>
        </div>
        <div>
          <dt class="sr-only">{{ 'agents.agentsPanel.spend' | transloco }}</dt>
          <dd data-testid="agent-cost">{{ cost(agent) }}</dd>
        </div>
      </dl>
    </ng-template>
    <!-- How an agent ended, as an icon (green check, red X, grey square) with the words as tooltip and accessible name; the text badge while it works. -->
    <ng-template #stateOf let-agent>
      @switch (agent.status) {
        @case ('done') {
          <span
            class="state-icon ok"
            role="img"
            data-testid="agent-state"
            [attr.aria-label]="state(agent)"
            [pkTip]="state(agent)"
          >
            <pk-icon name="check" size="16" />
          </span>
        }
        @case ('failed') {
          <span
            class="state-icon bad"
            role="img"
            data-testid="agent-state"
            [attr.aria-label]="state(agent)"
            [pkTip]="state(agent)"
          >
            <pk-icon name="close" size="16" />
          </span>
        }
        @case ('stopped') {
          <span
            class="state-icon off"
            role="img"
            data-testid="agent-state"
            [attr.aria-label]="state(agent)"
            [pkTip]="state(agent)"
          >
            <pk-icon name="stop" size="16" />
          </span>
        }
        @default {
          @if (agent.activity !== 'idle' && !agent.question) {
            <pk-run-ring
              data-testid="agent-state"
              [percent]="contextPercent(agent)"
              [running]="true"
              [label]="runningLabel(agent)"
              [pkTip]="runningLabel(agent)"
              [size]="18"
            />
          } @else {
            <span class="badge badge-sm" [class]="badge(agent)" data-testid="agent-state">{{ state(agent) }}</span>
          }
        }
      }
    </ng-template>
    <!-- A held agent: why it waits, and the button that lets it go on. -->
    <ng-template #held let-agent>
      <div
        class="rounded-box bg-warning/10 border border-warning/30 p-2 flex flex-col gap-1"
        role="status"
        data-testid="agent-held"
      >
        <p class="t-sm m-0">
          {{
            (agent.blocked === 'cleanup'
              ? 'agents.agentsPanel.heldCleanupHint'
              : 'agents.agentsPanel.heldCrashLoopHint'
            ) | transloco
          }}
        </p>
        <button
          type="button"
          class="btn btn-xs btn-warning self-start"
          data-testid="agent-resume"
          (click)="store.resume(agent.id)"
        >
          {{
            (agent.blocked === 'cleanup' ? 'agents.agentsPanel.discardAndResume' : 'agents.agentsPanel.resume')
              | transloco
          }}
        </button>
      </div>
    </ng-template>
    <ng-template #eyeIcon>
      <pk-icon name="eye" size="14" />
    </ng-template>
    <ng-template #stopIcon>
      <pk-icon name="square" size="14" />
    </ng-template>
    <ng-template #trashIcon>
      <pk-icon name="trash" size="14" />
    </ng-template>
  `,
})
export class AgentsPanel {
  protected readonly i18n = inject(Language);
  protected readonly bus = inject(UiStore);
  protected readonly store = inject(AgentsStore);
  private readonly threads = inject(ThreadsStore);
  private readonly clock = inject(ClockStore);
  private readonly lists = computed(() => splitAgents(this.store.agents()));
  protected readonly active = computed(() => this.lists().active);
  protected readonly history = computed(() => this.lists().history);
  protected readonly opened = computed(() => this.store.agents().find((agent) => agent.id === this.store.open()));
  /** History cards the person opened: a folded card is its header and one line of its report. */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected toggle(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  constructor() {
    effect(() => {
      const threadId = this.threads.selectedId();
      untracked(() => this.store.watch(threadId));
    });
  }

  protected state(agent: BgAgent): string {
    const { key, value } = agentStateKey(agent);
    const text = value && key === 'held' ? this.i18n.t(`agents.agentsPanel.${value}`) : value;
    return this.i18n.t(`agents.agentsPanel.${key}`, text !== undefined ? { value1: text } : undefined);
  }

  protected badge(agent: BgAgent): string {
    return agentBadge(agent);
  }

  /** How full the running agent's context is, when pi knows its window. */
  protected contextPercent(agent: BgAgent): number | null {
    return agentContextPercent(agent);
  }

  /** "running bash · context 23% full" or "running · 12.3k tokens of context": the ring's name and tooltip. */
  protected runningLabel(agent: BgAgent): string {
    const percent = agentContextPercent(agent);
    if (percent !== null)
      return this.i18n.t('agents.agentsPanel.runningContext', { value1: this.state(agent), value2: percent });
    if (agent.context)
      return this.i18n.t('agents.agentsPanel.runningTokens', {
        value1: this.state(agent),
        value2: compactNumber(agent.context.tokens),
      });
    return this.state(agent);
  }

  protected took(agent: BgAgent): string {
    return formatDuration(agentDurationMs(agent, this.clock.now()));
  }

  protected cost(agent: BgAgent): string {
    return formatCost(agent.cost);
  }

  /** "12.3k in · 1.2k out" */
  protected tokensLine(agent: BgAgent): string {
    const t = agentTokens(agent.tokens);
    return this.i18n.t('agents.agentsPanel.tokensLine', { value1: t.input, value2: t.output });
  }

  protected tokensTip(agent: BgAgent): string {
    const t = agentTokens(agent.tokens);
    return this.i18n.t('agents.agentsPanel.tokensTip', { value1: t.input, value2: t.output, value3: t.cached });
  }

  /** The tools the agent's permission allows: what a follow-up can ask of it. */
  protected allowed(agent: BgAgent): string[] {
    return agentAllowedTools(agent.permission).map((tool) =>
      tool === 'bash-read-only' ? this.i18n.t('agents.agentsPanel.bashReadOnly') : tool,
    );
  }

  /** "answered by main agent: …", "answered by you: …", or how the question ended without an answer. */
  protected answeredLine(answered: AgentAnswer): string {
    const key =
      answered.by === 'main'
        ? 'answeredByMain'
        : answered.by === 'user'
          ? 'answeredByUser'
          : answered.by === 'default'
            ? 'answeredByDefault'
            : 'notAnswered';
    return this.i18n.t(`agents.agentsPanel.${key}`, { value1: answered.text ?? answered.question });
  }

  protected answerQuestion(event: Event, agent: BgAgent, question: AgentQuestion): void {
    event.preventDefault();
    const text = String(new FormData(event.target as HTMLFormElement).get('text') ?? '').trim();
    if (!text) return;
    (event.target as HTMLFormElement).reset();
    void this.store.answer(agent.id, question.id, text);
  }

  /** Override: the user's own answer to a question the main agent answered, sent to the agent as a steer. */
  protected override(event: Event, agent: BgAgent, answered: AgentAnswer): void {
    event.preventDefault();
    const text = String(new FormData(event.target as HTMLFormElement).get('text') ?? '').trim();
    if (!text) return;
    (event.target as HTMLFormElement).reset();
    void this.store.message(
      agent.id,
      this.i18n.t('agents.agentsPanel.overrideSent', { value1: answered.question, value2: text }),
      'steer',
    );
  }
}
