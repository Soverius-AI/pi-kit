import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ComposioAddRequestSchema,
  type ComposioConnection,
  ComposioConnectionListSchema,
  ComposioConnectionSchema,
  ComposioKeyRequestSchema,
  type ComposioStatus,
  ComposioStatusSchema,
  type ComposioToolkit,
  ComposioToolkitListSchema,
  ComposioToolkitsQuerySchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../contract';
import { ComposioService } from './composio.service';

@ApiTags('connectors')
@Controller('composio')
export class ComposioController {
  constructor(private readonly composio: ComposioService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Get the Composio status',
    description: 'Whether a Composio API key is kept, and where. The key itself is never answered.',
  })
  @Responds(ComposioStatusSchema)
  status(): Promise<ComposioStatus> {
    return this.composio.status();
  }

  @Put('key')
  @ApiOperation({
    summary: 'Keep a Composio API key',
    description:
      'Checks the project API key against Composio and keeps it in the credential store. It is never answered or logged.',
  })
  @Responds(ComposioStatusSchema)
  @Fails({ 409: 'Composio refused the key.', 502: 'Composio did not answer.' })
  setKey(
    @Body({ schema: ComposioKeyRequestSchema }) body: z.infer<typeof ComposioKeyRequestSchema>,
  ): Promise<ComposioStatus> {
    return this.composio.setKey(body.apiKey);
  }

  @Delete('key')
  @ApiOperation({ summary: 'Forget the Composio API key', description: 'Removes the kept key.' })
  @Responds(ComposioStatusSchema)
  @Fails({ 409: 'Composio apps still use the key.' })
  forgetKey(): Promise<ComposioStatus> {
    return this.composio.forgetKey();
  }

  @Get('toolkits')
  @ApiOperation({ summary: 'Search Composio apps', description: 'Lists Composio toolkits, most popular first.' })
  @Responds(ComposioToolkitListSchema)
  @Fails({ 409: 'No Composio API key yet.', 502: 'Composio did not answer.' })
  toolkits(
    @Query({ schema: ComposioToolkitsQuerySchema }) query: z.infer<typeof ComposioToolkitsQuerySchema>,
  ): Promise<ComposioToolkit[]> {
    return this.composio.toolkits(query.search);
  }

  @Get('connections')
  @ApiOperation({
    summary: 'List the Composio apps',
    description: 'The Composio apps pi-kit added to the MCP configuration, and whether each is signed in.',
  })
  @Responds(ComposioConnectionListSchema)
  connections(): Promise<ComposioConnection[]> {
    return this.composio.connections();
  }

  @Post('connections')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add a Composio app',
    description:
      "Creates a Composio session limited to one app (read only unless asked otherwise), adds it to pi's MCP configuration, and answers with the sign-in link the app still needs.",
  })
  @Responds(ComposioConnectionSchema)
  @Fails({ 409: 'No Composio API key yet, or Composio refused it.', 502: 'Composio did not answer.' })
  add(
    @Body({ schema: ComposioAddRequestSchema }) body: z.infer<typeof ComposioAddRequestSchema>,
  ): Promise<ComposioConnection> {
    return this.composio.add(body);
  }

  @Post('connections/:server/link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in to a Composio app',
    description: 'Answers with a new Composio sign-in link for the app, unless it is signed in already.',
  })
  @ApiParam({ name: 'server', description: 'The server name of the Composio app.', schema: { type: 'string' } })
  @Responds(ComposioConnectionSchema)
  @Fails({ 404: 'pi-kit did not add that app.', 502: 'Composio did not answer.' })
  link(@Param('server') server: string): Promise<ComposioConnection> {
    return this.composio.link(server);
  }
}
