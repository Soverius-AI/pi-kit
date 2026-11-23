import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { PkNotice } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { PlaybookSummary, Room, RoomClone, RoomStartPreview, RoomWorkerCandidate } from '@pi-kit/protocol';
import { RoomsStore } from '@pi-kit/rooms/api';

@Component({
  selector: 'pk-start-room-dialog',
  imports: [PkNotice, TranslocoPipe],
  template: `
    <dialog
      class="modal modal-open"
      aria-labelledby="start-room-title"
      data-testid="start-room-dialog"
      tabindex="-1"
      (keydown.escape)="closed.emit()"
    >
      <div class="modal-box max-w-[520px] flex flex-col gap-4">
        <div>
          <h3 id="start-room-title" class="font-medium text-lg">
            {{ 'threads.startRoom.title' | transloco }}
          </h3>
          <p class="text-sm text-muted mt-1">{{ 'threads.startRoom.intro' | transloco }}</p>
        </div>

        @if (loadError(); as message) {
          <pk-notice class="mt-0" tone="error" data-testid="start-room-error" [text]="message" />
        }

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{{ 'threads.startRoom.name' | transloco }}</span>
          <input
            class="input input-sm w-full"
            data-testid="start-room-name"
            maxlength="200"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
          />
        </label>

        @if (preview(); as start) {
          <dl class="pk-room-start-facts" data-testid="start-room-facts">
            <dt>{{ 'threads.startRoom.repository' | transloco }}</dt>
            <dd class="font-mono">{{ start.repository }}</dd>
            <dt>{{ 'threads.startRoom.base' | transloco }}</dt>
            <dd class="font-mono">
              {{ start.baseCommit.slice(0, 7) }}
              @if (start.branch) {
                · {{ start.branch }}
              }
            </dd>
            <dt>{{ 'threads.startRoom.host' | transloco }}</dt>
            <dd>
              @if (hosts().length > 1) {
                <select
                  class="select select-xs"
                  data-testid="start-room-host"
                  [attr.aria-label]="'threads.startRoom.host' | transloco"
                  (change)="hostId.set($any($event.target).value)"
                >
                  @for (host of hosts(); track host.environmentId) {
                    <option
                      [value]="host.environmentId"
                      [disabled]="!host.ready"
                      [selected]="host.environmentId === hostId()"
                    >
                      {{ host.local ? ('environments.switch.thisComputer' | transloco) : host.name }}
                      @if (host.reason) {
                        · {{ host.reason }}
                      }
                    </option>
                  }
                </select>
              } @else {
                {{ 'environments.switch.thisComputer' | transloco }}
              }
            </dd>
          </dl>
          @if (start.repository ? elsewhere() : undefined; as chosen) {
            <dl class="pk-room-start-facts" data-testid="start-room-folder">
              <dt>{{ 'threads.startRoom.folder' | transloco }}</dt>
              <dd>
                @if (clones(); as found) {
                  @if (found.length > 1) {
                    <select
                      class="select select-xs font-mono"
                      data-testid="start-room-folder-select"
                      [attr.aria-label]="'threads.startRoom.folder' | transloco"
                      (change)="folder.set($any($event.target).value)"
                    >
                      @for (clone of found; track clone.folder) {
                        <option [value]="clone.folder" [selected]="clone.folder === folder()">
                          {{ clone.folder }}
                          @if (!clone.clean) {
                            · {{ 'threads.startRoom.uncommitted' | transloco }}
                          }
                        </option>
                      }
                    </select>
                  } @else if (found.length === 1) {
                    <span class="font-mono" data-testid="start-room-folder-only">{{ found[0].folder }}</span>
                  } @else {
                    <span class="text-error" data-testid="start-room-no-clone">{{
                      'threads.startRoom.noCloneN'
                        | transloco
                          : { value1: chosen.local ? ('environments.switch.thisComputer' | transloco) : chosen.name }
                    }}</span>
                  }
                } @else {
                  <span class="text-muted">{{ 'threads.startRoom.lookingForClones' | transloco }}</span>
                }
              </dd>
            </dl>
            <p class="text-xs text-muted" data-testid="start-room-host-note">
              {{
                'threads.startRoom.remoteHostN'
                  | transloco: { value1: chosen.local ? ('environments.switch.thisComputer' | transloco) : chosen.name }
              }}
            </p>
          }
          @if (start.uncommittedFiles > 0) {
            <pk-notice
              class="mt-0"
              tone="warning"
              data-testid="start-room-dirty"
              [text]="'threads.startRoom.uncommittedN' | transloco: { value1: start.uncommittedFiles }"
            />
          }
        } @else if (!loadError()) {
          <p class="text-sm text-muted" data-testid="start-room-loading">
            {{ 'threads.startRoom.reading' | transloco }}
          </p>
        }

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{{ 'threads.startRoom.playbook' | transloco }}</span>
          <select
            class="select select-sm w-full"
            data-testid="start-room-playbook"
            (change)="choosePlaybook($any($event.target).value)"
          >
            <option value="" [selected]="!playbook() && !askLead()">
              {{ 'threads.startRoom.noPlaybook' | transloco }}
            </option>
            @if (!playbooks().length) {
              <option [value]="askLeadValue" [selected]="askLead()">
                {{ 'rooms.view.askLeadForPlaybook' | transloco }}
              </option>
            }
            @for (option of playbooks(); track option.path) {
              <option [value]="option.name" [disabled]="!!option.error" [selected]="option.name === playbook()">
                {{ option.name }}
                @if (option.error) {
                  · {{ option.error }}
                }
              </option>
            }
          </select>
          @if (chosenPlaybook(); as chosen) {
            <span class="text-xs text-muted" data-testid="start-room-playbook-about">
              {{ chosen.description }}
              @if (chosen.roles.length || chosen.tools.length || chosen.outputs.length) {
                <br />
                <span class="font-mono">{{
                  'threads.startRoom.playbookFacts'
                    | transloco
                      : { value1: chosen.roles.join(', '), value2: [...chosen.tools, ...chosen.outputs].join(', ') }
                }}</span>
              }
            </span>
          } @else if (!playbooks().length) {
            <span class="text-xs text-muted" data-testid="start-room-playbook-hint">{{
              'rooms.view.playbookHint' | transloco
            }}</span>
          }
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{{ 'threads.startRoom.summary' | transloco }}</span>
          <textarea
            class="textarea textarea-sm w-full min-h-24"
            data-testid="start-room-summary"
            maxlength="4000"
            [placeholder]="'threads.startRoom.summaryPlaceholder' | transloco"
            [value]="summary()"
            (input)="summary.set($any($event.target).value)"
          ></textarea>
        </label>

        <div class="pk-room-start-preview" data-testid="start-room-preview">
          <span class="text-xs text-muted">{{ 'threads.startRoom.whatTheLeadSees' | transloco }}</span>
          @if (summary().trim()) {
            <div class="pk-room-provenance">
              {{ 'threads.startRoom.fromThreadN' | transloco: { value1: threadTitle() } }}
            </div>
            <p class="text-sm whitespace-pre-wrap">{{ summary().trim() }}</p>
          } @else {
            <p class="text-sm text-muted">{{ 'threads.startRoom.nothingShared' | transloco }}</p>
          }
        </div>

        @if (createError(); as message) {
          <pk-notice class="mt-0" tone="error" [text]="message" />
        }

        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" type="button" (click)="closed.emit()">
            {{ 'threads.threadSidebar.cancel' | transloco }}
          </button>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            data-testid="start-room-create"
            [disabled]="!canCreate()"
            (click)="create()"
          >
            {{ 'threads.startRoom.create' | transloco }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" (click)="closed.emit()">{{ 'threads.threadSidebar.close' | transloco }}</button>
      </form>
    </dialog>
  `,
})
export class StartRoomDialog {
  private readonly rooms = inject(RoomsStore);

