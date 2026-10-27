import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LiteLlmConnectSchema, LiteLlmConnectionSchema, type LiteLlmConnect, type LiteLlmConnection } from '@pi-kit/protocol';
import { Fails, Responds } from '../contract';
import { LiteLlmService } from './litellm.service';

/**
 * `setup/litellm`: the saved LiteLLM proxy connection, model discovery against the proxy, and saving it into pi's
 * `models.json`.
 */
@ApiTags('setup')
@Controller('setup/litellm')
export class LiteLlmController {
  constructor(private readonly service: LiteLlmService) {}

  @Get()
  @ApiOperation({ summary: 'Read the LiteLLM connection', description: 'Returns the saved proxy URL and cached model list. Never returns credentials.' })
  @Responds(LiteLlmConnectionSchema)
  status(): LiteLlmConnection { return this.service.status(); }

  @Post('discover')
  @HttpCode(200)
  @ApiOperation({ summary: 'Discover LiteLLM models', description: 'Lists aliases available to this key and optional capabilities reported by the proxy. Does not save or run inference.' })
  @Responds(LiteLlmConnectionSchema)
  @Fails({ 400: 'The proxy could not be reached or refused the key.' })
  async discover(@Body({ schema: LiteLlmConnectSchema }) body: LiteLlmConnect): Promise<LiteLlmConnection> {
    try { return await this.service.discover(body); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : String(error)); }
  }

  @Post('save')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save and refresh LiteLLM', description: 'Discovers models, saves the connection and replaces its model catalog in pi models.json, preserving other providers.' })
  @Responds(LiteLlmConnectionSchema)
  @Fails({ 400: 'Discovery or saving the connection failed.' })
  async save(@Body({ schema: LiteLlmConnectSchema }) body: LiteLlmConnect): Promise<LiteLlmConnection> {
    try { return await this.service.save(body); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : String(error)); }
  }
}
