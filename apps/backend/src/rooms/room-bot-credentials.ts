import { ConflictException, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { MetaRepository } from '../db/meta.repository';
import { SecretsService } from '../secrets/secrets.service';

/** A single atomic OS credential record; application metadata stores only its presence flag. */
export abstract class RoomBotCredentials<T> implements OnModuleInit {
  configured = false;
  protected constructor(
    private readonly secrets: SecretsService,
    private readonly meta: MetaRepository,
    private readonly channel: 'slack' | 'telegram',
    private readonly label: string,
    private readonly schema: z.ZodType<T>,
    private readonly readHint: string,
  ) {}
  private get account(): string {
    return `rooms.${this.channel}`;
  }
  async onModuleInit(): Promise<void> {
    this.configured = (await this.meta.getSetting(`${this.account}.configured`)) === true;
  }
  async save(input: T): Promise<void> {
    if (
      !(await this.secrets.credentialsEnabled()) ||
      this.secrets.store.kind !== 'keychain' ||
      !this.secrets.store.available()
    )
      throw new ConflictException(
        `Enable the operating system credential store in Settings before saving ${this.label} tokens.`,
      );
    const value = JSON.stringify(this.schema.parse(input));
    try {
      await this.secrets.store.set(this.account, value);
      if ((await this.secrets.store.get(this.account)) !== value) throw new Error('verification failed');
    } catch {
      throw new ConflictException(`${this.label} tokens could not be saved in the operating system credential store.`);
    }
    await this.meta.setSetting(`${this.account}.configured`, true);
    this.configured = true;
  }
  async read(): Promise<T> {
    try {
      if (this.secrets.store.kind !== 'keychain' || !this.secrets.store.available()) throw new Error('unavailable');
      return this.schema.parse(JSON.parse((await this.secrets.store.get(this.account)) ?? 'null'));
    } catch {
      throw new ConflictException(
        `${this.label} credentials are unavailable. Save ${this.readHint} using the operating system credential store.`,
      );
    }
  }
}
