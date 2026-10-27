import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { flagOn, type ProviderUsage, ProviderUsageQuerySchema, ProviderUsageSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import { Responds } from '../contract';
import { UsageService } from './usage.service';

/** A provider's usage over REST: `GET /api/providers/:id/usage` asks `UsageService` for the subscription window or the credit left. */
@Controller()
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @ApiTags('pi-settings')
  @Get('providers/:id/usage')
  @ApiParam({ name: 'id', description: "The provider's id, as `GET /api/pi-settings` lists it.", schema: { type: 'string' } })
  @ApiOperation({
    summary: "Get a provider's usage",
    description:
      'Returns how much of a subscription window is used or how much credit is left, where the provider offers it (Anthropic subscriptions, OpenRouter, Radius), and `null` where it does not. Cached for one minute unless refresh is enabled; concurrent reads share one request. The credential is never part of the answer.',
  })
  @Responds(ProviderUsageSchema.nullable())
  async get(@Param('id') id: string, @Query({ schema: ProviderUsageQuerySchema }) query: z.infer<typeof ProviderUsageQuerySchema>): Promise<ProviderUsage | null> {
    return this.usage.usage(id, flagOn(query.refresh));
  }
}
