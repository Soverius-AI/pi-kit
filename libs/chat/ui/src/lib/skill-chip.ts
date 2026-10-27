import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { PkIcon } from '@pi-kit/design-system';

/**
 * A skill or prompt template as a chip (doc/docs/design-system.md, "Composer"): a 24px pill with the name, where it comes from (`user`,
 * `project`) and, in the composer, a pin and a round close. A pinned chip stays on the messages that follow, so it is drawn dimmer with its pin
 * filled. In the transcript (`readonly`) it only names what the message was sent with. Stateless: the chip comes in, intent goes out.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-skill-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-skill-chip',
    '[class.pinned]': 'pinned()',
    '[attr.data-testid]': "'skill-chip'",
    '[attr.data-kind]': 'kind()',
    '[attr.data-name]': 'name()',
    '[attr.data-pinned]': 'pinned() ? "true" : null',
    '[attr.title]': 'title()',
  },
  template: `
    <span class="glyph" aria-hidden="true">{{ kind() === 'skill' ? ('chat.skillChip.skill' | transloco) : '/' }}</span>
    <span class="name">{{ name() }}</span>
    @if (scope(); as scope) {
      <span class="scope">{{ scope }}</span>
    }
    @if (readonly()) {
      @if (pinned()) {
        <pk-icon name="pin-filled" class="pin-mark" />
      }
    } @else {
      <button
        type="button"
        class="pin"
        data-testid="skill-chip-pin"
        [attr.aria-pressed]="pinned()"
        [attr.aria-label]="
          pinned()
            ? ('chat.skillChip.unpin' | transloco) + name()
            : ('chat.skillChip.pin' | transloco) + name() + ('chat.skillChip.toThisThread' | transloco)
        "
        [title]="
          pinned()
            ? ('chat.skillChip.pinnedToThisThreadClickToLet' | transloco)
            : ('chat.skillChip.pinToThisThreadItStaysOn' | transloco)
        "
        (click)="togglePin.emit()"
      >
        <pk-icon [name]="pinned() ? 'pin-filled' : 'pin'" />
      </button>
      <button
        type="button"
        class="close"
        data-testid="skill-chip-remove"
        [attr.aria-label]="('chat.skillChip.remove1680e' | transloco) + name()"
        [title]="'chat.skillChip.remove' | transloco"
        (click)="remove.emit()"
      >
        <pk-icon name="close" />
      </button>
    }
  `,
})
export class SkillChip {
  protected readonly i18n = inject(Language);
  readonly kind = input<'skill' | 'prompt'>('skill');
  readonly name = input.required<string>();
  /** Where it comes from: `user`, `project` or a package name. */
  readonly scope = input<string | undefined>(undefined);
  readonly pinned = input(false);
  /** In the transcript: no pin, no close. */
  readonly readonly = input(false);

  readonly togglePin = output<void>();
  readonly remove = output<void>();

  protected readonly title = computed(
    () =>
      `${this.kind() === 'skill' ? this.i18n.t('chat.skillChip.skillLabel') : this.i18n.t('chat.skillChip.promptTemplate')} ${this.name()}${this.pinned() ? this.i18n.t('chat.skillChip.pinnedToTheThread') : ''}`,
  );
}
