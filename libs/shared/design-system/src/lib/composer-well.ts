import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The composer's well (doc/docs/design-system.md, "Composer"): a base-100 frame of radius 10 with the hairline that turns to the accent
 * colour while a field inside has the focus. It is only the frame: what it holds is CopilotKit's `copilot-chat-input`
 * with pi-kit's `textArea` and `toolbar` slots (the borderless textarea that grows with its content, the toolbar row under it), and,
 * above them, the strip of chips and attachments (`.pk-chip-strip`, with CopilotKit's attachment queue) and the "Branching from turn N" banner.
 * `mode` is `shell` while the text is a `!command` (the textarea then shows it in mono).
 */
@Component({
  selector: 'pk-composer-well',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-well block', '[attr.data-mode]': 'mode()' },
  template: `<ng-content />`,
})
export class PkComposerWell {
  readonly mode = input<'prompt' | 'shell'>('prompt');
}
