import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ConnectRequestSchema,
  type ConnectorCatalog,
  ConnectorCatalogSchema,
  ConnectorExposureRequestSchema,
  type McpActionResult,
  McpActionResultSchema,
  OptionalThreadQuerySchema,
  ThreadQuerySchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../contract';
import { ConnectorsService } from './connectors.service';

const SERVER_NAME = { name: 'name', description: 'The name of the connector\'s server in pi\'s MCP configuration.', schema: { type: 'string' } } as const;

/**
 * The connectors gallery's endpoints. They act on pi's MCP configuration and the thread's session (`?thread=`); `connect` and `disconnect` also work without a
 * thread for what needs no session (writing an entry), and say so when they cannot do the rest.
 */
@ApiTags('connectors')
@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Get the connector catalog', description: "Returns the catalog of known MCP servers: what each does, how it signs in and what access it asks for." })
  @Responds(ConnectorCatalogSchema)
  catalog(): ConnectorCatalog {
    return this.connectors.catalog();
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Connect a connector',
    description:
      "Adds a catalog connector, or a custom server, to pi's MCP configuration. A token or client secret goes to the credential store and is never answered or logged. With `thread` the thread's session connects as well.",
  })
  @Responds(McpActionResultSchema)
  @Fails({ 404: 'The catalog has no such connector, or the thread does not exist.', 409: 'The session could not connect, the folder is not trusted, or "Project only" needs a thread.' })
  connect(@Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>, @Body({ schema: ConnectRequestSchema }) body: z.infer<typeof ConnectRequestSchema>): Promise<McpActionResult> {
    return this.connectors.connect(query.thread || undefined, body);
  }

  @Post(':name/disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disconnect a connector', description: "Removes the connector from pi's MCP configuration and forgets its stored credential, and answers with the servers." })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: 'No MCP server with that name is configured.', 409: 'An OAuth server needs a thread to sign out in, or the session could not reload.' })
  disconnect(@Param('name') name: string, @Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>): Promise<McpActionResult> {
    return this.connectors.disconnect(query.thread || undefined, name);
  }

  @Post(':name/exposure')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change how a connector exposes its tools', description: "Sets whether the server's tools are direct, deferred, hidden or in code mode, and answers with the servers." })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: 'No MCP server with that name is configured.', 409: 'A run holds the thread: stop it first.' })
  exposure(
    @Param('name') name: string,
    @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>,
    @Body({ schema: ConnectorExposureRequestSchema }) body: z.infer<typeof ConnectorExposureRequestSchema>,
  ): Promise<McpActionResult> {
    return this.connectors.setExposure(query.thread, name, body.exposure);
  }
}
