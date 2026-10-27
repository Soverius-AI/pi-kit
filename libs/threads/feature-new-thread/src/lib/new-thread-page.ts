import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/api';
import { NewThreadStore, ThreadsStore } from '@pi-kit/threads/data';
import { recentThings } from '@pi-kit/threads/util';

/**
 * The page of a thread that has no message yet: the question, one line of lead, and up to two things to pick up (the
 * last thread of the project, an unsent draft), in the transcript's place. It draws nothing for any other thread, so the chat page can always ask for it.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-new-thread-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown()) {
      <section
        class="pk-start"
        data-testid="new-thread-page"
        [attr.aria-label]="'threads.newThreadPage.newThread' | transloco"
      >
        <h2>{{ 'threads.newThreadPage.whatAreWeDoingIn' | transloco: { value1: name() } }}</h2>
        <p class="lead">{{ lead() }}</p>
        @if (recent().length > 0) {
          <div class="pk-recent">
            @for (thing of recent(); track thing.kind + (thing.id ?? '')) {
              <button type="button" [attr.data-testid]="'recent-' + thing.kind" (click)="pick(thing)">
                <span>{{ thing.title }}</span>
                <small>{{ thing.sub }}</small>
              </button>
            }
          </div>
        }
      </section>
    }
  `,
})
export class NewThreadPage {
  protected readonly i18n = inject(Language);
  private readonly threads = inject(ThreadsStore);
  private readonly store = inject(NewThreadStore);
  private readonly chat = inject(ChatStore);

  protected readonly shown = computed(() => !!this.store.thread() && this.chat.messages().length === 0);
  protected readonly name = computed(
    () => this.store.workspace()?.name ?? this.i18n.t('threads.newThreadPage.thisProject'),
  );
  protected readonly lead = computed(() => {
    const repo = this.store.projectGit()?.git ?? this.store.workspace()?.worktree?.git ?? false;
    return repo
      ? this.i18n.t('threads.newThreadPage.theFirstMessageStartsTheThreadPick')
      : this.i18n.t('threads.newThreadPage.theFirstMessageStartsTheThreadIt');
  });
  protected readonly recent = computed(() => {
    const cwd = this.store.thread()?.cwd;
    return cwd
      ? recentThings(this.i18n.t, this.threads.threads(), cwd, this.threads.selectedId(), this.chat.draft())
      : [];
  });

  protected pick(thing: { kind: 'thread' | 'draft'; id?: string }): void {
    if (thing.kind === 'thread' && thing.id) this.threads.select(thing.id);
    else this.chat.focusComposer();
  }
}
