import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { errorMessage } from '@pi-kit/api';
import { type CodeLanguage, keepFocusInside, PkCodeEditor, PkIcon, PkTip } from '@pi-kit/design-system';

/** A file the editor dialog works on: how to read it, check it and save it. The dialog knows nothing of `mcp.json` or skills; the host passes these. */
export interface EditorSource {
  /** The head: the file's path or name. */
  title: string;
  /** `user`, `project`, `skill`: the chips after the title. */
  chips: { text: string; tone?: 'off' | 'ok' }[];
  language: CodeLanguage;
  load(): Promise<{ text: string; mtime: number; exists?: boolean }>;
  /** Saves and answers with the file as it is now. A refusal throws; its message is shown under the editor. */
  save(text: string, mtime: number): Promise<{ text: string; mtime: number; message?: string }>;
  /** The first problem, with its line when it has one. */
  check(text: string): { line?: number; message: string } | undefined;
  /** What the status line says while the text is valid ("3 servers"). */
  valid(text: string): string;
  /** The primary button: “Save and reload”. */
  saveLabel: string;
  /** “Open in editor” (the desktop app opens the file); left out where the file does not exist yet. */
  openExternally?: () => void;
  /** The file was just created and has not been saved by the person yet. */
  isNew?: boolean;
}

type Phase = 'loading' | 'ready' | 'failed';

/**
 * The editor dialog (“Edit here”): a file in the code editor with its problem under it, ⌘S to save, Save disabled while the text is
 * not valid. Used for the two `mcp.json` files and for the `SKILL.md` of your own skills. It loads the file when it opens, remembers the modified time it saw, and sends it back with the
 * save: a file that changed in between is refused by the backend and the dialog offers to load it again (“Reload”). Closing with unsaved changes asks once.
 */
