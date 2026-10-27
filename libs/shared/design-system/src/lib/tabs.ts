import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  contentChildren,
  inject,
  input,
  model,
  viewChildren,
} from '@angular/core';

let nextTabsId = 0;

/** Segmented tabs with automatic keyboard activation. Project PkTabPanel children; their content
 * stays mounted so switching panels preserves form drafts and scroll positions. */
@Component({
  selector: 'pk-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-tabs' },
  template: `
    <div class="pk-tab-list" role="tablist" [attr.aria-label]="label()">
      @for (panel of panels(); track panel.value()) {
        <button
          #tab
          type="button"
          role="tab"
          [id]="id + '-tab-' + panel.value()"
          [attr.aria-controls]="id + '-panel-' + panel.value()"
          [attr.aria-selected]="selected() === panel.value()"
          [tabIndex]="selected() === panel.value() ? 0 : -1"
          [disabled]="panel.disabled()"
          (click)="value.set(panel.value())"
          (keydown)="navigate($event, panel)"
        >
          {{ panel.label() }}
          @if (panel.count() !== undefined) {
            <span class="pk-tab-count">{{ panel.count() }}</span>
          }
        </button>
      }
    </div>
    <ng-content />
  `,
})
export class PkTabs {
  readonly label = input.required<string>();
  readonly value = model('');
  readonly id = `pk-tabs-${++nextTabsId}`;
  readonly panels = contentChildren(PkTabPanel);
  readonly selected = computed(() => {
    const enabled = this.panels().filter((panel) => !panel.disabled());
    return (enabled.find((panel) => panel.value() === this.value()) ?? enabled[0])?.value();
  });
  private readonly buttons = viewChildren<ElementRef<HTMLButtonElement>>('tab');

  protected navigate(event: KeyboardEvent, current: PkTabPanel): void {
    const enabled = this.panels().filter((panel) => !panel.disabled());
    const index = enabled.indexOf(current);
    let next: PkTabPanel | undefined;
    if (event.key === 'ArrowRight') next = enabled[(index + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled.at(-1);
    if (!next) return;
    event.preventDefault();
    this.value.set(next.value());
    const button = this.buttons().find((item) => item.nativeElement.id === `${this.id}-tab-${next.value()}`);
    button?.nativeElement.focus();
    button?.nativeElement.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}

/** One panel of `pk-tabs`: its `value`, `label` and optional `count` make the tab button; the content stays mounted
 * and is hidden while another tab is selected. */
@Component({
  selector: 'pk-tab-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-tab-panel',
    role: 'tabpanel',
    tabindex: '0',
    '[id]': "tabs.id + '-panel-' + value()",
    '[attr.aria-labelledby]': "tabs.id + '-tab-' + value()",
    '[hidden]': 'tabs.selected() !== value()',
  },
  template: '<ng-content />',
})
export class PkTabPanel {
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly count = input<number>();
  readonly disabled = input(false);
  protected readonly tabs = inject(PkTabs);
}
