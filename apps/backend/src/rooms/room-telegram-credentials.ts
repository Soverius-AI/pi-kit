import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MetaRepository } from '../db/meta.repository';
import { SecretsService } from '../secrets/secrets.service';
import { RoomBotCredentials } from './room-bot-credentials';

export const RoomTelegramCredentialsSchema = z
  .object({
    botToken: z
      .string()
      .trim()
      .max(256)
      .regex(/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/),
  })
  .strict();
export type RoomTelegramCredentialsInput = z.infer<typeof RoomTelegramCredentialsSchema>;

@Injectable()
export class RoomTelegramCredentials extends RoomBotCredentials<RoomTelegramCredentialsInput> {
  constructor(secrets: SecretsService, meta: MetaRepository) {
    super(secrets, meta, 'telegram', 'Telegram', RoomTelegramCredentialsSchema, 'the bot token');
  }
}
