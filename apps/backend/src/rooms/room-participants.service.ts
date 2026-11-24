import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  RoomParticipantInputSchema,
  type PlaybookParticipant,
  type RoomParticipant,
  type RoomParticipantInput,
  type RoomParticipants as ParticipantList,
  type RoomParticipantTargets,
} from '@pi-kit/protocol';
import { RoomParticipantsRepository, type RoomParticipantState } from '../db/room-participants.repository';
import { RoomsRepository, type FoundRoom } from '../db/rooms.repository';
import { InstanceRepository } from '../db/instance.repository';
import { PeersService } from '../peers/peers.service';
import { RoomPlaybookFiles } from './room-playbook-files.service';
import { RoomAgents } from './room-agents';
import { RoomEnvironments } from './room-environments';
import { RoomA2aAgents } from './room-a2a-agents';
import { RoomLeadService, NO_ROOM } from './room-lead.service';

/** Room membership is independent of a playbook. Overrides never rewrite shared playbook files. */
@Injectable()
export class RoomParticipants {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly rooms: RoomsRepository,
    private readonly store: RoomParticipantsRepository,
    private readonly files: RoomPlaybookFiles,
    private readonly agents: RoomAgents,
    private readonly environments: RoomEnvironments,
    private readonly outside: RoomA2aAgents,
    private readonly peers: PeersService,
    private readonly instance: InstanceRepository,
    private readonly lead: RoomLeadService,
  ) {}

  async list(roomId: string): Promise<ParticipantList> {
    return { members: await this.members(await this.room(roomId)) };
  }
  async members(found: FoundRoom): Promise<RoomParticipant[]> {
    return this.merge(await this.inherited(found), await this.store.read(found.room.id));
  }
  async targets(roomId: string): Promise<RoomParticipantTargets> {
    await this.room(roomId);
    const [machines, agents] = await Promise.all([this.environments.list(), this.outside.list()]);
    return { machines, agents };
  }
  add(roomId: string, input: RoomParticipantInput): Promise<ParticipantList> {
    return this.serial(roomId, () => this.write(roomId, undefined, input));
  }
  update(roomId: string, role: string, input: RoomParticipantInput): Promise<ParticipantList> {
    return this.serial(roomId, () => this.write(roomId, role, input));
  }
  remove(roomId: string, role: string): Promise<ParticipantList> {
    return this.serial(roomId, async () => {
      const found = await this.room(roomId);
      const inherited = await this.inherited(found);
      await this.store.update(roomId, (state) => {
        if (!this.merge(inherited, state).some((member) => member.role === role))
          throw new NotFoundException('No room participant with this role.');
        return {
          members: state.members.filter((member) => member.role !== role),
          excluded: inherited.some((member) => member.role === role)
            ? [...new Set([...state.excluded, role])]
            : state.excluded,
        };
      });
      this.lead.rebriefNext(roomId);
      return this.list(roomId);
    });
  }
  private async write(
    roomId: string,
    previous: string | undefined,
    input: RoomParticipantInput,
  ): Promise<ParticipantList> {
    const found = await this.room(roomId);
    const parsed = RoomParticipantInputSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    const member = await this.target(parsed.data);
    const inherited = await this.inherited(found);
    await this.store.update(roomId, (state) => {
      const current = this.merge(inherited, state);
      if (previous && !current.some((candidate) => candidate.role === previous))
        throw new NotFoundException('No room participant with this role.');
      if (current.some((candidate) => candidate.role === member.role && candidate.role !== previous))
        throw new ConflictException('A participant with this role already belongs to this room.');
      const excluded = new Set(state.excluded);
      if (previous && previous !== member.role && inherited.some((candidate) => candidate.role === previous))
        excluded.add(previous);
      excluded.delete(member.role);
      const next = {
        members: [
          ...state.members.filter((candidate) => candidate.role !== previous && candidate.role !== member.role),
          member,
        ],
        excluded: [...excluded],
      };
      return next;
    });
    this.lead.rebriefNext(roomId);
    return this.list(roomId);
  }
  private async target(member: RoomParticipantInput): Promise<RoomParticipantInput> {
    if (member.agent.agent) {
      if (!(await this.outside.get(member.agent.agent)))
        throw new BadRequestException('Choose a registered external agent on this room’s host.');
    } else if (member.agent.machine) {
      const manager = await this.peers.manager();
      if (member.agent.machine === this.instance.instanceId || member.agent.machine === manager.self.name)
        return { ...member, agent: { local: true } };
      const peer = manager.peers.find(
        (candidate) => candidate.state === 'active' && candidate.peerId === member.agent.machine,
      );
      if (!peer) throw new BadRequestException('Choose a paired computer on this room’s host.');
    }
    return member;
  }
  private async inherited(found: FoundRoom): Promise<PlaybookParticipant[]> {
    if (!found.playbook) return [];
    const playbook = this.files.load(
      this.files.place(await this.agents.projectFolder(found), found.room.id),
      found.playbook,
    );
    return playbook?.config.participants ?? [];
  }
  private merge(inherited: PlaybookParticipant[], state: RoomParticipantState): RoomParticipant[] {
    const members = new Map<string, RoomParticipant>();
    for (const member of inherited)
      if (member.role !== 'lead' && !state.excluded.includes(member.role))
        members.set(member.role, { ...member, source: 'playbook' });
    for (const member of state.members) members.set(member.role, { ...member, source: 'room' });
    return [...members.values()];
  }
  private async room(id: string): Promise<FoundRoom> {
    const found = await this.rooms.get(id);
    if (!found) throw new NotFoundException(NO_ROOM);
    return found;
  }
  private async serial<T>(roomId: string, action: () => Promise<T>): Promise<T> {
    const before = this.pending.get(roomId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(action);
    this.pending.set(roomId, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(roomId) === next) this.pending.delete(roomId);
    }
  }
}
