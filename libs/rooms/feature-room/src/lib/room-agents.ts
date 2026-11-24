import { Component, computed, effect, inject, linkedSignal } from '@angular/core';
import { PkAvatar, PkIcon } from '@pi-kit/design-system';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import type { RoomParticipant, RoomWorkerCandidate } from '@pi-kit/protocol';
import { OpenRoomStore, RoomAgentsStore } from '@pi-kit/rooms/data';
import { RoomAgentEditor, type RoomAgentSelection } from './room-agent-editor';

@Component({
  selector: 'pk-room-agents',
  imports: [PkAvatar, PkIcon, TranslocoPipe, RoomAgentEditor],
  providers: [RoomAgentsStore],
  host: { 'data-testid': 'room-agents' },
  template: `
    <section [attr.aria-label]="'rooms.agents.title' | transloco">
      <header>
        <h3>{{ 'rooms.agents.title' | transloco }}</h3>
        <span class="count">{{ (store.status()?.members?.length ?? 0) + 1 }}</span
        ><button
          type="button"
          class="btn btn-ghost btn-xs"
          data-testid="room-agent-add"
          (click)="open({ kind: 'choose' })"
        >
          {{ 'rooms.agents.add' | transloco }}
        </button>
      </header>
      <div class="agent-row" data-testid="room-agent-lead">
        <pk-avatar
          [name]="leadMachine()?.name ?? ('rooms.agents.lead' | transloco)"
          participant="lead"
          [look]="leadMachine()?.look"
          [label]="'rooms.agents.lead' | transloco"
        />
        <div class="min-w-0">
          <strong>{{ 'rooms.agents.lead' | transloco }}</strong
          ><small>{{ 'rooms.agents.leadState.' + room.lead() | transloco }}</small>
        </div>
      </div>
      @for (member of store.status()?.members ?? []; track member.role) {
        <button
          type="button"
          class="agent-row member"
          [attr.data-role]="member.role"
          (click)="open({ kind: 'manage', member })"
        >
          <pk-avatar
            [name]="member.role"
            [participant]="member.agent.agent ? 'consultant' : 'worker'"
            [look]="machineFor(member)?.look"
          /><span class="min-w-0"
            ><strong>{{ member.role }}</strong
            ><small [class.text-warning]="!available(member)">{{ targetName(member) }}</small></span
          ><pk-icon name="chevron-right" size="12" />
        </button>
      }
      @if (store.error(); as error) {
        <p role="alert">{{ error }}</p>
        <button type="button" class="btn btn-ghost btn-xs" [disabled]="store.busy()" (click)="store.refresh()">
          {{ 'rooms.agents.retry' | transloco }}
        </button>
      }
    </section>
    @if (dialog(); as selected) {
      <pk-room-agent-editor [selection]="selected" (closed)="dialog.set(undefined)" />
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      border-bottom: 1px solid var(--color-base-300);
      font-size: 12px;
    }
    section {
      padding: 10px 14px;
      min-width: 0;
    }
    header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
    }
    h3 {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
    }
    header button {
      margin-left: auto;
    }
    .count {
      color: var(--pk-muted);
      font-size: 11px;
      border-radius: 999px;
      background: var(--color-base-200);
      padding: 0 6px;
    }
    .agent-row {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 0;
      min-width: 0;
      width: 100%;
      text-align: start;
    }
    .agent-row > pk-icon {
      flex: none;
      color: var(--pk-muted);
    }
    .agent-row > div,
    .agent-row > span {
      flex: 1;
    }
    strong,
    small {
      display: block;
      overflow-wrap: anywhere;
    }
    strong {
      font-weight: 500;
    }
    small {
      color: var(--pk-muted);
      font-size: 11px;
      line-height: 1.5;
    }
    .member {
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    .member:hover {
      color: var(--color-primary);
    }
    button:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    p {
      margin: 8px 0;
      overflow-wrap: anywhere;
    }
    @media (max-width: 767px) {
      button {
        min-height: 44px;
      }
    }
  `,
})
export class RoomAgents {
  protected readonly store = inject(RoomAgentsStore);
  protected readonly room = inject(OpenRoomStore);
  private readonly language = inject(Language);
  protected readonly leadMachine = computed(() => this.store.targets()?.machines.find((machine) => machine.local));
  protected readonly dialog = linkedSignal<RoomAgentSelection | undefined>(() => {
    this.store.context();
    return undefined;
  });
  constructor() {
    effect((cleanup) => {
      this.store.visible.set(true);
      this.store.targetsVisible.set(true);
      cleanup(() => {
        this.store.visible.set(false);
        this.store.targetsVisible.set(false);
      });
    });
  }
  protected open(selection: RoomAgentSelection): void {
    this.store.error.set(undefined);
    this.dialog.set(selection);
  }
  protected targetName(member: RoomParticipant): string {
    const targets = this.store.targets();
    if (member.agent.agent)
      return (
        targets?.agents.find((agent) => agent.id === member.agent.agent)?.name ??
        this.language.t('rooms.agents.externalRegistered')
      );
    const machine = this.machineFor(member);
    return machine
      ? `${machine.name} · ${this.language.t(machine.ready ? 'rooms.agents.available' : 'rooms.agents.offline')}`
      : this.language.t('rooms.agents.unavailableHost');
  }
  protected machineFor(member: RoomParticipant): RoomWorkerCandidate | undefined {
    if (member.agent.agent) return undefined;
    return this.store
      .targets()
      ?.machines.find((machine) =>
        member.agent.machine
          ? machine.environmentId === member.agent.machine || machine.name === member.agent.machine
          : machine.local,
      );
  }
  protected available(member: RoomParticipant): boolean {
    if (member.agent.agent) return !!this.store.targets()?.agents.some((agent) => agent.id === member.agent.agent);
    return !!this.machineFor(member)?.ready;
  }
}
