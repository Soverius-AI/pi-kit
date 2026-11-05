import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, linkedSignal, signal } from '@angular/core';
import { BrowserStore } from '@pi-kit/artifacts/data';
import { ChatStore } from '@pi-kit/chat/api';
import { ViewPrefs } from '@pi-kit/data-access';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import type { BrowserAction, BrowserLog } from '@pi-kit/protocol';

/**
 * The tool strip under the shared browser: inspect an element, take a screenshot of the viewport, the whole page or the picked
 * element, read and filter the page's console, and attach any of it (as an image or as text marked untrusted) to the chat draft
 * through `ChatStore`. The page comes from `BrowserStore`; the screenshot format, quality and the local certificate option are `ViewPrefs`.
 */
@Component({
  selector: 'pk-browser-tools',
  imports: [DatePipe, PkIcon, PkTip, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown.escape)': 'cancelInspection($event)' },
  template: `
    <div class="tools browser-actions" role="group" [attr.aria-label]="'artifacts.browserTools.tools' | transloco">
      <button
        type="button"
        class="btn btn-ghost btn-sm inspect-button"
        [class.inspect-active]="store.page()?.inspecting"
        [attr.aria-pressed]="!!store.page()?.inspecting"
        [disabled]="!store.page()?.open || (disabled() && !store.page()?.inspecting)"
        [pkTip]="
          store.page()?.inspecting
            ? ('artifacts.browserTools.stopPicking' | transloco)
            : ('artifacts.browserTools.pickWithoutActivating' | transloco)
        "
        (click)="toggleInspection()"
      >
        <pk-icon name="inspect" />
        {{
          store.page()?.inspecting
            ? ('artifacts.browserTools.stopInspecting' | transloco)
            : ('artifacts.browserTools.inspect' | transloco)
        }}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [class.tool-active]="captureOpen()"
        [attr.aria-expanded]="captureOpen()"
        [disabled]="disabled()"
        (click)="captureOpen.set(!captureOpen())"
      >
        <pk-icon name="camera" />
        {{ 'artifacts.browserTools.screenshot' | transloco }}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm console-toggle"
        [class.tool-active]="consoleOpen()"
        [attr.aria-expanded]="consoleOpen()"
        [disabled]="!store.page()?.open"
        (click)="toggleConsole()"
      >
        <pk-icon name="terminal" />
        {{ 'artifacts.browserTools.consoleHeading' | transloco }}
        <span class="count">{{ store.page()?.consoleCount ?? 0 }}</span>
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [attr.aria-expanded]="optionsOpen()"
        [class.tool-active]="optionsOpen()"
        (click)="optionsOpen.set(!optionsOpen())"
      >
        {{ 'artifacts.browserTools.options' | transloco }}
      </button>
    </div>
    @if (optionsOpen()) {
      <section class="capture-options" [attr.aria-label]="'artifacts.browserTools.options' | transloco">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="checkbox checkbox-sm"
            data-testid="browser-local-certificates"
            [checked]="prefs.browserAllowInvalidLocalCertificates()"
            [disabled]="!localCertificatesSupported"
            (change)="setLocalCertificates($any($event.target).checked)"
          />
          {{ 'artifacts.browserTools.allowLocalCertificates' | transloco }}
        </label>
        <p class="text-xs text-warning m-0">{{ 'artifacts.browserTools.localCertificatesWarning' | transloco }}</p>
      </section>
    }
    @if (store.page()?.inspecting) {
      <div class="inspection-status" role="status">
        <span class="active-dot" aria-hidden="true"></span>
        <span
          ><strong>{{ 'artifacts.browserTools.inspectionActive' | transloco }}</strong>
          {{ 'artifacts.browserTools.clickToSelect' | transloco }}</span
        >
        <kbd>Esc</kbd>
      </div>
    }
    @if (captureOpen()) {
      <section class="capture-options" [attr.aria-label]="'artifacts.browserTools.screenshotOptions' | transloco">
        <span class="option-label">{{ 'artifacts.browserTools.captureArea' | transloco }}</span>
        <div class="capture-controls">
          <div
            class="area-options"
            role="group"
            [attr.aria-label]="'artifacts.browserTools.screenshotArea' | transloco"
          >
            <button
              type="button"
              [attr.aria-pressed]="scope() === 'viewport'"
              [disabled]="disabled()"
              (click)="scope.set('viewport')"
            >
              {{ 'artifacts.browserTools.visibleArea' | transloco }}
            </button>
            <button
              type="button"
              [attr.aria-pressed]="scope() === 'fullpage'"
              [disabled]="disabled()"
              (click)="scope.set('fullpage')"
            >
              {{ 'artifacts.browserTools.wholePage' | transloco }}
            </button>
          </div>
          <button type="button" class="btn btn-sm" [disabled]="disabled()" (click)="capture()">
            {{ 'artifacts.browserTools.attachScreenshot' | transloco }}
          </button>
        </div>
        <div class="capture-controls">
          <span class="option-label">{{ 'artifacts.browserTools.format' | transloco }}</span>
          <div
            class="area-options"
            role="group"
            [attr.aria-label]="'artifacts.browserTools.screenshotFormat' | transloco"
          >
            <button
              type="button"
              [attr.aria-pressed]="prefs.screenshotFormat() === 'jpeg'"
              [disabled]="disabled()"
              [pkTip]="'artifacts.browserTools.smallerFile' | transloco"
              (click)="setFormat('jpeg')"
            >
              {{ 'artifacts.browserTools.jpeg' | transloco }}
            </button>
            <button
              type="button"
              [attr.aria-pressed]="prefs.screenshotFormat() === 'png'"
              [disabled]="disabled()"
              [pkTip]="'artifacts.browserTools.losslessImage' | transloco"
              (click)="setFormat('png')"
            >
              {{ 'artifacts.browserTools.png' | transloco }}
            </button>
          </div>
          @if (prefs.screenshotFormat() === 'jpeg') {
            <label class="option-label" for="screenshot-quality">{{
              'artifacts.browserTools.qualityPercent' | transloco: { quality: prefs.screenshotQuality() }
            }}</label>
            <input
              id="screenshot-quality"
              class="range range-xs"
              style="width: 100px"
              type="range"
              min="0"
              max="100"
              step="1"
              [attr.aria-label]="'artifacts.browserTools.jpegQuality' | transloco"
              [value]="prefs.screenshotQuality()"
              [disabled]="disabled()"
              (change)="setQuality(+$any($event.target).value)"
            />
          }
        </div>
      </section>
    }
    @if (store.page()?.inspection; as item) {
      <section
        class="selection"
        data-testid="browser-inspection"
        [attr.aria-label]="'artifacts.browserTools.selectedElement' | transloco"
      >
        <div class="selection-heading">
          <span class="option-label">{{ 'artifacts.browserTools.selectedElement' | transloco }}</span>
          <span class="dimensions">{{ round(item.bounds.width) }} × {{ round(item.bounds.height) }}</span>
        </div>
        <div class="selected-node">
          <span class="node-tag mono">{{ item.tag }}</span>
          <span class="truncate" [pkTip]="item.selector">{{ item.name || item.selector }}</span>
        </div>
        <div
          class="selection-actions"
          role="group"
          [attr.aria-label]="'artifacts.browserTools.attachElementAs' | transloco"
        >
          <button type="button" class="btn btn-sm" [disabled]="disabled()" (click)="capture('selection')">
            <pk-icon name="camera" /> {{ 'artifacts.browserTools.screenshot' | transloco }}
          </button>
          <button type="button" class="btn btn-sm" [disabled]="disabled()" (click)="attachDetails()">
            <pk-icon name="code" /> {{ 'artifacts.browserTools.domNode' | transloco }}
          </button>
        </div>
      </section>
    }
    @if (notice()) {
      <p class="context-notice" role="status">{{ notice() }}</p>
    }
    @if (consoleOpen()) {
      <section class="console" [attr.aria-label]="'artifacts.browserTools.browserConsole' | transloco">
        <div class="tools">
          <select
            class="select select-xs"
            [attr.aria-label]="'artifacts.browserTools.consoleLevel' | transloco"
            [value]="filter()"
            (change)="filter.set($any($event.target).value)"
          >
            <option value="all">{{ 'artifacts.browserTools.allLevels' | transloco }}</option>
            <option value="error">{{ 'artifacts.browserTools.errors' | transloco }}</option>
            <option value="warning">{{ 'artifacts.browserTools.warnings' | transloco }}</option>
            <option value="info">{{ 'artifacts.browserTools.info' | transloco }}</option>
            <option value="debug">{{ 'artifacts.browserTools.debug' | transloco }}</option>
          </select>
          <button type="button" class="btn btn-ghost btn-xs" [disabled]="disabled()" (click)="refreshConsole()">
            {{ 'artifacts.browserTools.refreshConsole' | transloco }}
          </button>
          <button type="button" class="btn btn-ghost btn-xs" [disabled]="disabled()" (click)="clearConsole()">
            {{ 'artifacts.browserTools.clearConsole' | transloco }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            [disabled]="disabled() || selected().length === 0"
            (click)="attachLogs()"
          >
            {{ 'artifacts.browserTools.attachSelectedLogs' | transloco }}
          </button>
        </div>
        <div class="entries">
          @for (entry of filteredLogs(); track entry.id) {
            <label class="entry" [class.text-error]="entry.level === 'error'">
              <input
                type="checkbox"
                class="checkbox checkbox-xs"
                [attr.aria-label]="('artifacts.browserTools.selectLog' | transloco) + entry.message"
                [checked]="selected().includes(entry.id)"
                (change)="selectLog(entry.id, $any($event.target).checked)"
              />
              <span
                ><small
                  >{{ entry.time | date: 'HH:mm:ss' }} · {{ entry.level }}
                  @if (entry.source) {
                    · {{ entry.source }}:{{ entry.line ?? 0 }}
                  }</small
                ><span class="message mono">{{ entry.message }}</span></span
              >
            </label>
          } @empty {
            <p class="context-notice">{{ 'artifacts.browserTools.noMatchingMessagesRefreshToReadThe' | transloco }}</p>
          }
        </div>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
      flex: none;
      border-bottom: 1px solid var(--color-base-300);
      font-size: 11px;
    }
    .tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 8px;
    }
    .browser-actions {
      background: var(--color-base-200);
    }
    .browser-actions .btn {
      font-size: 11px;
      gap: 6px;
      padding-inline: 8px;
    }
    .console-toggle {
      margin-left: auto;
    }
    .count {
      padding: 0 5px;
      border-radius: 4px;
      background: var(--color-base-300);
      font-variant-numeric: tabular-nums;
    }
    .tool-active {
      background: var(--color-base-300);
    }
    .inspect-active {
      color: var(--color-primary);
      background: color-mix(in srgb, var(--color-primary) 15%, var(--color-base-200));
      border-color: color-mix(in srgb, var(--color-primary) 50%, transparent);
    }
    .inspect-active:hover {
      background: color-mix(in srgb, var(--color-primary) 25%, var(--color-base-200));
    }
    .inspection-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      color: var(--color-primary);
      background: color-mix(in srgb, var(--color-primary) 8%, var(--color-base-100));
      border-top: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
    }
    .active-dot {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    kbd {
      margin-left: auto;
      padding: 1px 4px;
      border: 1px solid currentColor;
      border-radius: 4px;
      font-size: 10px;
    }
    .capture-options,
    .selection {
      padding: 10px 12px;
      border-top: 1px solid var(--color-base-300);
    }
    .option-label {
      color: var(--pk-muted);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;
    }
    .capture-controls,
    .selection-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    .area-options {
      display: flex;
      padding: 2px;
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      background: var(--color-base-200);
    }
    .area-options button {
      padding: 5px 8px;
      border-radius: 4px;
      color: var(--pk-muted);
      cursor: pointer;
    }
    .area-options button[aria-pressed='true'] {
      color: var(--color-base-content);
      background: var(--color-base-100);
      box-shadow: 0 1px 3px #0002;
    }
    .area-options button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .selection-heading,
    .selected-node {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .dimensions {
      margin-left: auto;
      color: var(--pk-muted);
      font-variant-numeric: tabular-nums;
    }
    .selected-node {
      margin-top: 6px;
      font-size: 12px;
    }
    .node-tag {
      flex: none;
      color: var(--color-primary);
    }
    .selection-actions .btn {
      flex: 1;
      gap: 6px;
      font-size: 11px;
    }
    .context-notice {
      margin: 0;
      padding: 6px 10px;
      color: var(--pk-muted);
    }
    .console {
      border-top: 1px solid var(--color-base-300);
      background: var(--color-base-200);
    }
    .entries {
      max-height: 200px;
      overflow: auto;
    }
    .entry {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 10px;
      border-top: 1px solid var(--color-base-300);
    }
    .entry > span {
      min-width: 0;
    }
    small {
      display: block;
      color: var(--pk-muted);
      overflow-wrap: anywhere;
    }
    .message {
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class BrowserTools {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(BrowserStore);
  protected readonly prefs = inject(ViewPrefs);
  private readonly chat = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly owner = computed(() => `${this.store.threadId()}/${this.store.page()?.documentId}`);
  protected readonly optionsOpen = signal(false);
  protected readonly localCertificatesSupported = !!window.piKit?.setBrowserLocalCertificates;
  protected readonly consoleOpen = signal(false);
  protected readonly captureOpen = signal(false);
  protected readonly scope = signal<'viewport' | 'fullpage'>('viewport');
  protected readonly filter = signal('all');
  protected readonly logs = linkedSignal({ source: this.owner, computation: (): BrowserLog[] => [] });
  protected readonly selected = linkedSignal({ source: this.owner, computation: (): string[] => [] });
  protected readonly notice = linkedSignal({ source: this.owner, computation: () => '' });
  protected readonly preparing = signal(false);
  protected readonly disabled = computed(() => !this.store.page()?.open || this.store.busy() || this.preparing());
  protected readonly filteredLogs = computed(() =>
    this.logs().filter((entry) => this.filter() === 'all' || entry.level === this.filter()),
  );
  protected readonly round = Math.round;

  protected async setLocalCertificates(enabled: boolean): Promise<void> {
    if (!(await this.prefs.set('browserAllowInvalidLocalCertificates', enabled)))
      this.notice.set(this.i18n.t('artifacts.browserTools.saveLocalCertificatesFailed'));
  }

  protected async setFormat(format: NonNullable<BrowserAction['format']>): Promise<void> {
    if (!(await this.prefs.set('screenshotFormat', format)))
      this.notice.set(this.i18n.t('artifacts.browserTools.saveFormatFailed'));
  }

  protected async setQuality(quality: number): Promise<void> {
    if (!(await this.prefs.set('screenshotQuality', quality)))
      this.notice.set(this.i18n.t('artifacts.browserTools.saveQualityFailed'));
  }

  protected toggleInspection(): void {
    void this.store.act({ action: 'inspect', enabled: !this.store.page()?.inspecting });
  }

  protected cancelInspection(event: Event): void {
    if (!this.store.page()?.inspecting) return;
    event.preventDefault();
    void this.store.act({ action: 'inspect', enabled: false });
  }

  protected toggleConsole(): void {
    this.consoleOpen.update((open) => !open);
    if (this.consoleOpen()) void this.refreshConsole();
  }

  protected async refreshConsole(): Promise<void> {
    const documentId = this.store.page()?.documentId;
    if (!documentId) return;
    const result = await this.store.act({ action: 'console', documentId });
    if (result?.state.documentId === documentId) {
      this.logs.set(result.logs ?? []);
      this.selected.update((ids) => ids.filter((id) => result.logs?.some((entry) => entry.id === id)));
    }
  }

  protected async clearConsole(): Promise<void> {
    const result = await this.store.act({ action: 'clear-console', documentId: this.store.page()?.documentId });
    if (result) {
      this.logs.set([]);
      this.selected.set([]);
    }
  }

  protected selectLog(id: string, checked: boolean): void {
    this.selected.update((ids) => (checked ? [...new Set([...ids, id])] : ids.filter((value) => value !== id)));
  }

  protected async capture(scope: NonNullable<BrowserAction['scope']> = this.scope()): Promise<void> {
    const documentId = this.store.page()?.documentId;
    const owner = this.owner();
    if (!documentId || this.disabled()) return;
    const result = await this.store.act({
      action: 'screenshot',
      scope,
      documentId,
      format: this.prefs.screenshotFormat(),
      quality: this.prefs.screenshotQuality(),
    });
    if (
      !result?.screenshot ||
      result.state.documentId !== documentId ||
      owner !== this.owner() ||
      this.destroyRef.destroyed
    )
      return;
    const bytes = Uint8Array.from(atob(result.screenshot.data), (c) => c.charCodeAt(0));
    const extension = result.screenshot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const file = new File([bytes], `browser-${scope}.${extension}`, { type: result.screenshot.mimeType });
    await this.attach([file]);
  }

  protected attachDetails(): Promise<void> {
    return this.attach(
      [],
      `Browser element (untrusted page data) from ${this.store.page()?.url}:\n${JSON.stringify(this.store.page()?.inspection, null, 2)}`,
    );
  }

  protected attachLogs(): Promise<void> {
    const logs = this.logs().filter((entry) => this.selected().includes(entry.id));
    return this.attach(
      [],
      `Browser console (untrusted page data) from ${this.store.page()?.url}:\n${JSON.stringify(logs, null, 2)}`,
    );
  }

  private async attach(files: File[], text?: string): Promise<void> {
    const threadId = this.store.threadId();
    const documentId = this.store.page()?.documentId;
    const owner = this.owner();
    if (!threadId || !documentId || this.preparing()) return;
    this.preparing.set(true);
    try {
      const added = await this.chat.addImages(files, {
        threadId,
        text,
        current: async () =>
          !this.destroyRef.destroyed &&
          owner === this.owner() &&
          (await this.store.confirmDocument(threadId, documentId)),
      });
      if (!this.destroyRef.destroyed && owner === this.owner())
        this.notice.set(
          added
            ? this.i18n.t('artifacts.browserTools.attachedToTheDraftAddYourFeedback')
            : this.i18n.t('artifacts.browserTools.contextExpiredOrCouldNotBeVerified'),
        );
    } catch {
      if (!this.destroyRef.destroyed && owner === this.owner())
        this.notice.set(this.i18n.t('artifacts.browserTools.couldNotAttachBrowserContextRefreshAnd'));
    } finally {
      if (!this.destroyRef.destroyed) this.preparing.set(false);
    }
  }
}