  readonly threadId = input.required<string>();
  readonly threadTitle = input.required<string>();
  readonly ownerId = input<string | undefined>(undefined);
  readonly closed = output<void>();
  readonly created = output<Room>();

  protected readonly preview = signal<RoomStartPreview | undefined>(undefined);
  protected readonly loadError = signal<string | undefined>(undefined);
  protected readonly createError = signal<string | undefined>(undefined);
  protected readonly name = signal('');
  protected readonly summary = signal('');
  protected readonly creating = signal(false);
  protected readonly hosts = signal<RoomWorkerCandidate[]>([]);
  protected readonly hostId = signal<string | undefined>(undefined);
  protected readonly host = computed(() => this.hosts().find((host) => host.environmentId === this.hostId()));
  protected readonly threadHost = computed(
    () => this.hosts().find((host) => host.environmentId === this.ownerId()) ?? this.hosts().find((host) => host.local),
  );
  protected readonly elsewhere = computed(() => {
    const host = this.host();
    return host && host.environmentId !== this.threadHost()?.environmentId ? host : undefined;
  });
  protected readonly clones = signal<RoomClone[] | undefined>(undefined);
  protected readonly folder = signal<string | undefined>(undefined);
  protected readonly playbooks = signal<PlaybookSummary[]>([]);
  protected readonly playbook = signal<string | undefined>(undefined);
  protected readonly chosenPlaybook = computed(() =>
    this.playbooks().find((option) => option.name === this.playbook()),
  );
  protected readonly canCreate = computed(
    () =>
      !!this.preview() &&
      !!this.name().trim() &&
      !this.creating() &&
      (!this.elsewhere() || !this.preview()?.repository || (this.clones()?.length ?? 0) > 0),
  );

