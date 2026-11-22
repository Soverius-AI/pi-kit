import { Component, input } from '@angular/core';
import { PkIcon } from './icon';
import type { PkIconName } from './icon-names';
import { type PkRunState, PkRunStatus } from './run-status';

export interface PkStep {
  id: string;
  name: string;
  icon: PkIconName;
  tag: string;
  detail: string;
  state: PkRunState;
  stateLabel: string;
  output: string | null;
  duration: string;
}

@Component({
  selector: 'pk-step-log',
  imports: [PkIcon, PkRunStatus],
  host: { role: 'list', 'data-testid': 'step-log' },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--color-base-300);
      border-radius: 10px;
      overflow: hidden;
      font-size: 13px;
    }
    details + details {
      border-top: 1px solid var(--color-base-300);
    }
    summary {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    summary:hover {
      background: var(--color-base-200);
    }
    .caret {
      flex: none;
      color: var(--pk-muted);
      transition: transform 0.12s ease;
    }
    details[open] .caret {
      transform: rotate(90deg);
    }
    .kind {
      flex: none;
      color: var(--pk-muted);
    }
    .name {
      flex: none;
      font-weight: 600;
    }
    .tag {
      flex: none;
      padding: 0 6px;
      border-radius: 999px;
      border: 1px solid var(--color-base-300);
      font-size: 11px;
      color: var(--pk-muted);
    }
    .detail {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: var(--pk-muted);
    }
    .duration {
      flex: none;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      color: var(--pk-muted);
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: 1px;
      background: #0d1117;
      color: #c9d1d9;
    }
    pre {
      margin: 0;
      padding: 10px 14px 10px 38px;
      max-height: 22rem;
      overflow: auto;
      font-size: 12px;
      line-height: 18px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    pre.command {
      color: #8b949e;
      border-bottom: 1px solid #21262d;
    }
    pre.failed {
      color: #ffa198;
    }
  `,
  template: `
    @for (step of steps(); track step.id) {
      <details role="listitem" data-testid="step" [attr.data-state]="step.state" [open]="step.state === 'failed'">
        <summary>
          <pk-icon class="caret" name="chevron-right-small" size="12" />
          <pk-run-status [state]="step.state" [label]="step.stateLabel" />
          <pk-icon class="kind" [name]="step.icon" size="14" />
          <span class="name font-mono">{{ step.name }}</span>
          <span class="tag">{{ step.tag }}</span>
          <span class="detail">{{ step.detail }}</span>
          <span class="duration">{{ step.duration }}</span>
        </summary>
        <div class="body">
          <pre class="command font-mono">{{ step.detail }}</pre>
          <pre class="font-mono" data-testid="step-output" [class.failed]="step.state === 'failed'">{{
            step.output ?? emptyOutput()
          }}</pre>
        </div>
      </details>
    }
  `,
})
export class PkStepLog {
  readonly steps = input.required<PkStep[]>();
  readonly emptyOutput = input.required<string>();
}
