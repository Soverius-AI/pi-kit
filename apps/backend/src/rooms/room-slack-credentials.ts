import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MetaRepository } from '../db/meta.repository';
import { SecretsService } from '../secrets/secrets.service';
import { RoomBotCredentials } from './room-bot-credentials';

export const RoomSlackCredentialsSchema = z
  .object({
    appToken: z.string().regex(/^xapp-[A-Za-z0-9-]{10,2000}$/),
    botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,2000}$/),
  })
  .strict();
export type RoomSlackCredentialsInput = z.infer<typeof RoomSlackCredentialsSchema>;

@Injectable()
export class RoomSlackCredentials extends RoomBotCredentials<RoomSlackCredentialsInput> {
  constructor(secrets: SecretsService, meta: MetaRepository) {
    super(secrets, meta, 'slack', 'Slack', RoomSlackCredentialsSchema, 'the app and bot tokens');
  }
}
