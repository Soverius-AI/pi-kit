import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { PkIcon, PkItem, PkTip } from '@pi-kit/design-system';
import { ProjectPageStore } from '@pi-kit/settings/data';
import { scriptLine } from '@pi-kit/settings/util';

/**
 * The “Setup scripts” group of a project's page (Codex's “local environments”, kept per project): what a new worktree runs in its terminal and which
 * files it copies from the project. A row per script with Edit, Make default and Remove; the first is the default, and a script the project's lockfile suggests is the first
 * entry until the list is saved. Editing opens the form under the row (a new script under the list); the list is saved whole through `PATCH /api/workspaces`.
 */
@Component({
  selector: 'pk-setup-scripts',
  imports: [NgTemplateOutlet, PkItem, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="pk-group"
      [attr.aria-label]="'settings.setupScripts.setupScripts' | transloco"
      data-testid="project-scripts"
    >
      <header>
        <div>
          <h4>{{ 'settings.setupScripts.setupScripts' | transloco }}</h4>
          <p>
            {{ 'settings.setupScripts.runInTheNewFolderSTerminal' | transloco }}
          </p>
        </div>
        <span class="chip store" [pkTip]="'settings.setupScripts.storedInPiKitSOwnDatabase' | transloco">{{
          'settings.setupScripts.piKitDatabase' | transloco
        }}</span>
        <button
          type="button"
          class="btn btn-sm btn-primary btn-square add"
          [pkTip]="'settings.setupScripts.addAScript' | transloco"
          [attr.aria-label]="'settings.setupScripts.addAScript' | transloco"
          data-testid="add-script"
          (click)="page.addScript()"
        >
          <pk-icon name="plus" size="16" />
        </button>
      </header>
      <div role="list">
        @for (script of page.scripts(); track script.id; let first = $first) {
          <div pkItem role="listitem" [attr.data-testid]="'script-' + script.id">
            <pk-icon name="prompt" tile />
            <ng-container nm>
              {{ script.name }}
              @if (first) {
                <span class="chip ok">{{ 'settings.setupScripts.default' | transloco }}</span>
              }
              @if (first && page.worktree()?.setupSuggested) {
                <span
                  class="chip off"
                  data-testid="script-suggested"
                  [pkTip]="'settings.setupScripts.suggestedFromTheProjectSLockfileIt' | transloco"
                  >{{ 'settings.setupScripts.suggested' | transloco }}</span
                >
              }
            </ng-container>
            <ng-container ds>
              @if (line(script).command) {
                <span class="mono">{{ line(script).command }}</span>
              }
              @if (line(script).copies.length > 0) {
                <span
                  >{{ 'settings.setupScripts.copies' | transloco: { value1: line(script).command ? '· ' : '' } }}
                  @for (file of line(script).copies; track file; let last = $last) {
                    <span class="mono">{{ file }}</span
                    >{{ last ? '' : ', ' }}
                  }
                </span>
              }
            </ng-container>
            <ng-container act>
              @if (!first) {
                <button
                  type="button"
                  class="btn btn-sm btn-ghost btn-square"
                  [pkTip]="'settings.setupScripts.makeDefault' | transloco"
                  [attr.aria-label]="
                    ('settings.setupScripts.make' | transloco) +
                    script.name +
                    ('settings.setupScripts.theDefault' | transloco)
                  "
                  [attr.data-testid]="'script-default-' + script.id"
                  (click)="page.makeDefaultScript(script.id)"
                >
                  <pk-icon name="star" />
                </button>
              }
              <button
                type="button"
                class="btn btn-sm btn-ghost btn-square"
                [pkTip]="'settings.setupScripts.edit' | transloco"
                [attr.aria-label]="('settings.setupScripts.edit16f01' | transloco) + script.name"
                [attr.data-testid]="'script-edit-' + script.id"
                (click)="page.editScript(script.id)"
              >
                <pk-icon name="pencil" />
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost btn-square"
                [pkTip]="'settings.setupScripts.remove' | transloco"
                [attr.aria-label]="('settings.setupScripts.remove1680e' | transloco) + script.name"
                [attr.data-testid]="'script-remove-' + script.id"
                (click)="page.removeScript(script.id)"
              >
                <pk-icon name="trash" />
              </button>
            </ng-container>
            @if (page.editing()?.id === script.id) {
              <div extra class="extra"><ng-container *ngTemplateOutlet="editor" /></div>
            }
          </div>
        } @empty {
          @if (page.editing() === undefined) {
            <div class="empty" data-testid="scripts-empty">
              <span
                >{{ 'settings.setupScripts.noSetupScriptsANewWorktreeStarts' | transloco }}
                <span class="mono">{{ 'settings.setupScripts.pnpmInstall' | transloco }}</span>
                {{ 'settings.setupScripts.toRunInIt' | transloco }}</span
              >
              <button type="button" class="btn btn-sm btn-primary" (click)="page.addScript()">
                {{ 'settings.setupScripts.addAScript' | transloco }}
              </button>
            </div>
          }
        }
      </div>
      @if (page.editing(); as draft) {
        @if (draft.id === null) {
          <div class="pk-script-new pk-expand">
            <ng-container *ngTemplateOutlet="editor" />
          </div>
        }
      }
    </section>

    <ng-template #editor>
      @if (page.editing(); as draft) {
        <form
          class="pk-form pk-expand"
          data-testid="script-form"
          (submit)="$event.preventDefault(); page.saveScript()"
          (keydown.escape)="$event.stopPropagation(); page.cancelScript()"
        >
          <label for="script-name">{{ 'settings.setupScripts.name' | transloco }}</label>
          <input
            #name
            id="script-name"
            class="input input-sm"
            type="text"
            [placeholder]="'settings.setupScripts.node' | transloco"
            autocomplete="off"
            data-testid="script-name"
            [value]="draft.name"
            (input)="page.setDraft({ name: $any($event.target).value })"
          />
          <label for="script-command">{{ 'settings.setupScripts.command' | transloco }}</label>
          <input
            id="script-command"
            class="input input-sm mono"
            type="text"
            spellcheck="false"
            autocomplete="off"
            [placeholder]="'settings.setupScripts.pnpmInstallFrozenLockfile' | transloco"
            data-testid="script-command"
            [value]="draft.command"
            (input)="page.setDraft({ command: $any($event.target).value })"
          />
          <div class="hint">{{ 'settings.setupScripts.typedIntoTheNewFolderSTerminal' | transloco }}</div>
          <label for="script-copy">{{ 'settings.setupScripts.filesToCopy' | transloco }}</label>
          <textarea
            id="script-copy"
            class="textarea textarea-sm mono"
            rows="2"
            spellcheck="false"
            [placeholder]="'settings.setupScripts.envLocal' | transloco"
            data-testid="script-copy"
            [value]="draft.copy"
            (input)="page.setDraft({ copy: $any($event.target).value })"
          ></textarea>
          <div class="hint">
            {{ 'settings.setupScripts.onePathPerLineRelativeToThe' | transloco }}
          </div>
          @if (page.editError(); as problem) {
            <div class="hint err" role="alert" data-testid="script-error">{{ problem }}</div>
          }
          <div class="actions">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              data-testid="script-cancel"
              (click)="page.cancelScript()"
            >
              {{ 'settings.setupScripts.cancel' | transloco }}
            </button>
            <button type="submit" class="btn btn-sm btn-primary" data-testid="script-save">
              {{
                draft.id === null
                  ? ('settings.setupScripts.addScript' | transloco)
                  : ('settings.setupScripts.saveScript' | transloco)
              }}
            </button>
          </div>
        </form>
      }
    </ng-template>
  `,
})
export class SetupScripts {
  protected readonly page = inject(ProjectPageStore);
  protected readonly line = scriptLine;
  private readonly name = viewChild<ElementRef<HTMLInputElement>>('name');

  constructor() {
    // The form opens with the focus in its first field.
    effect(() => {
      const field = this.name();
      if (field) queueMicrotask(() => field.nativeElement.focus({ preventScroll: false }));
    });
  }
}
