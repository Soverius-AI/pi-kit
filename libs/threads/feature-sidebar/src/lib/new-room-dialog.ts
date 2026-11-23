import { Component, inject, output, signal } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { form, FormField, required, maxLength } from '@angular/forms/signals';
import { TranslocoPipe } from '@pi-kit/i18n';
import { RoomsStore } from '@pi-kit/rooms/api';
import type { Room, RoomWorkerCandidate } from '@pi-kit/protocol';

@Component({
  selector: 'pk-new-room-dialog',
  imports: [A11yModule, FormField, TranslocoPipe],
  template: `
    <div class="backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-room-title"
        tabindex="-1"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
        (keydown.escape)="close()"
        data-testid="new-room-dialog"
      >
        <header>
          <h2 id="new-room-title">{{ 'rooms.create.title' | transloco }}</h2>
          <button
            type="button"
            [disabled]="busy()"
            [attr.aria-label]="'rooms.create.close' | transloco"
            (click)="close()"
          >
            ×
          </button>
        </header>
        <p>{{ 'rooms.create.hint' | transloco }}</p>
        <form (submit)="create($event)">
          <label
            >{{ 'rooms.create.name' | transloco }}<input [formField]="fields.name" data-testid="new-room-name"
          /></label>
          <label
            >{{ 'rooms.create.purpose' | transloco
            }}<textarea [formField]="fields.summary" rows="4" data-testid="new-room-purpose"></textarea>
          </label>
          @if (hosts().length > 1) {
            <label
              >{{ 'rooms.create.host' | transloco
              }}<select [formField]="fields.hostId">
                @for (host of hosts(); track host.environmentId) {
                  <option [value]="host.environmentId" [disabled]="!host.ready">{{ host.name }}</option>
                }
              </select></label
            >
          }
          @if (error(); as message) {
            <p role="alert">{{ message }}</p>
          }
          <button
            type="submit"
            class="btn btn-primary"
            data-testid="new-room-create"
            [disabled]="busy() || fields().invalid()"
          >
            {{ 'rooms.create.create' | transloco }}
          </button>
        </form>
      </section>
    </div>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 80;
      background: #0006;
      display: grid;
      place-items: center;
      padding: 16px;
    }
    section {
      background: var(--color-base-100);
      border-radius: 12px;
      padding: 20px;
      width: min(480px, 100%);
      max-height: 90dvh;
      overflow: auto;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
    }
    header button {
      width: 44px;
      height: 44px;
    }
    form,
    label {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    form {
      gap: 16px;
      margin-top: 16px;
    }
    input,
    textarea,
    select {
      border: 1px solid var(--color-base-300);
      border-radius: 6px;
      padding: 10px;
      min-width: 0;
      width: 100%;
    }
    p {
      font-size: 13px;
      color: var(--pk-muted);
    }
    button {
      min-height: 44px;
    }
    @media (max-width: 767px) {
      .backdrop {
        padding: 0;
      }
      section {
        width: 100%;
        max-height: 100dvh;
        border-radius: 0;
      }
    }
  `,
})
export class NewRoomDialog {
  private readonly rooms = inject(RoomsStore);
  readonly closed = output<void>();
  readonly created = output<Room>();
  protected readonly model = signal({ name: '', summary: '', hostId: '' });
  protected readonly fields = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 200);
    maxLength(path.summary, 4000);
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly hosts = signal<RoomWorkerCandidate[]>([]);
  constructor() {
    void this.rooms
      .hosts()
      .then((hosts) => {
        this.hosts.set(hosts);
        this.model.update((value) => ({
          ...value,
          hostId: hosts.find((host) => host.local)?.environmentId ?? hosts[0]?.environmentId ?? '',
        }));
      })
      .catch(() => undefined);
  }
  protected close(): void {
    if (!this.busy()) this.closed.emit();
  }
  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || this.fields().invalid()) return;
    const value = this.model();
    this.busy.set(true);
    this.error.set(undefined);
    try {
      const room = await this.rooms.create(
        { title: value.name.trim(), summary: value.summary.trim() },
        this.hosts().find((host) => host.environmentId === value.hostId),
      );
      this.created.emit(room);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
