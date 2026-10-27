import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type PkGenUiTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

/** The status dot and badge classes spelled out, so Tailwind finds them. */
const DOT: Record<PkGenUiTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  info: 'bg-info',
  neutral: 'bg-base-300',
};
const BADGE: Record<PkGenUiTone, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-error',
  info: 'badge-info',
  neutral: 'badge-neutral',
};

/**
 * The frame generated UI sits in inside the transcript ("Rendered from A2UI"
 * and "MCP app, sandboxed"): a hairline box with a 36px bar and the surface under it. The bar always says where the
 * UI comes from, so a surface cannot pass for part of the app; the content is projected.
 */
@Component({
  selector: 'pk-genui-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-genui' },
  template: `
    <div class="bar">
      @if (dot()) {
        <span class="w-2 h-2 rounded-full shrink-0" [class]="dotClass()" aria-hidden="true"></span>
      }
      <span class="font-medium truncate">{{ title() }}</span>
      @if (badge()) {
        <span class="badge badge-sm" [class]="badgeClass()">{{ badge() }}</span>
      }
      @if (sub()) {
        <span class="muted truncate">{{ sub() }}</span>
      }
      <span class="ml-auto muted t-xs shrink-0">{{ label() }}</span>
    </div>
    <ng-content />
  `,
})
export class PkGenUiFrame {
  readonly title = input.required<string>();
  /** Short text after the title (the tool name of an MCP App). */
  readonly sub = input<string | undefined>(undefined);
  /** A count or short state shown as a badge (A2UI). */
  readonly badge = input<string | undefined>(undefined);
  readonly badgeTone = input<PkGenUiTone>('neutral');
  /** Where the UI comes from, right-aligned: "Rendered from A2UI", "MCP app, sandboxed". */
  readonly label = input.required<string>();
  /** A status dot before the title (MCP Apps: loading, ready, failed); none when unset. */
  readonly dot = input<PkGenUiTone | undefined>(undefined);

  protected readonly dotClass = computed(() => DOT[this.dot() ?? 'neutral']);
  protected readonly badgeClass = computed(() => BADGE[this.badgeTone()]);
}
