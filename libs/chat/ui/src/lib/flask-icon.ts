import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ThinkingLevel } from '@pi-kit/protocol';

/**
 * The effort icon: a 16px laboratory flask whose primary-coloured liquid rises in the bowl with the level, 0 / 15 / 30 / 50 / 65 / 80 / 100 % for
 * off / minimal / low / medium / high / xhigh / max (`FLASK_FILL` in `@pi-kit/chat/util` says the same in numbers). It draws nothing itself:
 * `.pk-flask[data-level]` in `components.css` paints the design system's `flask` and `flask-bowl` icons as two masks and sets `--level`, so a theme
 * restyles it without touching the template. Decorative: the button around it carries the label.
 */
@Component({
  selector: 'pk-flask',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-flask', '[attr.data-level]': 'level()', 'aria-hidden': 'true' },
  template: '',
})
export class FlaskIcon {
  readonly level = input<ThinkingLevel>('off');
}