  constructor() {
    effect(() => {
      const threadId = this.threadId();
      const ownerId = this.ownerId();
      untracked(() => void this.load(threadId, ownerId));
    });
    void this.loadHosts();
    effect(() => {
      const host = this.elsewhere();
      const start = this.preview();
      untracked(() => void this.loadClones(host, start));
    });
    effect(() => {
      const host = this.host();
      const away = this.elsewhere();
      const start = this.preview();
      untracked(() => void this.loadPlaybooks(host, away, start));
    });
  }

  protected readonly askLeadValue = 'ask-lead';
  protected readonly askLead = signal(false);
  private readonly translate = inject(Language).t;

  protected choosePlaybook(value: string): void {
    this.askLead.set(value === this.askLeadValue);
    this.playbook.set(value && value !== this.askLeadValue ? value : undefined);
  }

  private async loadPlaybooks(
    host: RoomWorkerCandidate | undefined,
    away: RoomWorkerCandidate | undefined,
    start: RoomStartPreview | undefined,
  ): Promise<void> {
    this.playbooks.set([]);
    this.playbook.set(undefined);
    this.askLead.set(false);
    if (!start) return;
    if (away && !start.repository) return;
    try {
      const found = await this.rooms.playbooks(
        away
          ? { repository: start.repository, baseCommit: start.baseCommit }
          : { repository: start.repository, threadId: this.threadId() },
        host,
      );
      if (this.host() === host) this.playbooks.set(found);
    } catch {
      if (this.host() === host) this.playbooks.set([]);
    }
  }

  private async loadClones(host: RoomWorkerCandidate | undefined, start: RoomStartPreview | undefined): Promise<void> {
    this.clones.set(undefined);
    this.folder.set(undefined);
    if (!host || !start?.repository) return;
    try {
      const clones = await this.rooms.clones(start.repository, start.baseCommit, host);
      if (this.elsewhere() !== host) return;
      this.clones.set(clones);
      this.folder.set(clones[0]?.folder);
    } catch {
      if (this.elsewhere() === host) this.clones.set([]);
    }
  }

  private async loadHosts(): Promise<void> {
    try {
      const hosts = await this.rooms.hosts();
      this.hosts.set(hosts);
      this.hostId.set(this.threadHost()?.environmentId);
    } catch {
      this.hosts.set([]);
    }
  }

  private async load(threadId: string, ownerId: string | undefined): Promise<void> {
    this.preview.set(undefined);
    this.loadError.set(undefined);
    this.name.set(this.threadTitle());
    try {
      const start = await this.rooms.start(threadId, ownerId);
      if (threadId !== this.threadId()) return;
      this.preview.set(start);
      if (!this.name().trim()) this.name.set(start.title);
    } catch (error) {
      if (threadId === this.threadId()) this.loadError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async create(): Promise<void> {
    if (!this.canCreate()) return;
    this.creating.set(true);
    this.createError.set(undefined);
    try {
      const host = this.host();
      const start = this.preview();
      const title = this.name().trim();
      const summary = this.summary().trim();
      const room =
        !this.elsewhere() || !start
          ? await this.rooms.create(
              { threadId: this.threadId(), title, summary, ...(this.playbook() ? { playbook: this.playbook() } : {}) },
              host,
            )
          : await this.rooms.create(
              {
                title,
                summary,
                ...(start.repository ? { repository: start.repository, baseCommit: start.baseCommit } : {}),
                ...(this.folder() ? { projectFolder: this.folder() } : {}),
                ...(this.playbook() ? { playbook: this.playbook() } : {}),
              },
              host,
            );
      // The room exists either way; a refused first message shows in the room, not here.
      if (this.askLead())
        await this.rooms.askLead(room, this.translate('rooms.view.askLeadForPlaybookMessage')).catch(() => undefined);
      this.created.emit(room);
    } catch (error) {
      this.createError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creating.set(false);
    }
  }
}
