import { BadRequestException, Injectable, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import type { RoomChannel, RoomChannelStatus } from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { RoomsRepository } from '../db/rooms.repository';
import { MetaRepository } from '../db/meta.repository';
import { RoomPhoneRepository } from '../db/room-phone.repository';
import { RoomAssistantRepository } from '../db/room-assistant.repository';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { TranscribeService } from '../transcribe/transcribe.service';
import { RoomPhoneService } from './room-phone.service';
import { RoomLeadService } from './room-lead.service';
import { RoomAssistant } from './room-assistant.service';
import { RoomWorkspace } from './room-workspace.service';
import { RoomPlaybookService } from './room-playbook.service';
import { RoomWhatsAppTransport } from './room-whatsapp.transport';
import { RoomSignalTransport } from './room-signal.transport';
import { RoomSlackTransport } from './room-slack.transport';
import { RoomTelegramTransport } from './room-telegram.transport';
import type { RoomMessagingTransport } from './room-messaging.transport';

@Injectable()
export class RoomChannelRegistry implements OnModuleInit, OnApplicationShutdown {
  private readonly channels = new Map<
    RoomChannel,
    { service: RoomPhoneService; transport: RoomMessagingTransport; store: RoomPhoneRepository }
  >();
  constructor(
    db: DatabaseService,
    rooms: RoomsRepository,
    lead: RoomLeadService,
    meta: MetaRepository,
    assistant: RoomAssistant,
    policy: RoomAssistantRepository,
    workspace: RoomWorkspace,
    transcribe: TranscribeService,
    actions: RoomPlaybooksRepository,
    playbooks: RoomPlaybookService,
    whatsapp: RoomWhatsAppTransport,
    signal: RoomSignalTransport,
    slack: RoomSlackTransport,
    telegram: RoomTelegramTransport,
  ) {
    for (const [channel, transport] of [
      ['whatsapp', whatsapp],
      ['signal', signal],
      ['slack', slack],
      ['telegram', telegram],
    ] as const) {
      const store = new RoomPhoneRepository(db, channel, () => transport.createMessageId());
      this.channels.set(channel, {
        transport,
        store,
        service: new RoomPhoneService(
          store,
          rooms,
          lead,
          transport,
          meta,
          assistant,
          policy,
          workspace,
          transcribe,
          actions,
          playbooks,
        ),
      });
    }
  }
  private entry(channel: RoomChannel) {
    const item = this.channels.get(channel);
    if (!item) throw new BadRequestException('Unsupported messaging channel.');
    return item;
  }
  get(channel: RoomChannel): RoomPhoneService {
    return this.entry(channel).service;
  }
  async status(channel: RoomChannel, room: string): Promise<RoomChannelStatus> {
    const item = this.entry(channel);
    return {
      ...(await item.service.status(room)),
      channel,
      ...item.transport.details?.(),
      removedFromRoom: await item.store.removedFromRoom(room),
    };
  }
  async onModuleInit(): Promise<void> {
    await Promise.all([...this.channels.values()].map((item) => item.service.onModuleInit()));
  }
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.channels.values()].map((item) => item.service.onApplicationShutdown()));
  }
}
