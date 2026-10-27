import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CredentialStorageSchema,
  type CliInstallResult,
  CliInstallResultSchema,
  type MoveKeysResult,
  MoveKeysResultSchema,
  type RecoveryKey,
  RecoveryKeySchema,
  RedactionConfigSchema,
  type RedactionState,
  RedactionStateSchema,
  type SecretsProtection,
  SecretsProtectionSchema,
  type SecretsStatus,
  SecretsStatusSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../contract';
import { RedactionService } from '../db/redaction.service';
import { PiConfigService } from '../pi/pi-config.service';
import { SecretsService } from '../secrets/secrets.service';

/**
 * Settings › Providers and › Advanced, the secrets half: where keys can be kept, moving the keys `auth.json` holds into the credential store, the one-time recovery key of
 * the database, the disk-encryption check, the `pi-kit-secret` command on PATH, and the redaction configuration. No endpoint returns an API key. The recovery key (the database's) is the one
 * secret that is shown, once, because the person has to be able to write it down.
 */
@ApiTags('secrets')
@Controller()
export class SecretsController {
  constructor(
    private readonly secrets: SecretsService,
    private readonly config: PiConfigService,
    private readonly redaction: RedactionService,
  ) {}

  @Get('secrets')
  @ApiOperation({ summary: 'Get the secret store status', description: 'Returns where keys can be kept (the keychain, or a file), which keys of the auth file could move there and whether the `pi-kit-secret` command is on PATH. Never a key.' })
  @Responds(SecretsStatusSchema)
  status(): SecretsStatus {
    return this.secrets.status();
  }

  @Put('secrets/credential-storage')
  @ApiOperation({ summary: 'Choose credential storage', description: 'Enables credential-store writes and database encryption on the next restart, or opts out of future writes and exports readable user-level credential references to private plaintext configuration files. Existing encrypted databases remain encrypted. Returns account names and failures only, never keys. Does not change OAuth tokens, project configuration or delete credential-store entries. Unreadable references remain until credentials are re-entered.' })
  @Responds(MoveKeysResultSchema)
  async credentialStorage(@Body({ schema: CredentialStorageSchema }) body: z.infer<typeof CredentialStorageSchema>): Promise<MoveKeysResult> {
    return this.secrets.setCredentialStorage(body.enabled);
  }

  @Post('secrets/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry credential access', description: 'Allows credential operations again after an access failure. Does not read or modify a credential itself.' })
  @Responds(SecretsStatusSchema)
  retry(): SecretsStatus {
    return this.secrets.retryAccess();
  }

  /** "Move my existing keys into the keychain". Only on the person's click; one answer lists what moved and what stayed. */
  @Post('secrets/move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move keys into the keychain', description: "Moves the keys pi's auth file holds into the credential store, and answers with what moved and what stayed." })
  @Responds(MoveKeysResultSchema)
  @Fails({ 400: 'The credential store could not be written.' })
  async move(): Promise<MoveKeysResult> {
    try {
      return await this.config.moveKeys();
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post('secrets/cli/install')
  @HttpCode(200)
  @ApiOperation({ summary: 'Install the secret command', description: 'Puts the `pi-kit-secret` command in a folder on PATH, which pi runs to read a key from the credential store.' })
  @Responds(CliInstallResultSchema)
  @Fails({ 400: 'The command could not be installed.' })
  install(): CliInstallResult {
    try {
      return this.secrets.installCli();
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Get('secrets/protection')
  @ApiOperation({ summary: 'Get how the data is protected', description: 'Returns whether the database is encrypted and whether the disk is.' })
  @Responds(SecretsProtectionSchema)
  async protection(): Promise<SecretsProtection> {
    return { database: this.secrets.databaseProtection(), disk: await this.secrets.disk() };
  }

  /** The database key, once. A second call is refused. */
  @Post('secrets/recovery-key')
  @HttpCode(200)
  @ApiOperation({ summary: 'Show the recovery key', description: 'Returns the key that recovers the database, once, so the person can write it down. A second call is refused.' })
  @Responds(RecoveryKeySchema)
  @Fails({ 409: 'The recovery key was shown already, or there is none.' })
  recoveryKey(): RecoveryKey {
    try {
      return this.secrets.recoveryKey();
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
  }

  // ---- redaction (Settings › Advanced)

  @Get('redaction')
  @ApiOperation({ summary: 'Get the redaction settings', description: 'Returns the patterns the redaction pass applies beyond its built-in ones, the folders where it is off and the patterns that could not be used.' })
  @Responds(RedactionStateSchema)
  redactionConfig(): RedactionState {
    return this.redaction.current();
  }

  @Put('redaction')
  @ApiOperation({ summary: 'Save the redaction settings', description: 'Replaces the redaction patterns and the folders where the pass is off, and answers with the settings and the patterns that could not be used.' })
  @Responds(RedactionStateSchema)
  saveRedaction(@Body({ schema: RedactionConfigSchema }) body: z.infer<typeof RedactionConfigSchema>): RedactionState {
    return this.redaction.save(body);
  }
}
