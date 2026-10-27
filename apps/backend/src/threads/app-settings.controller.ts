import { BadRequestException, Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AppSettingsSchema, PutAppSettingSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import { Responds } from '../contract';
import { MetaRepository } from '../db/meta.repository';

const KEY = /^[a-zA-Z][\w.-]{0,63}$/;

/** The app's own key/value settings (view preferences, onboarding state), kept in the database. Not pi's settings: those are `/api/pi-settings`. */
@ApiTags('settings')
@Controller('settings')
export class AppSettingsController {
  constructor(private readonly meta: MetaRepository) {}

  @Get()
  @ApiOperation({ summary: 'Get app settings', description: 'Returns every stored setting of the app as a JSON value per key.' })
  @Responds(AppSettingsSchema)
  settings(): Record<string, unknown> {
    return this.meta.allSettings();
  }

  @Put(':key')
  @HttpCode(204)
  @ApiOperation({ summary: 'Store an app setting', description: 'Stores a JSON value under the key; a missing `value` stores `null`.' })
  @ApiParam({ name: 'key', description: 'Starts with a letter; letters, digits, `.`, `_` and `-`, at most 64 characters.', schema: { type: 'string', pattern: KEY.source } })
  @ApiNoContentResponse({ description: 'The setting is stored.' })
  setSetting(@Param('key') key: string, @Body({ schema: PutAppSettingSchema }) body: z.infer<typeof PutAppSettingSchema>): void {
    if (!KEY.test(key)) throw new BadRequestException('Invalid settings key.');
    this.meta.setSetting(key, body.value ?? null);
  }
}
