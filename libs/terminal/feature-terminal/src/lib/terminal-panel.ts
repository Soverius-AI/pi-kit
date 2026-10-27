import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import type { Terminal } from '@xterm/xterm';
import { ThemeStore, UiStore } from '@pi-kit/data-access';
import { type TerminalHost, TerminalStore } from '@pi-kit/terminal/data';

/** The ANSI colours, taken from the design tokens (doc/docs/design-system.md, "Color"); nothing outside the table. */
function xtermTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string): string => css.getPropertyValue(name).trim();
  const background = token('--pk-sunken');
  const foreground = token('--color-neutral-content');
  const muted = token('--pk-muted');
  return {
    background,
    foreground,
    cursor: token('--color-primary'),
    cursorAccent: background,
    selectionBackground: `color-mix(in srgb, ${token('--color-primary')} 35%, transparent)`,
    black: background,
    red: token('--color-error'),
    green: token('--color-success'),
    yellow: token('--color-warning'),
    blue: token('--color-info'),
    magenta: token('--color-primary'),
    cyan: token('--color-info'),
    white: foreground,
    brightBlack: muted,
    brightRed: token('--color-error'),
    brightGreen: token('--color-success'),
    brightYellow: token('--color-warning'),
    brightBlue: token('--color-info'),
    brightMagenta: token('--color-primary'),
    brightCyan: token('--color-info'),
    brightWhite: foreground,
  };
}

/**
 * The Terminal side panel: xterm.js on the backend's pseudo-terminal for the workspace. One shell
 * per workspace: closing the panel or reloading the window leaves it running, and opening it again replays the
 * screen. This is a convenience shell for the user, not pi's `bash` tool, so nothing typed here reaches the model.
 * Output is a streamed `GET`, keystrokes and resizes are `POST`s (the bearer token covers both).
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-terminal-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-panel', '[attr.aria-label]': "i18n.t('terminal.terminalPanel.terminal')" },
  template: `
    <div class="pk-bar">
      <span class="font-medium">{{ 'terminal.terminalPanel.terminal' | transloco }}</span>
      <span class="muted t-sm truncate" [title]="store.cwd() ?? ''">{{
        store.info()
          ? store.shellName() + ('terminal.terminalPanel.in' | transloco) + store.folderName()
          : store.folderName()
      }}</span>
      <button
        type="button"
        class="btn btn-ghost btn-xs ml-auto"
        [disabled]="!store.cwd() || store.starting()"
        [title]="'terminal.terminalPanel.endThisShellAndStartANew' | transloco"
        (click)="store.restart()"
      >
        {{ 'terminal.terminalPanel.restart' | transloco }}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-xs btn-square"
        [title]="'terminal.terminalPanel.closeTheShellKeepsRunning' | transloco"
        [attr.aria-label]="'terminal.terminalPanel.closeTheTerminalPanel' | transloco"
        (click)="bus.closePanel()"
      >
        ✕
      </button>
    </div>
    @if (store.error(); as error) {
      <p class="p-4 text-sm text-error" role="alert">{{ error }}</p>
    } @else if (!store.cwd()) {
      <p class="p-4 text-sm text-muted">{{ 'terminal.terminalPanel.openAThreadToGetATerminal' | transloco }}</p>
    }
    <div
      #host
      class="pk-term"
      role="group"
      [attr.aria-label]="'terminal.terminalPanel.terminal' | transloco"
      [class.hidden]="!!store.error() || !store.cwd()"
    ></div>
    @if (store.exited() !== undefined) {
      <div
        class="shrink-0 px-4 py-2 t-sm flex items-center gap-2"
        style="border-top: 1px solid var(--color-base-300)"
        role="status"
      >
        <span class="muted">{{
          'terminal.terminalPanel.theShellEnded'
            | transloco
              : {
                  value1:
                    store.exited() === null
                      ? ''
                      : ('terminal.terminalPanel.exitCode' | transloco) + store.exited() + ')',
                }
        }}</span>
        <button type="button" class="btn btn-xs ml-auto" (click)="store.restart()">
          {{ 'terminal.terminalPanel.startANewShell' | transloco }}
        </button>
      </div>
    }
  `,
})
export class TerminalPanel implements OnDestroy {
  protected readonly i18n = inject(Language);
  protected readonly bus = inject(UiStore);
  protected readonly store = inject(TerminalStore);
  private readonly theme = inject(ThemeStore);
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('host');

  private term: Terminal | undefined;
  private observer: ResizeObserver | undefined;

  /** What the store needs from this panel: an xterm screen to write to, and its disposal. */
  private readonly terminalHost: TerminalHost = {
    open: async () => {
      this.dispose();
      // xterm is loaded when the panel is first opened, not with the app.
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      const element = this.hostRef().nativeElement;
      const fonts = getComputedStyle(document.documentElement).getPropertyValue('--pk-font-mono').trim();
      const term = new Terminal({
        fontFamily: fonts,
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 5000,
        theme: xtermTheme(),
        allowProposedApi: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();
      this.term = term;

      term.onData((data) => this.store.send(data));
      term.onResize(({ cols, rows }) => this.store.resize(cols, rows));
      this.observer = new ResizeObserver(() => {
        if (element.clientWidth > 0) {
          try {
            fit.fit();
          } catch {
            // The panel is being closed.
          }
        }
      });
      this.observer.observe(element);
      return { cols: term.cols, rows: term.rows, write: (data) => term.write(data), focus: () => term.focus() };
    },
    close: () => this.dispose(),
  };

  constructor() {
    this.store.mount(this.terminalHost);
    effect(() => {
      this.theme.theme();
      untracked(() => {
        if (this.term) {
          this.term.options.theme = xtermTheme();
          this.term.options.fontFamily = getComputedStyle(document.documentElement)
            .getPropertyValue('--pk-font-mono')
            .trim();
        }
      });
    });
  }

  ngOnDestroy(): void {
    this.store.unmount();
  }

  private dispose(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.term?.dispose();
    this.term = undefined;
  }
}
