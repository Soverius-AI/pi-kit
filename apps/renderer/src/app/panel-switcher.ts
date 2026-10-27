import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { CdkMenu, CdkMenuItemCheckbox, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { UiStore } from '@pi-kit/data-access';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { ThreadsStore } from '@pi-kit/threads/api';
import { ShellStore } from './shell.store';

/**
 * The header's side panel switch: one toggle button per panel (tree, files, changes, terminal, agents, artifacts), folded into a
 * "…" menu on a narrow header. Which panel is open comes from `UiStore`; which are available comes from `ShellStore`, the selected
 * thread and whether the desktop app offers a browser.
 */
@Component({
  selector: 'pk-panel-switcher',
  imports: [CdkMenu, CdkMenuItemCheckbox, CdkMenuTrigger, PkIcon, PkTip, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-buttons pk-seg pk-seg-icons" role="group" [attr.aria-label]="'shell.app.sidePanel' | transloco">
      @for (action of actions(); track action.id) {
        <span [pkTip]="action.disabled ? action.unavailable : null">
          <button
            type="button"
            [pkTip]="action.tip"
            [attr.aria-label]="action.label"
            [attr.aria-pressed]="bus.panel() === action.id"
            [disabled]="action.disabled"
            (click)="bus.togglePanel(action.id)"
          >
            <pk-icon [name]="action.icon" />
          </button>
        </span>
      }
    </div>
    <button
      type="button"
      class="panel-pocket btn btn-ghost btn-sm btn-square"
      [attr.aria-label]="'shell.app.sidePanels' | transloco"
      [pkTip]="'shell.app.sidePanels' | transloco"
      [class.btn-active]="!!bus.panel()"
      [cdkMenuTriggerFor]="panelMenu"
    >
      <pk-icon name="more" size="18" />
    </button>
    <ng-template #panelMenu>
      <div cdkMenu class="panel-menu" [attr.aria-label]="'shell.app.sidePanels' | transloco">
        @for (action of actions(); track action.id) {
          <button
            type="button"
            cdkMenuItemCheckbox
            [cdkMenuItemChecked]="bus.panel() === action.id"
            [cdkMenuItemDisabled]="action.disabled"
            [disabled]="action.disabled"
            [title]="action.disabled ? action.unavailable : action.tip"
            (cdkMenuItemTriggered)="bus.togglePanel(action.id)"
          >
            <pk-icon [name]="action.icon" />
            <span>{{ action.label }}</span>
            <span class="check" aria-hidden="true">{{ bus.panel() === action.id ? '✓' : '' }}</span>
          </button>
        }
      </div>
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }
    .panel-pocket {
      display: none;
    }
    @container chat-header (max-width: 720px) {
      .panel-buttons {
        display: none;
      }
      .panel-pocket {
        display: inline-flex;
      }
    }
    .panel-menu {
      display: flex;
      flex-direction: column;
      min-width: 184px;
      padding: 4px;
      border: 1px solid var(--color-base-300);
      border-radius: var(--radius-box);
      background: var(--color-base-100);
      color: var(--color-base-content);
      box-shadow: var(--pk-shadow);
    }
    .panel-menu button {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: var(--radius-field);
      text-align: left;
      font-size: 13px;
      cursor: pointer;
    }
    .panel-menu button:focus,
    .panel-menu button:hover:not(:disabled) {
      outline: none;
      background: var(--color-base-200);
    }
    .panel-menu button[aria-checked='true'] {
      color: var(--color-primary);
    }
    .panel-menu button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .check {
      margin-left: auto;
    }
  `,
})
export class PanelSwitcher {
  private readonly i18n = inject(Language);
  protected readonly bus = inject(UiStore);
  private readonly shell = inject(ShellStore);
  private readonly threads = inject(ThreadsStore);
  private readonly browserAvailable = !!window.piKit?.setBrowserViewport;
  protected readonly actions = computed(() => [
    {
      id: 'tree' as const,
      icon: 'tree' as const,
      label: this.i18n.t('shell.app.tree'),
      tip: this.i18n.t('shell.app.treeSessionHistory'),
      disabled: this.shell.treeDisabled(),
      unavailable: this.i18n.t('shell.app.treeSessionHistoryOpenAChatOr'),
    },
    {
      id: 'files' as const,
      icon: 'files' as const,
      label: this.i18n.t('shell.app.files'),
      tip: this.i18n.t('shell.app.filesProjectExplorer'),
      disabled: this.shell.filesDisabled(),
      unavailable: this.i18n.t('shell.app.filesProjectExplorerOpenAChatOr'),
    },
    {
      id: 'changes' as const,
      icon: 'changes' as const,
      label: this.i18n.t('shell.app.changes'),
      tip: this.i18n.t('shell.app.changesReviewTheDiff'),
      disabled: this.shell.changesDisabled(),
      unavailable: this.i18n.t('shell.app.changesReviewTheDiffOpenAChat'),
    },
    {
      id: 'terminal' as const,
      icon: 'terminal' as const,
      label: this.i18n.t('shell.app.terminal'),
      tip: this.i18n.t('shell.app.terminalProjectShell'),
      disabled: this.shell.terminalDisabled(),
      unavailable: this.i18n.t('shell.app.terminalProjectShellOpenAChatOr'),
    },
    {
      id: 'agents' as const,
      icon: 'agents' as const,
      label: this.i18n.t('shell.app.agents'),
      tip: this.i18n.t('shell.app.agentsBackgroundAgentsOfThisChat'),
      disabled: !this.threads.selectedId(),
      unavailable: this.i18n.t('shell.app.openAChatToSeeItsAgents'),
    },
    {
      id: 'artifacts' as const,
      icon: 'browser' as const,
      label: this.i18n.t('shell.app.artifacts'),
      tip: this.i18n.t('shell.app.artifactsBrowserSharedWithTheAgent'),
      disabled: !this.threads.selectedId() || !this.browserAvailable,
      unavailable: this.browserAvailable
        ? this.i18n.t('shell.app.openAChatToUseItsBrowser')
        : this.i18n.t('shell.app.artifactsAvailableInTheDesktopApp'),
    },
  ]);
}