@Component({
  selector: 'pk-file-editor-dialog',
  imports: [PkCodeEditor, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf" data-testid="file-editor">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.fileEditor.close' | transloco"
        (click)="requestClose()"
      ></button>
      <div
        #win
        class="win wide"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="('settings.fileEditor.edit' | transloco) + source().title"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); requestClose()"
      >
        <div class="head">
          <h2 class="mono text-[15px] min-w-0 truncate" [pkTip]="source().title">{{ source().title }}</h2>
          @for (chip of source().chips; track chip.text) {
            <span class="chip shrink-0" [class.off]="chip.tone === 'off'" [class.ok]="chip.tone === 'ok'">{{
              chip.text
            }}</span>
          }
          @if (changed(); as text) {
            <span class="muted t-sm shrink-0 whitespace-nowrap">{{ text }}</span>
          }
          <button
            type="button"
            class="pk-close ml-auto"
            [pkTip]="'settings.fileEditor.closeEsc' | transloco"
            [attr.aria-label]="'settings.fileEditor.close' | transloco"
            (click)="requestClose()"
          >
            <pk-icon name="close" />
          </button>
        </div>
        <div class="body">
          @switch (phase()) {
            @case ('loading') {
              <div class="py-8 grid place-items-center">
                <span
                  class="loading loading-dots loading-sm text-primary"
                  [attr.aria-label]="'settings.fileEditor.readingTheFile' | transloco"
                ></span>
              </div>
            }
            @case ('failed') {
              <p class="text-sm text-error break-words m-0" role="alert" data-testid="editor-load-error">
                {{ error() }}
              </p>
            }
            @default {
              <pk-code-editor
                #code
                [value]="text()"
                (valueChange)="edit($event)"
                [language]="source().language"
                [errorLine]="problem()?.line"
                [label]="('settings.fileEditor.textOf' | transloco) + source().title"
                (saveRequested)="save()"
              />
              <div
                class="pk-editor-status"
                role="status"
                data-testid="editor-status"
                [attr.data-valid]="problem() ? 'no' : 'yes'"
              >
                @if (problem(); as p) {
                  <span class="dot bad"></span>
                  <span data-testid="editor-problem"
                    >{{ p.line ? ('settings.fileEditor.line' | transloco) + p.line + ': ' : '' }}{{ p.message }}</span
                  >
                } @else {
                  <span class="dot"></span>
                  <span>{{ source().valid(text()) }}</span>
                }
                <span class="ml-auto muted">{{ 'settings.fileEditor.sSavesEscCloses' | transloco }}</span>
              </div>
              @if (error(); as e) {
                <div class="text-sm text-error break-words" role="alert" data-testid="editor-error">{{ e }}</div>
              }
            }
          }
        </div>
        <div class="foot">
          @if (confirmDiscard()) {
            <span class="text-sm" role="alert">{{ 'settings.fileEditor.discardYourChanges' | transloco }}</span>
            <span class="ml-auto flex items-center gap-2">
              <button type="button" class="btn btn-sm btn-ghost" data-testid="keep-editing" (click)="keepEditing()">
                {{ 'settings.fileEditor.keepEditing' | transloco }}
              </button>
              <button type="button" class="btn btn-sm btn-error" data-testid="discard" (click)="closed.emit()">
                {{ 'settings.fileEditor.discard' | transloco }}
              </button>
            </span>
          } @else {
            @if (source().openExternally; as open) {
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                [pkTip]="'settings.fileEditor.opensInYourDefaultEditor' | transloco"
                (click)="open()"
              >
                {{ 'settings.fileEditor.openInEditor' | transloco }}
              </button>
            }
            <span class="ml-auto flex items-center gap-2">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-testid="editor-revert"
                [disabled]="busy() || (!dirty() && !stale())"
                (click)="revert()"
              >
                {{ stale() ? ('settings.fileEditor.reload' | transloco) : ('settings.fileEditor.revert' | transloco) }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-testid="editor-save"
                [disabled]="!canSave()"
                (click)="save()"
              >
                @if (busy()) {
                  <span class="loading loading-spinner loading-xs"></span>
                }
                {{ source().saveLabel }}
              </button>
            </span>
          }
        </div>
      </div>
    </div>
  `,
})
export class FileEditorDialog implements OnInit {
  protected readonly i18n = inject(Language);
  readonly source = input.required<EditorSource>();
  readonly closed = output<void>();
  /** The file was saved (the host refreshes what depends on it). */
  readonly saved = output<void>();

  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly code = viewChild<PkCodeEditor>('code');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly phase = signal<Phase>('loading');
  protected readonly text = signal('');
  private readonly original = signal('');
  private mtime = 0;
  private opened = 0;
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly stale = signal(false);
  protected readonly confirmDiscard = signal(false);

  protected readonly dirty = computed(() => this.text() !== this.original());
  protected readonly problem = computed(() =>
    this.phase() === 'ready' ? this.source().check(this.text()) : undefined,
  );
  protected readonly canSave = computed(
    () =>
      this.phase() === 'ready' &&
      !this.busy() &&
      !this.problem() &&
      (this.dirty() || this.source().isNew === true) &&
      !this.stale(),
  );
  protected readonly changed = computed(() =>
    this.phase() === 'ready' && this.opened > 0
      ? agoText(this.i18n.t, this.mtimeSignal(), this.nowSignal())
      : undefined,
  );
  private readonly mtimeSignal = signal(0);
  private readonly nowSignal = signal(Date.now());

  constructor() {
    // Save is disabled while it saves and the foot becomes the discard question: the focus must not leave with the button (an Escape on the page closes Settings).
    effect(() => {
      this.busy();
      this.confirmDiscard();
      this.stale();
      untracked(() => keepFocusInside(this.injector, () => this.win()?.nativeElement));
    });
  }

  ngOnInit(): void {
    queueMicrotask(() => this.win()?.nativeElement.focus());
    void this.load();
  }

  /** The caret goes back into the text once it is drawn (the textarea is made again after a load), so Escape and the keys keep reaching this dialog and not the page behind it. */
  private focusEditor(): void {
    afterNextRender(() => this.code()?.focus(), { injector: this.injector });
  }

  private async load(): Promise<void> {
    // The textarea is about to go: the focus stays in the dialog.
    this.win()?.nativeElement.focus();
    this.phase.set('loading');
    this.error.set('');
    this.stale.set(false);
    try {
      const file = await this.source().load();
      this.original.set(file.text);
      this.text.set(file.text);
      this.mtime = file.mtime;
      this.mtimeSignal.set(file.mtime);
      this.nowSignal.set(Date.now());
      this.opened = file.exists === false ? 0 : 1;
      this.phase.set('ready');
      this.focusEditor();
    } catch (e) {
      this.error.set(errorMessage(e));
      this.phase.set('failed');
    }
  }

  protected edit(text: string): void {
    this.text.set(text);
    if (this.error()) this.error.set('');
  }

  protected revert(): void {
    if (this.stale()) void this.load();
    else {
      this.text.set(this.original());
      this.error.set('');
    }
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const file = await this.source().save(this.text(), this.mtime);
      this.original.set(file.text);
      this.text.set(file.text);
      this.mtime = file.mtime;
      this.mtimeSignal.set(file.mtime);
      this.nowSignal.set(Date.now());
      this.opened = 1;
      this.saved.emit();
      this.closed.emit();
    } catch (e) {
      const message = errorMessage(e);
      this.error.set(message);
      // The file changed behind the dialog: the way on is to read it again.
      if (/changed since/i.test(message)) this.stale.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  /** Back to the text, with the cursor where it was: the foot's button that had the focus is gone, and Escape must still reach the dialog. */
  protected keepEditing(): void {
    this.confirmDiscard.set(false);
    this.focusEditor();
  }

  protected requestClose(): void {
    if (this.dirty() && !this.confirmDiscard() && this.phase() === 'ready') this.confirmDiscard.set(true);
    else this.closed.emit();
  }

  /** For tests and the host: the editor's focus. */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLElement>('textarea')?.focus();
  }
}

/** “changed 2 h ago” for the modified time of the file. */
function agoText(translate: Translate, mtime: number, now: number): string | undefined {
  if (!mtime) return undefined;
  const minutes = Math.floor((now - mtime) / 60_000);
  if (minutes < 1) return translate('settings.fileEditor.changedJustNow');
  if (minutes < 60) return translate('settings.fileEditor.changedMinAgo', { value1: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return translate('settings.fileEditor.changedHAgo', { value1: hours });
  return translate('settings.fileEditor.changedDaysAgo', { value1: Math.floor(hours / 24) });
}
