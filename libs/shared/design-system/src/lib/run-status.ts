import { Component, input } from '@angular/core';
import { PkIcon } from './icon';

export type PkRunState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'discarded' | 'current' | 'pending';

@Component({
  selector: 'pk-run-status',
  imports: [PkIcon],
  host: {
    role: 'img',
    '[attr.data-state]': 'state()',
    '[attr.aria-label]': 'label()',
    '[style.--pk-run-status-size.px]': 'size()',
  },
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: var(--pk-run-status-size, 16px);
      height: var(--pk-run-status-size, 16px);
      border-radius: 50%;
      color: var(--color-base-100);
    }
    :host([data-state='done']) {
      background: var(--color-success);
    }
    :host([data-state='failed']) {
      background: var(--color-error);
    }
    :host([data-state='stopped']),
    :host([data-state='discarded']) {
      background: color-mix(in srgb, var(--color-base-content) 38%, transparent);
    }
    :host([data-state='waiting']) {
      background: var(--color-warning);
    }
    :host([data-state='pending']) {
      border: 1.5px solid color-mix(in srgb, var(--color-base-content) 35%, transparent);
    }
    :host([data-state='current']) {
      border: 1.5px solid var(--color-primary);
    }
    :host([data-state='current'])::after {
      content: '';
      width: 45%;
      height: 45%;
      border-radius: 50%;
      background: var(--color-primary);
    }
    :host([data-state='running']) {
      border: 2px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
      border-top-color: var(--color-warning);
      animation: pk-run-status-spin 0.9s linear infinite;
    }
    @keyframes pk-run-status-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host([data-state='running']) {
        animation: none;
      }
    }
  `,
  template: `
    @switch (state()) {
      @case ('done') {
        <pk-icon name="check" [size]="size() * 0.68" />
      }
      @case ('failed') {
        <pk-icon name="close" [size]="size() * 0.68" />
      }
      @case ('discarded') {
        <pk-icon name="close" [size]="size() * 0.68" />
      }
      @case ('stopped') {
        <pk-icon name="square" [size]="size() * 0.5" />
      }
      @case ('waiting') {
        <pk-icon name="lock" [size]="size() * 0.62" />
      }
    }
  `,
})
export class PkRunStatus {
  readonly state = input.required<PkRunState>();
  readonly label = input.required<string>();
  readonly size = input(16);
}
