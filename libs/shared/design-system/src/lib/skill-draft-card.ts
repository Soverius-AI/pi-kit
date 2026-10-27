import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { PkIcon } from './icon';

/**
 * The skill draft card (doc/docs/design-system.md, "Skill draft card"): the end of a thread offers the skill the attendant (or a request) drafted from it,
 * "The attendant drafted a skill from this thread: *Add a migration with its test* — Read". It is information, not a question, so it uses the info tint and never the
 * warning fill that belongs to the approval. *Read* opens the review dialog, where the person approves or discards.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-skill-draft-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-draft',
    role: 'group',
    '[attr.aria-label]': "i18n.t('shared.skillDraftCard.accessibleName', {name: name()})",
    'data-testid': 'draft-card',
  },
  template: `
    <pk-icon name="sparkle" class="glyph" />
    <p class="msg">
      {{ lead() }} <em class="name" data-testid="draft-name">{{ name() }}</em>
      @if (note()) {
        <span class="note" data-testid="draft-note">– {{ note() }}</span>
      }
    </p>
    <button type="button" class="btn btn-sm" data-testid="draft-read" (click)="read.emit()">
      {{ 'shared.skillDraftCard.read' | transloco }}
    </button>
    <button type="button" class="btn btn-sm btn-ghost" data-testid="draft-dismiss" (click)="dismiss.emit()">
      {{ 'shared.skillDraftCard.dismiss' | transloco }}
    </button>
  `,
})
export class PkSkillDraftCard {
  protected readonly i18n = inject(Language);
  /** The skill's name. */
  readonly name = input.required<string>();
  /** The sentence before the name ("The attendant drafted a skill from this thread:"). */
  readonly lead = input.required<string>();
  /** What a verification said about the draft ("verifying…", "verified: it reproduces its thread"), after the name; none for a draft nobody replayed. */
  readonly note = input<string>('');
  readonly read = output<void>();
  /** Hides the card; the draft stays pending and is still in the thread menu ("Read the skill draft"). */
  readonly dismiss = output<void>();
}
