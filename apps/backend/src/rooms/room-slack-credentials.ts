import { ConflictException, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { MetaRepository } from '../db/meta.repository';
import { SecretsService } from '../secrets/secrets.service';

export const RoomSlackCredentialsSchema = z
  .object({
    appToken: z.string().regex(/^xapp-[A-Za-z0-9-]{10,2000}$/),
    botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,2000}$/),
  })
  .strict();
export type RoomSlackCredentialsInput = z.infer<typeof RoomSlackCredentialsSchema>;

/** One atomic credential record in the OS store; the database contains only a configured flag. */
@Injectable()
export class RoomSlackCredentials implements OnModuleInit {
  private static readonly ACCOUNT = 'rooms.slack';
  private static readonly CONFIGURED = 'rooms.slack.configured';
  configured = false;
  constructor(
    private readonly secrets: SecretsService,
    private readonly meta: MetaRepository,
  ) {}
  async onModuleInit(): Promise<void> {
    this.configured = (await this.meta.getSetting(RoomSlackCredentials.CONFIGURED)) === true;
  }
  async save(input: RoomSlackCredentialsInput): Promise<void> {
    if (
      !(await this.secrets.credentialsEnabled()) ||
      this.secrets.store.kind !== 'keychain' ||
      !this.secrets.store.available()
    )
      throw new ConflictException(
        'Enable the operating system credential store in Settings before saving Slack tokens.',
      );
    const value = JSON.stringify(RoomSlackCredentialsSchema.parse(input));
    try {
      await this.secrets.store.set(RoomSlackCredentials.ACCOUNT, value);
      if ((await this.secrets.store.get(RoomSlackCredentials.ACCOUNT)) !== value)
        throw new Error('verification failed');
    } catch {
      throw new ConflictException('Slack tokens could not be saved in the operating system credential store.');
    }
    await this.meta.setSetting(RoomSlackCredentials.CONFIGURED, true);
    this.configured = true;
  }
  async read(): Promise<RoomSlackCredentialsInput> {
    try {
      if (this.secrets.store.kind !== 'keychain' || !this.secrets.store.available()) throw new Error('unavailable');
      const value = await this.secrets.store.get(RoomSlackCredentials.ACCOUNT);
      return RoomSlackCredentialsSchema.parse(JSON.parse(value ?? 'null'));
    } catch {
      throw new ConflictException(
        'Slack credentials are unavailable. Save the app and bot tokens using the operating system credential store.',
      );
    }
  }
}
